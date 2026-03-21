import { describe, it, expect, vi, beforeEach } from "vitest";
import { MongoDB } from "../src/mongo.js";
import { DocumentStatus } from "../src/types.js";

// Build mock collection
function createMockCollection() {
  return {
    insertOne: vi.fn().mockResolvedValue({ insertedId: "test" }),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
  };
}

function createMockMongoDB() {
  const col = createMockCollection();
  const mockClient = {
    db: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue(col),
      command: vi.fn().mockResolvedValue({ ok: 1 }),
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as any;

  const db = new MongoDB(mockClient);
  return { db, col, client: mockClient };
}

describe("MongoDB", () => {
  let db: MongoDB;
  let col: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    ({ db, col } = createMockMongoDB());
  });

  it("insertDocument calls insertOne", async () => {
    const doc = {
      _id: "doc-1",
      filename: "test.pdf",
      status: DocumentStatus.Pending,
      chunkCount: 0,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insertDocument(doc);
    expect(col.insertOne).toHaveBeenCalledWith(doc);
  });

  it("getDocument calls findOne with _id", async () => {
    col.findOne.mockResolvedValueOnce({ _id: "doc-1", filename: "test.pdf" });
    const result = await db.getDocument("doc-1");
    expect(result).toEqual({ _id: "doc-1", filename: "test.pdf" });
    expect(col.findOne).toHaveBeenCalledWith({ _id: "doc-1" });
  });

  it("getDocument returns null for missing document", async () => {
    col.findOne.mockResolvedValueOnce(null);
    const result = await db.getDocument("missing");
    expect(result).toBeNull();
  });

  it("listDocuments returns sorted documents", async () => {
    const docs = [
      { _id: "doc-1", filename: "a.pdf" },
      { _id: "doc-2", filename: "b.pdf" },
    ];
    const mockSort = {
      sort: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(docs),
      }),
    };
    col.find.mockReturnValueOnce(mockSort);

    const result = await db.listDocuments();
    expect(result).toEqual(docs);
    expect(mockSort.sort).toHaveBeenCalledWith({ uploadedAt: -1 });
  });

  it("updateStatus sets status, chunkCount, and updatedAt", async () => {
    await db.updateStatus("doc-1", DocumentStatus.Ready, 10);
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: "doc-1" },
      {
        $set: {
          status: "ready",
          chunkCount: 10,
          updatedAt: expect.any(Date),
        },
      }
    );
  });

  it("markFailed sets status to failed with error message", async () => {
    await db.markFailed("doc-1", "Something went wrong");
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: "doc-1" },
      {
        $set: {
          status: "failed",
          errorMsg: "Something went wrong",
          updatedAt: expect.any(Date),
        },
      }
    );
  });

  it("deleteDocument calls deleteOne", async () => {
    await db.deleteDocument("doc-1");
    expect(col.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
  });

  it("getStatusSummary runs aggregation pipeline", async () => {
    const summary = [
      { status: "ready", count: 5 },
      { status: "pending", count: 2 },
    ];
    const mockAggregate = {
      toArray: vi.fn().mockResolvedValue(summary),
    };
    col.aggregate.mockReturnValueOnce(mockAggregate);

    const result = await db.getStatusSummary();
    expect(result).toEqual(summary);
    expect(col.aggregate).toHaveBeenCalledWith([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, status: "$_id", count: 1 } },
    ]);
  });
});
