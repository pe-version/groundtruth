import OpenAI from "openai";

// Single source of truth for the embedding model and its output dimension.
// The SQL schema (infra/init.sql) declares `vector(1536)` and MUST stay in
// sync with EMBED_DIM. The assertion in embedText() catches a mismatch at
// first use (loud failure) rather than letting bad data reach the DB.
export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // 30s per embedding call; SDK retries disabled (DLQ-on-first-failure).
      timeout: 30_000,
      maxRetries: 0,
    });
  }
  return client;
}

function assertDim(vec: number[]): void {
  if (vec.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBED_DIM}, got ${vec.length}. ` +
      `If you changed EMBED_MODEL, update EMBED_DIM and infra/init.sql.`
    );
  }
}

export async function embedText(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error("Empty embedding response from OpenAI");
  }

  const vec = response.data[0].embedding;
  assertDim(vec);
  return vec;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await getClient().embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error("Empty embedding response from OpenAI");
  }

  const vectors = response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
  vectors.forEach(assertDim);
  return vectors;
}
