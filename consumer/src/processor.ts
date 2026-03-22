import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { encodingForModel } from "js-tiktoken";
import {
  DocumentStatus,
  type KafkaDocumentEvent,
  type MongoDB,
  type VectorStore,
  embedText,
} from "@direze/shared";
import { extractTextFromPDF } from "./pdf-extract.js";

const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 64;
const EMBED_CONCURRENCY = 5;

// Use cl100k_base encoding (used by text-embedding-3-small)
const enc = encodingForModel("gpt-4o");

export async function processDocument(
  event: KafkaDocumentEvent,
  db: MongoDB,
  vectorStore: VectorStore,
  uploadDir?: string
): Promise<number> {
  // Validate file path to prevent path traversal
  if (uploadDir) {
    const realFilePath = path.resolve(event.filePath);
    const realUploadDir = path.resolve(uploadDir);
    if (!realFilePath.startsWith(realUploadDir + path.sep) && realFilePath !== realUploadDir) {
      throw new Error(`Invalid file path: ${event.filePath} is outside upload directory`);
    }
  }

  // 1. Read file
  const buffer = await readFile(event.filePath);

  // 2. Extract text
  const text = await extractTextFromPDF(buffer);

  // 3. Token-aware chunking
  const chunks = chunkByTokens(text, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS);
  if (chunks.length === 0) {
    throw new Error("No text chunks produced from PDF");
  }

  // 4. Embed concurrently with rate limiting
  const limit = pLimit(EMBED_CONCURRENCY);

  const embeddings = await Promise.all(
    chunks.map((chunk, i) =>
      limit(async () => {
        const embedding = await embedText(chunk);
        return { index: i, content: chunk, embedding };
      })
    )
  );

  // 5. Write to pgvector
  for (const { index, content, embedding } of embeddings) {
    await vectorStore.insertChunk(event.documentId, index, content, embedding);
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

/**
 * @deprecated Use chunkByTokens instead. Kept for backward compatibility in tests.
 */
export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const end = Math.min(i + chunkSize, words.length);
    chunks.push(words.slice(i, end).join(" "));
    if (end === words.length) break;
  }
  return chunks;
}
