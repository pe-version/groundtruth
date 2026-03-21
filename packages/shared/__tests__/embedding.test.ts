import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock OpenAI before importing the module under test
vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

// We need to dynamically import after mocking
let embedText: typeof import("../src/embedding.js").embedText;
let embedTexts: typeof import("../src/embedding.js").embedTexts;
let mockCreate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();

  // Re-mock after reset
  const mockCreateFn = vi.fn();
  vi.doMock("openai", () => ({
    default: vi.fn().mockImplementation(() => ({
      embeddings: { create: mockCreateFn },
    })),
  }));

  const mod = await import("../src/embedding.js");
  embedText = mod.embedText;
  embedTexts = mod.embedTexts;
  mockCreate = mockCreateFn;

  process.env.OPENAI_API_KEY = "sk-test";
});

describe("embedText", () => {
  it("returns embedding array for single text", async () => {
    const fakeEmbedding = new Array(1536).fill(0.1);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding, index: 0 }],
    });

    const result = await embedText("hello world");
    expect(result).toEqual(fakeEmbedding);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "hello world",
    });
  });

  it("throws on empty response", async () => {
    mockCreate.mockResolvedValueOnce({ data: [] });
    await expect(embedText("test")).rejects.toThrow("Empty embedding response");
  });
});

describe("embedTexts", () => {
  it("returns sorted embeddings for multiple texts", async () => {
    const emb1 = new Array(1536).fill(0.1);
    const emb2 = new Array(1536).fill(0.2);
    // Return out of order to verify sorting
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: emb2, index: 1 },
        { embedding: emb1, index: 0 },
      ],
    });

    const result = await embedTexts(["first", "second"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(emb1);
    expect(result[1]).toEqual(emb2);
  });

  it("throws on empty response", async () => {
    mockCreate.mockResolvedValueOnce({ data: [] });
    await expect(embedTexts(["test"])).rejects.toThrow("Empty embedding response");
  });
});
