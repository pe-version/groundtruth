import { createServer, type Server } from "node:http";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from "prom-client";
import type { Logger } from "@groundtruth/shared";

// Process-local registry (mirrors api/src/services/metrics.ts). The
// consumer is a separate process from the API, so each scrape target
// has its own metrics surface; Prometheus aggregates across scrape
// jobs at query time.
const registry = new Registry();
registry.setDefaultLabels({ service: "groundtruth-consumer" });
collectDefaultMetrics({ register: registry });

// Embedding latency. Buckets sized for transformers.js running on CPU
// — typical chunks land in the 30–80ms range; alert past ~500ms.
export const embedDurationSeconds = new Histogram({
  name: "groundtruth_embed_duration_seconds",
  help: "Wall-clock seconds per embedText() call",
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// End-to-end per-job latency. The denominator on "are we keeping up?"
// alongside queue depth.
export const jobDurationSeconds = new Histogram({
  name: "groundtruth_job_duration_seconds",
  help: "Wall-clock seconds for a complete handleJob() call (success or failure)",
  labelNames: ["outcome"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// Aggregate by outcome so an alert can compare success vs retry/fail
// rates without remembering which buckets are which.
export const jobsTotal = new Counter({
  name: "groundtruth_jobs_total",
  help: "Jobs handled, by outcome",
  labelNames: ["outcome"] as const, // success | retry | fail
  registers: [registry],
});

export function getMetricsRegistry(): Registry {
  return registry;
}

// Tiny HTTP server exposing /metrics. Used instead of pulling in
// Fastify just for an observability surface — the consumer isn't a
// web service in any other sense, so a 30-line http.createServer is
// the right amount of code for the job.
export function startMetricsServer(port: number, log: Logger): Server {
  const server = createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType }).end(body);
    } catch (err) {
      log.warn({ err }, "metrics rendering failed");
      res.writeHead(500).end("metrics error");
    }
  });
  server.listen(port, () => {
    log.info({ port }, "Metrics server listening");
  });
  return server;
}
