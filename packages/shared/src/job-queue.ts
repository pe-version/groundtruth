import { Pool } from "pg";

// Postgres-backed job queue. Replaces Kafka for the upload→processing
// signal. The pattern is the textbook `SELECT … FOR UPDATE SKIP LOCKED`
// dequeue: cheap, crash-safe, and parallel across N workers without any
// extra coordination service. See infra/init.sql for the schema.
//
// Tradeoffs vs Kafka:
//   + Zero new infrastructure — Postgres is already running
//   + Strong consistency (a job is in exactly one state, atomically)
//   + Trivial to inspect or replay via plain SQL
//   + Failed jobs ARE the DLQ — `WHERE status = 'failed'` is the query
//   - Throughput ceiling is Postgres, not a partitioned log; fine for
//     document ingest (low-thousands/sec) but wrong for event firehoses
//
// Failure model:
//   - Permanent failures (bad PDF, no extractable text) → terminal
//     'failed' on first error. Retrying would just re-fail.
//   - Transient failures (network, timeout, OOM-near-miss) → push the
//     row back to 'pending' with run_after = NOW() + 2^attempts seconds.
//     After max_attempts the row becomes terminal-failed.

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface DocumentJob {
  id: string;
  documentId: string;
  userId: string;
  filename: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
}

export interface EnqueueArgs {
  documentId: string;
  userId: string;
  filename: string;
}

// Caller passes this on a job failure so the queue knows whether to
// schedule a retry or terminate. Default to permanent — we'd rather not
// retry a bug than retry-loop a poison pill.
export type FailKind = "permanent" | "transient";

export class JobQueue {
  // staleAfterMs: a 'processing' row whose worker died is re-claimable
  // after its lock has been held this long. Default is generous because
  // the embedding+index step can run for minutes on a large PDF; the
  // heartbeat updates locked_at during normal progress.
  private readonly staleAfterMs: number;

  constructor(private readonly pool: Pool, opts: { staleAfterMs?: number } = {}) {
    this.staleAfterMs = opts.staleAfterMs ?? 5 * 60_000;
  }

  static async connect(dsn: string, opts?: { staleAfterMs?: number }): Promise<JobQueue> {
    const pool = new Pool({ connectionString: dsn });
    return new JobQueue(pool, opts);
  }

  async enqueue(args: EnqueueArgs): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO document_jobs (document_id, user_id, filename)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [args.documentId, args.userId, args.filename]
    );
    return rows[0].id;
  }

  // Claim one job atomically. Returns null when nothing is claimable
  // *right now* — pending rows whose run_after is in the future are not
  // counted (they're back-off-pending after a transient failure).
  async fetchOne(workerId: string): Promise<DocumentJob | null> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE document_jobs
       SET status      = 'processing',
           locked_at   = NOW(),
           locked_by   = $1,
           attempts    = attempts + 1,
           updated_at  = NOW()
       WHERE id = (
         SELECT id FROM document_jobs
         WHERE (status = 'pending' AND run_after <= NOW())
            OR (status = 'processing' AND locked_at < NOW() - ($2::int || ' milliseconds')::interval)
         ORDER BY run_after
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, document_id, user_id, filename, status, attempts, max_attempts, error_message`,
      [workerId, this.staleAfterMs]
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  // Heartbeat: long-running jobs call this periodically so the
  // stale-lock timer doesn't fire on a healthy worker. The status guard
  // means a heartbeat against a job that's already been completed/failed
  // (e.g., after a crash + reclaim race) is a no-op.
  async heartbeat(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE document_jobs
       SET locked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [id]
    );
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE document_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // Terminal failure. Records the error message; status='failed' is the
  // DLQ predicate operators query for.
  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE document_jobs
       SET status        = 'failed',
           locked_at     = NULL,
           locked_by     = NULL,
           error_message = $2,
           updated_at    = NOW()
       WHERE id = $1`,
      [id, error.slice(0, 4000)]
    );
  }

  // Schedule a retry. Caller has already burned one attempt (incremented
  // on claim); we either set status back to 'pending' with a backoff, or
  // terminal-fail if no attempts remain. Returns the resolved kind so
  // the caller can log appropriately.
  async retryOrFail(
    id: string,
    error: string
  ): Promise<"retried" | "exhausted"> {
    const { rows } = await this.pool.query<{ status: JobStatus }>(
      `UPDATE document_jobs
       SET status = CASE
                      WHEN attempts < max_attempts THEN 'pending'
                      ELSE 'failed'
                    END,
           locked_at  = NULL,
           locked_by  = NULL,
           run_after  = NOW() + (POWER(2, LEAST(attempts, 10)) || ' seconds')::interval,
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING status`,
      [id, error.slice(0, 4000)]
    );
    return rows[0]?.status === "pending" ? "retried" : "exhausted";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface DbRow {
  id: string;
  document_id: string;
  user_id: string;
  filename: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
}

function toJob(row: DbRow): DocumentJob {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    filename: row.filename,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorMessage: row.error_message,
  };
}
