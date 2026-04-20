import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { runJanitor } from "../src/services/janitor.js";

function makeLog(): any {
  const log: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log;
}

describe("runJanitor", () => {
  let uploadDir: string;

  beforeEach(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "janitor-"));
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function writeAgedFile(name: string, ageMs: number) {
    const p = path.join(uploadDir, name);
    await writeFile(p, "pdf");
    const t = (Date.now() - ageMs) / 1000;
    await utimes(p, t, t);
  }

  it("deletes orphan files older than the threshold", async () => {
    await writeAgedFile("orphan-a.pdf", 2 * 60 * 60_000); // 2h old
    await writeAgedFile("kept-b.pdf", 2 * 60 * 60_000);

    const db: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([
        { id: "kept-b", status: "ready", updatedAt: new Date() },
      ]),
      listStuckDocuments: vi.fn().mockResolvedValue([]),
      markFailed: vi.fn(),
    };
    const vectorStore: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      deleteOrphanChunks: vi.fn(),
    };

    const report = await runJanitor({
      db, vectorStore, uploadDir, log: makeLog(),
      orphanAgeMs: 60 * 60_000,
      intervalMs: 60_000,
    });

    expect(report.orphanFilesDeleted).toBe(1);
    const remaining = await readdir(uploadDir);
    expect(remaining).toEqual(["kept-b.pdf"]);
  });

  it("does not delete files younger than the threshold (protects mid-upload)", async () => {
    await writeAgedFile("fresh-c.pdf", 5_000); // 5s old

    const db: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      listStuckDocuments: vi.fn().mockResolvedValue([]),
      markFailed: vi.fn(),
    };
    const vectorStore: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      deleteOrphanChunks: vi.fn(),
    };

    const report = await runJanitor({
      db, vectorStore, uploadDir, log: makeLog(),
      orphanAgeMs: 60 * 60_000,
      intervalMs: 60_000,
    });

    expect(report.orphanFilesDeleted).toBe(0);
    const remaining = await readdir(uploadDir);
    expect(remaining).toEqual(["fresh-c.pdf"]);
  });

  it("deletes orphan chunks whose document_id is not in Mongo", async () => {
    const db: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([
        { id: "d-live", status: "ready", updatedAt: new Date() },
      ]),
      listStuckDocuments: vi.fn().mockResolvedValue([]),
      markFailed: vi.fn(),
    };
    const vectorStore: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue(["d-live", "d-orphan-1", "d-orphan-2"]),
      deleteOrphanChunks: vi.fn().mockImplementation(async (id: string) => (id === "d-orphan-1" ? 5 : 3)),
    };

    const report = await runJanitor({
      db, vectorStore, uploadDir, log: makeLog(),
      orphanAgeMs: 60 * 60_000,
      intervalMs: 60_000,
    });

    expect(report.orphanChunksDeleted).toBe(8);
    expect(vectorStore.deleteOrphanChunks).toHaveBeenCalledWith("d-orphan-1");
    expect(vectorStore.deleteOrphanChunks).toHaveBeenCalledWith("d-orphan-2");
    expect(vectorStore.deleteOrphanChunks).not.toHaveBeenCalledWith("d-live");
  });

  it("marks docs stuck in pending/processing as failed", async () => {
    const db: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      listStuckDocuments: vi.fn().mockResolvedValue([
        { id: "stuck-1", status: "processing" },
        { id: "stuck-2", status: "pending" },
      ]),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const vectorStore: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      deleteOrphanChunks: vi.fn(),
    };

    const report = await runJanitor({
      db, vectorStore, uploadDir, log: makeLog(),
      orphanAgeMs: 60 * 60_000,
      intervalMs: 60_000,
    });

    expect(report.stuckDocsFailed).toBe(2);
    expect(db.markFailed).toHaveBeenCalledWith(
      "stuck-1",
      expect.stringContaining("Stuck in processing")
    );
    expect(db.markFailed).toHaveBeenCalledWith(
      "stuck-2",
      expect.stringContaining("Stuck in pending")
    );
  });

  it("is resilient to upload directory not existing", async () => {
    const db: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      listStuckDocuments: vi.fn().mockResolvedValue([]),
      markFailed: vi.fn(),
    };
    const vectorStore: any = {
      listAllDocumentIds: vi.fn().mockResolvedValue([]),
      deleteOrphanChunks: vi.fn(),
    };

    // Point at a path that does not exist; janitor should log a warning
    // instead of crashing.
    const report = await runJanitor({
      db, vectorStore, uploadDir: path.join(uploadDir, "nope"), log: makeLog(),
      orphanAgeMs: 60 * 60_000,
      intervalMs: 60_000,
    });

    expect(report.orphanFilesDeleted).toBe(0);
  });
});
