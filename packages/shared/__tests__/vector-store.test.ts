import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg and pgvector
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();
const mockEnd = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      connect: mockConnect.mockResolvedValue({
        query: vi.fn().mockResolvedValue(undefined),
        release: mockRelease,
      }),
      end: mockEnd,
    })),
  },
}));

vi.mock("pgvector/pg", () => ({
  default: {
    registerType: vi.fn().mockResolvedValue(undefined),
    toSql: vi.fn((arr: number[]) => `[${arr.join(",")}]`),
  },
}));

import { VectorStore } from "../src/vector-store.js";

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = await VectorStore.connect("postgres://test:test@localhost/test");
  });

  it("insertChunk calls INSERT with correct parameters", async () => {
    mockQuery.mockResolvedValueOnce(undefined);
    await store.insertChunk("doc-1", 0, "chunk content", [0.1, 0.2, 0.3]);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO chunks"),
      ["doc-1", 0, "chunk content", "[0.1,0.2,0.3]"]
    );
  });

  it("similarChunks with documentId queries by document", async () => {
    const fakeRows = [
      { id: "1", documentId: "doc-1", content: "text", chunkIndex: 0, score: 0.9 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: fakeRows });

    const result = await store.similarChunks("doc-1", [0.1, 0.2], 5);

    expect(result).toEqual(fakeRows);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("WHERE document_id = $2");
    expect(mockQuery.mock.calls[0][1]).toEqual(["[0.1,0.2]", "doc-1", 5]);
  });

  it("similarChunks with null documentId queries across all documents", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await store.similarChunks(null, [0.1, 0.2], 3);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain("WHERE document_id");
    expect(mockQuery.mock.calls[0][1]).toEqual(["[0.1,0.2]", 3]);
  });

  it("deleteChunks calls DELETE with document_id", async () => {
    mockQuery.mockResolvedValueOnce(undefined);
    await store.deleteChunks("doc-1");

    expect(mockQuery).toHaveBeenCalledWith(
      "DELETE FROM chunks WHERE document_id = $1",
      ["doc-1"]
    );
  });

  it("close ends the pool", async () => {
    mockEnd.mockResolvedValueOnce(undefined);
    await store.close();
    expect(mockEnd).toHaveBeenCalledOnce();
  });
});
