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
    await store.insertChunk("user-1", "doc-1", 0, "chunk content", [0.1, 0.2, 0.3]);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO chunks"),
      ["user-1", "doc-1", 0, "chunk content", "[0.1,0.2,0.3]"]
    );
  });

  it("similarChunks with documentId filters by user and document", async () => {
    const fakeRows = [
      { id: "1", documentId: "doc-1", content: "text", chunkIndex: 0, score: 0.9 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: fakeRows });

    const result = await store.similarChunks("user-1", "doc-1", [0.1, 0.2], 5);

    expect(result).toEqual(fakeRows);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("WHERE user_id = $2 AND document_id = $3");
    expect(mockQuery.mock.calls[0][1]).toEqual(["[0.1,0.2]", "user-1", "doc-1", 5]);
  });

  it("similarChunks with null documentId filters by user only", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await store.similarChunks("user-1", null, [0.1, 0.2], 3);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("WHERE user_id = $2");
    expect(sql).not.toMatch(/WHERE[^O]*document_id/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["[0.1,0.2]", "user-1", 3]);
  });

  it("deleteChunks filters by user and document", async () => {
    mockQuery.mockResolvedValueOnce(undefined);
    await store.deleteChunks("user-1", "doc-1");

    expect(mockQuery).toHaveBeenCalledWith(
      "DELETE FROM chunks WHERE user_id = $1 AND document_id = $2",
      ["user-1", "doc-1"]
    );
  });

  it("close ends the pool", async () => {
    mockEnd.mockResolvedValueOnce(undefined);
    await store.close();
    expect(mockEnd).toHaveBeenCalledOnce();
  });
});
