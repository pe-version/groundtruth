import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMessage, type KafkaMessageEnvelope } from "../src/handle-message.js";

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
  KafkaDocumentEventSchema: {
    parse: (v: unknown) => {
      if (
        typeof v !== "object" ||
        v === null ||
        typeof (v as any).documentId !== "string" ||
        typeof (v as any).userId !== "string" ||
        typeof (v as any).filename !== "string"
      ) {
        throw new Error("Invalid KafkaDocumentEvent");
      }
      return v;
    },
  },
}));

import { processDocument } from "../src/processor.js";

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
  const dlq = { send: vi.fn().mockResolvedValue(undefined) } as any;
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  const log = makeLog();
  return {
    deps: { db, vectorStore, dlq, uploadDir: "/tmp/uploads", heartbeat, log },
    db,
    dlq,
    log,
  };
}

function envelope(value: string | null): KafkaMessageEnvelope {
  return { key: "k", value, topic: "raw-docs", partition: 0, offset: "42" };
}

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns and returns on empty message (no DLQ, no status update)", async () => {
    const { deps, db, dlq, log } = makeDeps();
    await handleMessage(deps, envelope(null));

    expect(log.warn).toHaveBeenCalled();
    expect(db.updateStatus).not.toHaveBeenCalled();
    expect(dlq.send).not.toHaveBeenCalled();
  });

  it("DLQs malformed JSON and does not touch the document collection", async () => {
    const { deps, db, dlq } = makeDeps();
    await handleMessage(deps, envelope("not-json{"));

    expect(dlq.send).toHaveBeenCalledOnce();
    expect(db.updateStatus).not.toHaveBeenCalled();
    expect(db.markFailed).not.toHaveBeenCalled();
  });

  it("marks Processing -> Ready on success", async () => {
    const { deps, db, dlq } = makeDeps();
    vi.mocked(processDocument).mockResolvedValueOnce(7);

    await handleMessage(
      deps,
      envelope(JSON.stringify({ documentId: "d1", userId: "u1", filename: "f.pdf" }))
    );

    expect(db.updateStatus).toHaveBeenCalledWith("d1", "processing", 0);
    expect(db.updateStatus).toHaveBeenCalledWith("d1", "ready", 7);
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(dlq.send).not.toHaveBeenCalled();
  });

  it("DLQs on first failure and marks the doc failed (no retries)", async () => {
    const { deps, db, dlq } = makeDeps();
    vi.mocked(processDocument).mockRejectedValueOnce(new Error("OpenAI 429"));

    await handleMessage(
      deps,
      envelope(JSON.stringify({ documentId: "d2", userId: "u1", filename: "f.pdf" }))
    );

    expect(db.updateStatus).toHaveBeenCalledWith("d2", "processing", 0);
    expect(db.markFailed).toHaveBeenCalledWith("d2", "OpenAI 429");
    expect(dlq.send).toHaveBeenCalledOnce();
    // No "ready" flip
    expect(db.updateStatus).not.toHaveBeenCalledWith("d2", "ready", expect.anything());
  });

  it("clears heartbeat interval even when processing throws", async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    vi.mocked(processDocument).mockRejectedValueOnce(new Error("boom"));

    await handleMessage(
      deps,
      envelope(JSON.stringify({ documentId: "d3", userId: "u1", filename: "f.pdf" }))
    );

    // Advance timers past the 5s heartbeat interval — heartbeat should not
    // fire again because the interval was cleared in the finally block.
    const heartbeatCallsBefore = vi.mocked(deps.heartbeat).mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(vi.mocked(deps.heartbeat).mock.calls.length).toBe(heartbeatCallsBefore);

    vi.useRealTimers();
  });
});
