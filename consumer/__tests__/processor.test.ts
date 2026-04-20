import { describe, it, expect } from "vitest";
import { chunkByTokens } from "../src/processor.js";

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
