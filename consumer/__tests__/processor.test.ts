import { describe, it, expect } from "vitest";
import { chunkText, chunkByTokens } from "../src/processor.js";

describe("chunkText (word-based, legacy)", () => {
  it("returns empty array for empty string", () => {
    expect(chunkText("", 512, 64)).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkText("   \n\t  ", 512, 64)).toEqual([]);
  });

  it("returns single chunk when text is shorter than chunkSize", () => {
    const text = "hello world foo bar";
    const chunks = chunkText(text, 512, 64);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("hello world foo bar");
  });

  it("chunks text with correct overlap", () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 4, 2);

    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0]).toBe("w0 w1 w2 w3");
    expect(chunks[1]).toBe("w2 w3 w4 w5");
  });

  it("last chunk includes remaining words", () => {
    const words = Array.from({ length: 7 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 4, 1);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk).toContain("w6");
  });

  it("handles chunk size of 1 with no overlap", () => {
    const chunks = chunkText("a b c", 1, 0);
    expect(chunks).toEqual(["a", "b", "c"]);
  });
});

describe("chunkByTokens (token-aware)", () => {
  it("returns empty array for empty string", () => {
    expect(chunkByTokens("", 512, 64)).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    const text = "Hello, world!";
    const chunks = chunkByTokens(text, 512, 64);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Hello");
    expect(chunks[0]).toContain("world");
  });

  it("produces multiple chunks for longer text", () => {
    // Generate a text that's definitely more than 10 tokens
    const sentences = Array.from(
      { length: 50 },
      (_, i) => `This is sentence number ${i} with some extra words to pad it out.`
    );
    const text = sentences.join(" ");
    const chunks = chunkByTokens(text, 50, 10);

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be non-empty strings
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("chunks have overlapping content", () => {
    const sentences = Array.from(
      { length: 20 },
      (_, i) => `Unique sentence number ${i}.`
    );
    const text = sentences.join(" ");
    // Small chunk size to force many chunks
    const chunks = chunkByTokens(text, 20, 5);

    expect(chunks.length).toBeGreaterThan(2);
    // The end of one chunk should overlap with the start of the next
    // We can verify this by checking that adjacent chunks share some text
    for (let i = 0; i < chunks.length - 1; i++) {
      // The overlap region of chunk[i]'s tail should appear in chunk[i+1]'s head
      const tailWords = chunks[i].split(/\s+/).slice(-3).join(" ");
      expect(chunks[i + 1]).toContain(tailWords);
    }
  });
});
