// End-to-end integration test for the processor pipeline. Spins up a
// real Postgres container (with our init.sql), connects the live
// MetadataStore + VectorStore + JobQueue, generates a synthetic PDF in
// memory, and runs processDocument against it.
//
// What this catches that the unit tests don't:
//   • SQL syntax against the actual schema
//   • Connection-pooling and transaction behavior
//   • The pgvector extension being installed and queryable
//   • Embedding-dimension agreement between transformers.js and the
//     vector(N) column declaration
//   • The pipeline composition end-to-end
//
// What this DOES NOT cover (still mocked or out of scope):
//   • The Anthropic LLM call (no real API key needed for ingest)
//   • HTTP routing (covered by routes.test.ts)
//   • Frontend behavior
//
// First run downloads the bge-small-en-v1.5 ONNX model (~33 MB) into
// ~/.cache/transformers.js. Subsequent runs use the cached copy.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MetadataStore,
  VectorStore,
  JobQueue,
  DocumentStatus,
  embedText,
} from "@groundtruth/shared";
import { processDocument } from "../src/processor.js";

// 5-minute hard cap. Container start + first-time model download are
// the slow steps; if it goes longer than this something is wrong.
const TEST_TIMEOUT_MS = 5 * 60_000;

// Resolve init.sql relative to the package root.
const INIT_SQL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../infra/init.sql"
);

describe("processor integration", () => {
  let container: StartedPostgreSqlContainer;
  let dsn: string;
  let db: MetadataStore;
  let vectorStore: VectorStore;
  let queue: JobQueue;
  let uploadDir: string;

  beforeAll(async () => {
    // Boot Postgres with our extension and schema. The pgvector image is
    // the same one production runs, so the extension is present at
    // CREATE EXTENSION time without extra steps.
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("groundtruth")
      .withUsername("groundtruth")
      .withPassword("groundtruth")
      .withCopyFilesToContainer([
        { source: INIT_SQL_PATH, target: "/docker-entrypoint-initdb.d/init.sql" },
      ])
      .start();
    dsn = container.getConnectionUri();

    db = await MetadataStore.connect(dsn);
    vectorStore = await VectorStore.connect(dsn);
    queue = await JobQueue.connect(dsn);

    uploadDir = mkdtempSync(path.join(tmpdir(), "groundtruth-int-"));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.disconnect();
    await vectorStore?.close();
    await queue?.close();
    if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
    await container?.stop();
  }, 30_000);

  it(
    "writes user + document, processes a real PDF, and chunks become similarity-searchable",
    async () => {
      const userId = `u-${randomUUID().slice(0, 8)}`;
      const documentId = randomUUID();

      // Synthetic PDF with deterministic text. Use a phrase that's
      // unlikely to appear in the embedding model's training noise so
      // similarity search has something distinctive to match.
      const distinctivePhrase =
        "The quokka of Rottnest Island has been observed to greet hikers " +
        "with what biologists describe as a smile.";
      const pdfPath = path.join(uploadDir, `${documentId}.pdf`);
      await writePdfWithText(pdfPath, distinctivePhrase + " ".repeat(8));

      // Seed the user + document rows the processor expects to find.
      await db.createUser(userId, "");
      await db.insertDocument({
        _id: documentId,
        userId,
        filename: "test.pdf",
        status: DocumentStatus.Processing,
        chunkCount: 0,
        uploadedAt: new Date(),
        updatedAt: new Date(),
      });

      const chunkCount = await processDocument(
        { documentId, userId, filename: "test.pdf" },
        db,
        vectorStore,
        uploadDir
      );

      expect(chunkCount).toBeGreaterThan(0);

      // Similarity search: embed a related question and verify a chunk
      // from our document comes back. Cosine on unit-normalized vectors
      // gives scores in [0, 1]; a related-but-not-identical query should
      // land well above 0.4.
      const queryEmbedding = await embedText(
        "What do quokkas do when they meet people?"
      );
      const hits = await vectorStore.similarChunks(
        userId,
        documentId,
        queryEmbedding,
        5
      );

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].score).toBeGreaterThan(0.4);
      expect(hits[0].content.toLowerCase()).toContain("quokka");
    },
    TEST_TIMEOUT_MS
  );

  it("the queue's full lifecycle: enqueue → fetch → complete", async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const documentId = randomUUID();
    await db.createUser(userId, "");

    const jobId = await queue.enqueue({
      documentId,
      userId,
      filename: "queue-test.pdf",
    });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const claimed = await queue.fetchOne("test-worker");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.status).toBe("processing");
    expect(claimed!.attempts).toBe(1);

    // A second worker racing the same row gets nothing — SKIP LOCKED is
    // doing its job.
    const second = await queue.fetchOne("test-worker-2");
    expect(second).toBeNull();

    await queue.complete(jobId);

    // After complete() the row is no longer claimable.
    const after = await queue.fetchOne("test-worker");
    expect(after).toBeNull();
  });

  it("retryOrFail backs off on transient failure and terminates after max_attempts", async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const documentId = randomUUID();
    await db.createUser(userId, "");

    const jobId = await queue.enqueue({
      documentId,
      userId,
      filename: "retry-test.pdf",
    });

    // Burn through max_attempts (3 by default). On each iteration we
    // claim the row (which increments attempts), then call retryOrFail.
    // The first two should re-queue; the third should terminate.
    const outcomes: Array<"retried" | "exhausted"> = [];
    for (let i = 0; i < 3; i++) {
      const claimed = await queue.fetchOne("test-worker");
      expect(claimed).not.toBeNull();
      const outcome = await queue.retryOrFail(claimed!.id, "transient err");
      outcomes.push(outcome);
      // Force the back-off to elapse instantly so the next fetchOne can
      // claim. In production the consumer would just wait it out.
      await db["pool"].query(
        `UPDATE document_jobs SET run_after = NOW() WHERE id = $1`,
        [jobId]
      );
    }
    expect(outcomes).toEqual(["retried", "retried", "exhausted"]);

    // After exhaustion the row is in 'failed' and not claimable.
    const after = await queue.fetchOne("test-worker");
    expect(after).toBeNull();
  });
});

// Generate a single-page PDF whose body contains the given text.
// pdfkit handles xref offsets correctly; we just hand it text and wait
// for the stream to drain.
async function writePdfWithText(filePath: string, text: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({ size: "LETTER", margin: 72 });
  const chunks: Buffer[] = [];
  return new Promise<void>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      try {
        writeFileSync(filePath, Buffer.concat(chunks));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    doc.on("error", reject);
    doc.fontSize(14).text(text);
    doc.end();
  });
}
