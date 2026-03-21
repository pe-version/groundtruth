import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  DocumentStatus,
  type Document,
  type KafkaDocumentEvent,
  type MongoDB,
  type VectorStore,
  type ApiConfig,
} from "@direze/shared";
import type { KafkaProducer } from "../services/kafka-producer.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function documentRoutes(fastify: FastifyInstance) {
  const db: MongoDB = (fastify as any).db;
  const kafkaProducer: KafkaProducer = (fastify as any).kafkaProducer;
  const config: ApiConfig = (fastify as any).config;

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

      const docId = randomUUID();
      const uploadDir = config.UPLOAD_DIR;
      await mkdir(uploadDir, { recursive: true });

      const filePath = path.join(uploadDir, `${docId}.pdf`);
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
        filename: data.filename,
        status: DocumentStatus.Pending,
        chunkCount: 0,
        uploadedAt: new Date(),
        updatedAt: new Date(),
      };

      await db.insertDocument(doc);

      const event: KafkaDocumentEvent = {
        documentId: docId,
        filename: data.filename,
        filePath,
      };

      try {
        await kafkaProducer.publishDocumentEvent(event);
      } catch (err) {
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

  fastify.get("/documents", async () => {
    const docs = await db.listDocuments();
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
      if (!doc) {
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

      const vectorStore: VectorStore = (fastify as any).vectorStore;
      await vectorStore.deleteChunks(id);
      await db.deleteDocument(id);

      // Best-effort file cleanup
      try {
        await unlink(path.join(config.UPLOAD_DIR, `${id}.pdf`));
      } catch {
        // File may already be gone
      }

      return reply.code(204).send();
    }
  );
}
