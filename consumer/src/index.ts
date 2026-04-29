import { randomUUID } from "node:crypto";
import {
  loadConsumerConfig,
  MetadataStore,
  VectorStore,
  JobQueue,
  createLogger,
} from "@groundtruth/shared";
import { handleJob } from "./handle-job.js";

async function main() {
  const config = loadConsumerConfig();
  const log = createLogger("consumer");

  // Worker IDs are recorded on each claimed job row so a stuck job can be
  // attributed to a specific process during debugging. A short suffix is
  // enough — collisions across hundreds of workers are still vanishingly
  // unlikely and the row also has a created_at to disambiguate.
  const workerId = `worker-${randomUUID().slice(0, 8)}`;

  const db = await MetadataStore.connect(config.POSTGRES_DSN);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);
  const queue = await JobQueue.connect(config.POSTGRES_DSN);

  log.info({ workerId, pollIntervalMs: config.POLL_INTERVAL_MS }, "Consumer started");

  // Heartbeat cadence: a healthy job updates locked_at every HEARTBEAT_MS
  // so the queue's stale-lock timer doesn't reclaim a slow-but-progressing
  // worker. Pick a value well under JobQueue.staleAfterMs (default 5 min).
  const HEARTBEAT_MS = 30_000;

  let running = true;
  let activeJob: Promise<unknown> | null = null;

  // Graceful shutdown: stop claiming new work, finish the current job (if
  // any), then close pools. A SIGKILL bypasses this — that's fine, the
  // queue's stale-lock recovery (see JobQueue.fetchOne) will reclaim the
  // half-processed row after staleAfterMs.
  const shutdown = async () => {
    if (!running) return;
    log.info("Consumer shutting down — draining current job");
    running = false;
    if (activeJob) await activeJob.catch(() => undefined);
    try { await queue.close(); } catch (err) { log.error({ err }, "Error closing JobQueue"); }
    try { await vectorStore.close(); } catch (err) { log.error({ err }, "Error closing VectorStore"); }
    try { await db.disconnect(); } catch (err) { log.error({ err }, "Error disconnecting MetadataStore"); }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    const job = await queue.fetchOne(workerId);
    if (!job) {
      await sleep(config.POLL_INTERVAL_MS);
      continue;
    }

    activeJob = (async () => {
      // Heartbeat ticker — refreshes locked_at every HEARTBEAT_MS so a
      // long-but-progressing job isn't mistaken for stuck. Failures on
      // the heartbeat itself are logged but never block forward progress.
      const heartbeatTimer = setInterval(() => {
        queue.heartbeat(job.id).catch((err) => {
          log.warn({ err, jobId: job.id }, "Heartbeat update failed");
        });
      }, HEARTBEAT_MS);

      try {
        const result = await handleJob(
          { db, vectorStore, uploadDir: config.UPLOAD_DIR, log },
          job
        );
        if (result.success) {
          await queue.complete(job.id);
          return;
        }
        const errMsg = result.errorMessage ?? "unknown error";
        if (result.failureKind === "transient") {
          const outcome = await queue.retryOrFail(job.id, errMsg);
          log.info({ jobId: job.id, outcome }, "Transient failure handled");
        } else {
          // Permanent — terminate immediately, no retries.
          await queue.fail(job.id, errMsg);
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    })();
    await activeJob;
    activeJob = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
