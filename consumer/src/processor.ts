import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { encodingForModel } from "js-tiktoken";
import {
  type MetadataStore,
  type VectorStore,
  embedText,
  getUploadPath,
} from "@groundtruth/shared";
import { extractTextFromPDF } from "./pdf-extract.js";

const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 64;
const EMBED_CONCURRENCY = 5;

// Per-stage deadlines. A stage that overruns throws an AbortError, which
// `handle-job` classifies as transient — the queue will back-off-retry
// the job rather than burn another worker forever. Numbers are generous;
// a healthy run is well under each.
const READ_TIMEOUT_MS = 10_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const EMBED_TIMEOUT_MS = 60_000;
const INSERT_TIMEOUT_MS = 10_000;

// cl100k_base via gpt-4o is a reasonable tokenizer for English text. The
// embedding model has its own tokenizer internally; this is just for
// chunking and is not required to match the embedding model exactly.
const enc = encodingForModel("gpt-4o");

interface ProcessInput {
  documentId: string;
  userId: string;
  filename: string;
}

export async function processDocument(
  event: ProcessInput,
  db: MetadataStore,
  vectorStore: VectorStore,
  uploadDir: string
): Promise<number> {
  // File path is derived from documentId, never trusted from the event.
  const filePath = getUploadPath(uploadDir, event.documentId);

  // 1. Read file
  const buffer = await withTimeout(
    readFile(filePath),
    READ_TIMEOUT_MS,
    "readFile"
  );

  // 2. Extract text
  const text = await withTimeout(
    extractTextFromPDF(buffer),
    EXTRACT_TIMEOUT_MS,
    "extractTextFromPDF"
  );

  // 3. Token-aware chunking (synchronous, no I/O — no timeout needed)
  const chunks = chunkByTokens(text, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS);
  if (chunks.length === 0) {
    throw new Error("No text chunks produced from PDF");
  }

  // 4. Embed concurrently with rate limiting + per-call timeout
  const limit = pLimit(EMBED_CONCURRENCY);
  const embeddings = await Promise.all(
    chunks.map((chunk, i) =>
      limit(async () => {
        const embedding = await withTimeout(
          embedText(chunk),
          EMBED_TIMEOUT_MS,
          `embedText[${i}]`
        );
        return { index: i, content: chunk, embedding };
      })
    )
  );

  // 5. Write to pgvector with per-call timeout
  for (const { index, content, embedding } of embeddings) {
    await withTimeout(
      vectorStore.insertChunk(
        event.userId,
        event.documentId,
        index,
        content,
        embedding
      ),
      INSERT_TIMEOUT_MS,
      `insertChunk[${index}]`
    );
  }

  return chunks.length;
}

/**
 * Splits text into overlapping chunks based on token count.
 * Uses the cl100k_base tokenizer (same family as text-embedding-3-small).
 * Chunks are decoded back to text strings for embedding.
 */
export function chunkByTokens(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const tokens = enc.encode(text);
  if (tokens.length === 0) return [];

  const step = chunkSize - overlap;
  const chunks: string[] = [];

  for (let i = 0; i < tokens.length; i += step) {
    const end = Math.min(i + chunkSize, tokens.length);
    const chunkTokens = tokens.slice(i, end);
    chunks.push(enc.decode(chunkTokens));
    if (end === tokens.length) break;
  }

  return chunks;
}

// Race an awaitable against a wall-clock deadline. On timeout we throw
// AbortError so handle-job's classifier treats it as transient. Note:
// for sync-bound work (transformers.js inference) the underlying call
// keeps running until it returns; we just stop waiting for it. That's
// fine — the job is on its way to retry, and a worker-thread / process
// isolation refactor is the right long-term fix (see Production
// Readiness in the README).
async function withTimeout<T>(
  awaitable: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      awaitable,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${ms}ms`);
          err.name = "AbortError";
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
