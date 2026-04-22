import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  DocumentStatus,
  type Document,
  type KafkaDocumentEvent,
  UUID_REGEX,
  getUploadPath,
} from "@groundtruth/shared";

export async function documentRoutes(fastify: FastifyInstance) {
  const { db, kafkaProducer, config } = fastify;

  // Rate limit upload more aggressively
  fastify.post(
    "/documents/upload",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "Missing file" });
      }

      if (
        !data.filename.toLowerCase().endsWith(".pdf") ||
        data.mimetype !== "application/pdf"
      ) {
        return reply.code(400).send({ error: "Only PDF files are supported" });
      }

      const userId = request.user.sub;
      const docId = randomUUID();
      const uploadDir = config.UPLOAD_DIR;
      await mkdir(uploadDir, { recursive: true });

      const filePath = getUploadPath(uploadDir, docId);
      const buffer = await data.toBuffer();

      // Validate PDF magic bytes
      if (
        buffer.length < 4 ||
        buffer.subarray(0, 4).toString("ascii") !== "%PDF"
      ) {
        return reply.code(400).send({ error: "File is not a valid PDF" });
      }

      await writeFile(filePath, buffer);

      const doc: Document = {
        _id: docId,
        userId,
        filename: data.filename,
        status: DocumentStatus.Pending,
        chunkCount: 0,
        uploadedAt: new Date(),
        updatedAt: new Date(),
      };

      await db.insertDocument(doc);

      const event: KafkaDocumentEvent = {
        documentId: docId,
        userId,
        filename: data.filename,
      };

      try {
        await kafkaProducer.publishDocumentEvent(event, {
          requestId: request.id as string,
        });
      } catch (err) {
        request.log.error({ err, documentId: docId }, "Kafka publish failed");
        await db.markFailed(
          docId,
          "Failed to queue for processing: " + (err as Error).message
        );
        return reply
          .code(500)
          .send({ error: "Document saved but could not queue for processing" });
      }

      return reply.code(202).send({
        id: doc._id,
        filename: doc.filename,
        status: doc.status,
        chunkCount: doc.chunkCount,
        uploadedAt: doc.uploadedAt,
        updatedAt: doc.updatedAt,
      });
    }
  );

  fastify.get("/documents", async (request) => {
    const userId = request.user.sub;
    const docs = await db.listDocuments(userId);
    return docs.map((d) => ({
      id: d._id,
      filename: d.filename,
      status: d.status,
      chunkCount: d.chunkCount,
      uploadedAt: d.uploadedAt,
      updatedAt: d.updatedAt,
      errorMsg: d.errorMsg,
    }));
  });

  fastify.get<{ Params: { id: string } }>(
    "/documents/:id",
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: "Invalid document ID format" });
      }

      const doc = await db.getDocument(id);
      if (!doc || doc.userId !== request.user.sub) {
        return reply.code(404).send({ error: "Document not found" });
      }

      return {
        id: doc._id,
        filename: doc.filename,
        status: doc.status,
        chunkCount: doc.chunkCount,
        uploadedAt: doc.uploadedAt,
        updatedAt: doc.updatedAt,
        errorMsg: doc.errorMsg,
      };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/documents/:id",
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: "Invalid document ID format" });
      }

      // Authorization: ensure document belongs to user
      const doc = await db.getDocument(id);
      if (!doc || doc.userId !== request.user.sub) {
        return reply.code(404).send({ error: "Document not found" });
      }

      const { vectorStore } = fastify;
      await vectorStore.deleteChunks(request.user.sub, id);
      await db.deleteDocument(id);

      // Best-effort file cleanup
      try {
        await unlink(getUploadPath(config.UPLOAD_DIR, id));
      } catch {
        // File may already be gone
      }

      return reply.code(204).send();
    }
  );
}
