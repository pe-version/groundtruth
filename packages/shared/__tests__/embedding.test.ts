import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the transformers pipeline so the test never actually loads an
// ONNX model from disk. Each test installs its own implementation of
// the extractor, which lets us assert call shapes and dimensions
// without exercising real inference.

let extractorImpl: ((input: string | string[]) => Promise<{ tolist: () => number[][] }>) =
  async () => ({ tolist: () => [[]] });

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn(async () => {
    return (input: string | string[]) => extractorImpl(input);
  }),
}));

let embedText: typeof import("../src/embedding.js").embedText;
let embedTexts: typeof import("../src/embedding.js").embedTexts;
let EMBED_DIM: number;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../src/embedding.js");
  embedText = mod.embedText;
  embedTexts = mod.embedTexts;
  EMBED_DIM = mod.EMBED_DIM;
});

function fakeVector(seed: number): number[] {
  return new Array(EMBED_DIM).fill(seed);
}

describe("embedText", () => {
  it("returns a vector of EMBED_DIM length", async () => {
    extractorImpl = async () => ({ tolist: () => [fakeVector(0.1)] });
    const result = await embedText("hello world");
    expect(result).toHaveLength(EMBED_DIM);
    expect(result[0]).toBe(0.1);
  });

  it("rejects vectors of the wrong dimension (catches model/schema drift)", async () => {
    extractorImpl = async () => ({ tolist: () => [new Array(EMBED_DIM + 1).fill(0)] });
    await expect(embedText("test")).rejects.toThrow("Embedding dimension mismatch");
  });
});

describe("embedTexts", () => {
  it("returns one vector per input, in input order", async () => {
    extractorImpl = async () => ({
      tolist: () => [fakeVector(0.1), fakeVector(0.2)],
    });
    const result = await embedTexts(["first", "second"]);
    expect(result).toHaveLength(2);
    expect(result[0][0]).toBe(0.1);
    expect(result[1][0]).toBe(0.2);
  });
});
