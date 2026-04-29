import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type { FastifyInstance } from "fastify";
import type { JobQueue } from "@groundtruth/shared";

// Process-local Prometheus registry. Living outside the default global
// registry means our metrics don't leak across test runs (vitest reuses
// the same process for sequential test files) and keeps ownership of
// what's exposed at /metrics explicit.
const registry = new Registry();
registry.setDefaultLabels({ service: "groundtruth-api" });
collectDefaultMetrics({ register: registry });

// HTTP request latency, broken out by route and status code. Buckets
// chosen for an internal API: most requests should land in the first
// few buckets, the long tail is what you alert on.
export const httpRequestDuration = new Histogram({
  name: "groundtruth_http_request_duration_seconds",
  help: "HTTP request latency in seconds, by route and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Job-queue health. The two numbers a panel will ask for first: how
// much work is waiting, and how stale is the oldest waiting item?
// Both are gauges refreshed by a periodic poll (see startMetricsRefresh
// below); cheap query, negligible Postgres load.
export const queueDepth = new Gauge({
  name: "groundtruth_queue_depth",
  help: "Number of jobs in 'pending' state",
  registers: [registry],
});

export const queueOldestPendingAgeSeconds = new Gauge({
  name: "groundtruth_queue_oldest_pending_age_seconds",
  help: "Age in seconds of the oldest pending job (0 if queue is empty)",
  registers: [registry],
});

export const queueFailedTotal = new Gauge({
  name: "groundtruth_queue_failed_total",
  help: "Number of jobs in terminal 'failed' state — operators inspect with WHERE status='failed'",
  registers: [registry],
});

// Login outcomes. Useful for spotting brute-force attempts (login_total
// with status='failure' climbing without a corresponding success climb)
// and refresh-replay incidents.
export const authEventsTotal = new Counter({
  name: "groundtruth_auth_events_total",
  help: "Auth-flow outcomes",
  labelNames: ["event", "outcome"] as const,
  registers: [registry],
});

export function getMetricsRegistry(): Registry {
  return registry;
}

// Hook the histogram into Fastify's request lifecycle. Registered once
// in api/src/index.ts; the route name is taken from the matched route
// pattern (e.g. "/api/documents/:id") so cardinality stays bounded —
// using the raw URL would explode the label space on UUID paths.
export function instrumentHttp(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    httpRequestDuration
      .labels({
        method: request.method,
        route,
        status: String(reply.statusCode),
      })
      .observe(reply.elapsedTime / 1000);
  });
}

// Periodic queue-stats refresh. Polls Postgres on a 5s tick; keeps
// /metrics responses fast (gauges return cached values) without
// hammering the DB. The query is two SELECTs against an indexed table,
// so the cost is negligible.
//
// Returns a stop function so the caller can clean up on shutdown.
export function startMetricsRefresh(queue: JobQueue): () => void {
  const POLL_MS = 5_000;

  // The queue's pool is private; the cleanest way to read these stats
  // without breaking encapsulation is a small dedicated method on
  // JobQueue. Adding it here as a free function would couple metrics
  // to JobQueue internals.
  const tick = async () => {
    try {
      const stats = await queue.stats();
      queueDepth.set(stats.pendingCount);
      queueOldestPendingAgeSeconds.set(stats.oldestPendingAgeSeconds);
      queueFailedTotal.set(stats.failedCount);
    } catch {
      // A failed metrics poll shouldn't crash the server; silently
      // skip this tick. Repeated failures will surface as gauges
      // freezing at their last value, which is the correct
      // observability behavior.
    }
  };

  void tick();
  const handle = setInterval(tick, POLL_MS);
  return () => clearInterval(handle);
}
