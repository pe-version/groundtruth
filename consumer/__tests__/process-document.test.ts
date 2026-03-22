import { describe, it, expect, vi, beforeEach } from "vitest";
import { processDocument } from "../src/processor.js";

// Mock file system
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock PDF extraction
vi.mock("../src/pdf-extract.js", () => ({
  extractTextFromPDF: vi.fn(),
}));

// Mock embeddings
vi.mock("@direze/shared", async () => {
  return {
    DocumentStatus: {
      Pending: "pending",
      Processing: "processing",
      Ready: "ready",
      Failed: "failed",
    },
    embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  };
});

import { readFile } from "node:fs/promises";
import { extractTextFromPDF } from "../src/pdf-extract.js";
import { embedText } from "@direze/shared";

function createMockDb() {
  return {
    insertDocument: vi.fn(),
    getDocument: vi.fn(),
    listDocuments: vi.fn(),
    updateStatus: vi.fn(),
    markFailed: vi.fn(),
    deleteDocument: vi.fn(),
    getStatusSummary: vi.fn(),
    disconnect: vi.fn(),
  } as any;
}

function createMockVectorStore() {
  return {
    insertChunk: vi.fn().mockResolvedValue(undefined),
    similarChunks: vi.fn(),
    deleteChunks: vi.fn(),
    close: vi.fn(),
  } as any;
}

describe("processDocument", () => {
  let db: ReturnType<typeof createMockDb>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    vectorStore = createMockVectorStore();
  });

  it("processes a PDF and returns chunk count", async () => {
    const pdfBuffer = Buffer.from("fake pdf content");
    vi.mocked(readFile).mockResolvedValueOnce(pdfBuffer);
    vi.mocked(extractTextFromPDF).mockResolvedValueOnce(
      "This is a short document with just enough text to produce one chunk."
    );

    const event = {
      documentId: "doc-1",
      filename: "test.pdf",
      filePath: "/tmp/uploads/doc-1.pdf",
    };

    const chunkCount = await processDocument(event, db, vectorStore, "/tmp/uploads");

    expect(chunkCount).toBeGreaterThanOrEqual(1);
    expect(readFile).toHaveBeenCalledWith("/tmp/uploads/doc-1.pdf");
    expect(extractTextFromPDF).toHaveBeenCalledWith(pdfBuffer);
    expect(embedText).toHaveBeenCalled();
    expect(vectorStore.insertChunk).toHaveBeenCalledTimes(chunkCount);

    // Verify insertChunk was called with correct documentId
    const firstCall = vectorStore.insertChunk.mock.calls[0];
    expect(firstCall[0]).toBe("doc-1");
    expect(firstCall[1]).toBe(0); // chunkIndex
    expect(typeof firstCall[2]).toBe("string"); // content
    expect(firstCall[3]).toHaveLength(1536); // embedding
  });

  it("produces multiple chunks for long text", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("pdf"));
    // Generate long text (enough for multiple 512-token chunks)
    const longText = Array.from(
      { length: 200 },
      (_, i) => `This is sentence number ${i} with enough words to consume several tokens in the tokenizer.`
    ).join(" ");
    vi.mocked(extractTextFromPDF).mockResolvedValueOnce(longText);

    const chunkCount = await processDocument(
      { documentId: "doc-2", filename: "long.pdf", filePath: "/tmp/uploads/long.pdf" },
      db,
      vectorStore,
      "/tmp/uploads"
    );

    expect(chunkCount).toBeGreaterThan(1);
    expect(vectorStore.insertChunk).toHaveBeenCalledTimes(chunkCount);
    // Each call should have sequential chunk indices
    for (let i = 0; i < chunkCount; i++) {
      expect(vectorStore.insertChunk.mock.calls[i][1]).toBe(i);
    }
  });

  it("throws when PDF produces no text", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("pdf"));
    vi.mocked(extractTextFromPDF).mockResolvedValueOnce("");

    await expect(
      processDocument(
        { documentId: "doc-3", filename: "empty.pdf", filePath: "/tmp/uploads/empty.pdf" },
        db,
        vectorStore,
        "/tmp/uploads"
      )
    ).rejects.toThrow("No text chunks produced");
  });

  it("throws when file read fails", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));

    await expect(
      processDocument(
        { documentId: "doc-4", filename: "missing.pdf", filePath: "/tmp/uploads/missing.pdf" },
        db,
        vectorStore,
        "/tmp/uploads"
      )
    ).rejects.toThrow("ENOENT");
  });

  it("throws when PDF extraction fails", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("pdf"));
    vi.mocked(extractTextFromPDF).mockRejectedValueOnce(new Error("Not a valid PDF file"));

    await expect(
      processDocument(
        { documentId: "doc-5", filename: "bad.pdf", filePath: "/tmp/uploads/bad.pdf" },
        db,
        vectorStore,
        "/tmp/uploads"
      )
    ).rejects.toThrow("Not a valid PDF");
  });

  it("rejects file paths outside upload directory", async () => {
    await expect(
      processDocument(
        { documentId: "doc-6", filename: "evil.pdf", filePath: "/etc/passwd" },
        db,
        vectorStore,
        "/tmp/uploads"
      )
    ).rejects.toThrow("Invalid file path");
  });
});
