import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { encodingForModel } from "js-tiktoken";
import {
  type MongoDB,
  type VectorStore,
  embedText,
  getUploadPath,
} from "@groundtruth/shared";
import { extractTextFromPDF } from "./pdf-extract.js";

const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 64;
const EMBED_CONCURRENCY = 5;

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
  db: MongoDB,
  vectorStore: VectorStore,
  uploadDir: string
): Promise<number> {
  // File path is derived from documentId, never trusted from the event.
  const filePath = getUploadPath(uploadDir, event.documentId);

  // 1. Read file
  const buffer = await readFile(filePath);

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
    await vectorStore.insertChunk(
      event.userId,
      event.documentId,
      index,
      content,
      embedding
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

