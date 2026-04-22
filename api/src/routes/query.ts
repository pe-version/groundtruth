import type { FastifyInstance } from "fastify";
import { embedText, UUID_REGEX, UUID_PATTERN } from "@groundtruth/shared";
import { streamClaude } from "../services/anthropic.js";

interface QueryBody {
  documentId?: string;
  question: string;
  topK?: number;
}

export async function queryRoutes(fastify: FastifyInstance) {
  const { vectorStore, db } = fastify;

  // Non-streaming query
  fastify.post<{ Body: QueryBody }>(
    "/query",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: {
            documentId: { type: "string", pattern: UUID_PATTERN },
            question: { type: "string", minLength: 1, maxLength: 2000 },
            topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
    },
    async (request, reply) => {
      const { documentId, question, topK = 5 } = request.body;
      const userId = request.user.sub;

      // Authorization: if documentId provided, verify ownership
      if (documentId) {
        const doc = await db.getDocument(documentId);
        if (!doc || doc.userId !== userId) {
          return reply.code(404).send({ error: "Document not found" });
        }
      }

      const questionEmbedding = await embedText(question);

      const chunks = await vectorStore.similarChunks(
        userId,
        documentId ?? null,
        questionEmbedding,
        topK
      );

      if (chunks.length === 0) {
        return {
          answer: documentId
            ? "No relevant content found for this question in the selected document."
            : "No relevant content found for this question across any documents.",
          sources: [],
        };
      }

      const { contextString, sources } = buildContext(chunks);
      const answer = await collectStream(streamClaude(contextString, question));

      return { answer, sources };
    }
  );

  // Streaming query via SSE
  fastify.post<{ Body: QueryBody }>(
    "/query/stream",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: {
            documentId: { type: "string", pattern: UUID_PATTERN },
            question: { type: "string", minLength: 1, maxLength: 2000 },
            topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
    },
    async (request, reply) => {
      const { documentId, question, topK = 5 } = request.body;
      const userId = request.user.sub;

      // Authorization: if documentId provided, verify ownership
      if (documentId) {
        const doc = await db.getDocument(documentId);
        if (!doc || doc.userId !== userId) {
          return reply.code(404).send({ error: "Document not found" });
        }
      }

      const questionEmbedding = await embedText(question);

      const chunks = await vectorStore.similarChunks(
        userId,
        documentId ?? null,
        questionEmbedding,
        topK
      );

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (chunks.length === 0) {
        const noContent = documentId
          ? "No relevant content found for this question in the selected document."
          : "No relevant content found for this question across any documents.";
        reply.raw.write(
          `data: ${JSON.stringify({ type: "sources", sources: [] })}\n\n`
        );
        reply.raw.write(
          `data: ${JSON.stringify({ type: "delta", text: noContent })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        reply.raw.end();
        return reply;
      }

      const { contextString, sources } = buildContext(chunks);

      // Send sources first
      reply.raw.write(
        `data: ${JSON.stringify({ type: "sources", sources })}\n\n`
      );

      // Stream LLM tokens with error handling. Upstream errors often carry
      // provider-specific details (URLs, account ids, internal 5xx text) —
      // log server-side, send a generic message to the client.
      try {
        for await (const token of streamClaude(contextString, question)) {
          reply.raw.write(
            `data: ${JSON.stringify({ type: "delta", text: token })}\n\n`
          );
        }
      } catch (err) {
        request.log.error({ err }, "LLM stream failed");
        reply.raw.write(
          `data: ${JSON.stringify({ type: "error", message: "The answer stream was interrupted. Please try again." })}\n\n`
        );
      }

      reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      reply.raw.end();
      return reply;
    }
  );
}

function buildContext(chunks: { content: string; documentId: string }[]) {
  const contextParts: string[] = [];
  const sources: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    contextParts.push(`[Excerpt ${i + 1}]\n${chunks[i].content}`);
    const preview =
      chunks[i].content.length > 200
        ? chunks[i].content.slice(0, 200) + "..."
        : chunks[i].content;
    sources.push(preview);
  }

  return { contextString: contextParts.join("\n\n"), sources };
}

async function collectStream(stream: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const token of stream) {
    parts.push(token);
  }
  return parts.join("");
}
