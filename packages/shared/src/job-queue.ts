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

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface DocumentJob {
  id: string;
  documentId: string;
  userId: string;
  filename: string;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
}

export interface EnqueueArgs {
  documentId: string;
  userId: string;
  filename: string;
}

export class JobQueue {
  // staleAfterMs: a 'processing' row whose worker died will be re-claimed
  // after its lock has been held this long. Default is generous because
  // the embedding+index step can run for minutes on a large PDF.
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

  // Claim one job atomically. Returns null when the queue is empty.
  // workerId is recorded on the row so operators can attribute stuck jobs
  // to a specific worker process during debugging.
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
         WHERE status = 'pending'
            OR (status = 'processing' AND locked_at < NOW() - ($2::int || ' milliseconds')::interval)
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, document_id, user_id, filename, status, attempts, error_message`,
      [workerId, this.staleAfterMs]
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE document_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // The "DLQ entry": status='failed' is the same row, marked. Operators
  // inspect with `SELECT * FROM document_jobs WHERE status='failed'`.
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
    errorMessage: row.error_message,
  };
}
