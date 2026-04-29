import { randomUUID } from "node:crypto";
import {
  loadConsumerConfig,
  MongoDB,
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

  const db = await MongoDB.connect(config.MONGO_URI);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);
  const queue = await JobQueue.connect(config.POSTGRES_DSN);

  log.info({ workerId, pollIntervalMs: config.POLL_INTERVAL_MS }, "Consumer started");

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
    try { await db.disconnect(); } catch (err) { log.error({ err }, "Error disconnecting MongoDB"); }
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
      const result = await handleJob(
        { db, vectorStore, uploadDir: config.UPLOAD_DIR, log },
        job
      );
      if (result.success) {
        await queue.complete(job.id);
      } else {
        await queue.fail(job.id, result.errorMessage ?? "unknown error");
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
