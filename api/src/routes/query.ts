import type { FastifyInstance } from "fastify";
import { embedText, type VectorStore } from "@direze/shared";
import { streamClaude } from "../services/anthropic.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface QueryBody {
  documentId?: string;
  question: string;
  topK?: number;
}

export async function queryRoutes(fastify: FastifyInstance) {
  const vectorStore: VectorStore = (fastify as any).vectorStore;

  // Non-streaming query (original endpoint)
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
            documentId: { type: "string", pattern: UUID_REGEX.source },
            question: { type: "string", minLength: 1, maxLength: 2000 },
            topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
    },
    async (request) => {
      const { documentId, question, topK = 5 } = request.body;

      const questionEmbedding = await embedText(question);

      const chunks = await vectorStore.similarChunks(
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
            documentId: { type: "string", pattern: UUID_REGEX.source },
            question: { type: "string", minLength: 1, maxLength: 2000 },
            topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
        },
      },
    },
    async (request, reply) => {
      const { documentId, question, topK = 5 } = request.body;

      const questionEmbedding = await embedText(question);

      const chunks = await vectorStore.similarChunks(
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

      // Stream LLM tokens
      for await (const token of streamClaude(contextString, question)) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: "delta", text: token })}\n\n`
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
