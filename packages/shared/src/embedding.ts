import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Local, vendor-free embeddings via transformers.js — runs an ONNX model
// in the same Node process as the consumer. Replaces the OpenAI embeddings
// SDK so document processing has no per-token cost and no third-party
// network dependency on the hot path.
//
// bge-small-en-v1.5 is the BAAI's small English model (384 dims, ~33 MB
// quantized). On the BEIR retrieval benchmark it's competitive with much
// larger commercial embedding models while running CPU-fine on a laptop.
//
// EMBED_DIM MUST match the `vector(N)` declaration in infra/init.sql.
// Changing the model means changing both, and re-embedding every document.
export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIM = 384;

// The pipeline lazily downloads the model on first use (cached afterwards
// under ~/.cache/huggingface). We reuse the same instance for the lifetime
// of the process — loading is the expensive step, not inference.
let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (!loading) {
    loading = pipeline("feature-extraction", EMBED_MODEL, {
      // bge models are released as quantized ONNX. quantized=true is ~33MB
      // and ~3x faster on CPU than the full-precision variant.
      quantized: true,
    }) as Promise<FeatureExtractionPipeline>;
  }
  extractor = await loading;
  return extractor;
}

function assertDim(vec: number[]): void {
  if (vec.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBED_DIM}, got ${vec.length}. ` +
        `If you changed EMBED_MODEL, update EMBED_DIM and infra/init.sql.`
    );
  }
}

// BGE models recommend mean-pooling and L2-normalization. transformers.js
// does both when invoked with these options, so the resulting vectors are
// directly comparable via cosine similarity (which on unit vectors equals
// the inner product — pgvector handles either path).
async function encode(texts: string[]): Promise<number[][]> {
  const ex = await getExtractor();
  const tensor = await ex(texts, { pooling: "mean", normalize: true });
  // tensor.tolist() returns number[][] for batched input, number[] for
  // single. We always pass an array so the result is uniformly 2D.
  const list = tensor.tolist() as number[][];
  list.forEach(assertDim);
  return list;
}

export async function embedText(text: string): Promise<number[]> {
  const [vec] = await encode([text]);
  return vec;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return await encode(texts);
}
