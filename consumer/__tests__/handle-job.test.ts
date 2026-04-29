import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/processor.js", () => ({
  processDocument: vi.fn(),
}));

vi.mock("@groundtruth/shared", () => ({
  DocumentStatus: {
    Pending: "pending",
    Processing: "processing",
    Ready: "ready",
    Failed: "failed",
  },
}));

import { handleJob } from "../src/handle-job.js";
import { processDocument } from "../src/processor.js";
import type { DocumentJob } from "@groundtruth/shared";

function makeLog(): any {
  const log: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log;
}

function makeDeps() {
  const db = {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  } as any;
  const vectorStore = {} as any;
  const log = makeLog();
  return {
    deps: { db, vectorStore, uploadDir: "/tmp/uploads", log },
    db,
    log,
  };
}

function makeJob(over: Partial<DocumentJob> = {}): DocumentJob {
  return {
    id: "job-1",
    documentId: "d1",
    userId: "u1",
    filename: "f.pdf",
    status: "processing",
    attempts: 1,
    errorMessage: null,
    ...over,
  };
}

describe("handleJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips Pending → Ready on success and returns success=true", async () => {
    const { deps, db } = makeDeps();
    vi.mocked(processDocument).mockResolvedValueOnce(7);

    const result = await handleJob(deps, makeJob());

    expect(result.success).toBe(true);
    expect(db.updateStatus).toHaveBeenCalledWith("d1", "processing", 0);
    expect(db.updateStatus).toHaveBeenCalledWith("d1", "ready", 7);
    expect(db.markFailed).not.toHaveBeenCalled();
  });

  it("marks the doc failed and returns success=false on error", async () => {
    const { deps, db } = makeDeps();
    vi.mocked(processDocument).mockRejectedValueOnce(new Error("PDF parse failed"));

    const result = await handleJob(deps, makeJob({ documentId: "d2" }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("PDF parse failed");
    expect(db.updateStatus).toHaveBeenCalledWith("d2", "processing", 0);
    expect(db.markFailed).toHaveBeenCalledWith("d2", "PDF parse failed");
    expect(db.updateStatus).not.toHaveBeenCalledWith("d2", "ready", expect.anything());
  });

  it("never retries internally — one call to processDocument per invocation", async () => {
    const { deps } = makeDeps();
    vi.mocked(processDocument).mockRejectedValueOnce(new Error("transient?"));

    await handleJob(deps, makeJob());

    expect(processDocument).toHaveBeenCalledTimes(1);
  });
});
