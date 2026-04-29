import { Pool } from "pg";
import { DocumentStatus, type Document, type User } from "./types.js";

// Postgres-backed replacement for the previous MongoDB-backed store.
// Owns the `users` and `documents` tables. Schema lives in infra/init.sql.
//
// Why this exists in the same shape as the old MongoDB class: every caller
// already speaks this method shape, so the migration is a one-class swap
// rather than a rewrite of every route. The Document and User domain
// types still use `_id` (a MongoDB-ism) so existing response-mapping code
// in the API stays unchanged — this class translates between the SQL
// `id` column and the in-memory `_id` field.

export class MetadataStore {
  constructor(private readonly pool: Pool) {}

  static async connect(dsn: string): Promise<MetadataStore> {
    const pool = new Pool({ connectionString: dsn });
    return new MetadataStore(pool);
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  // Cheap connectivity probe used by /health. SELECT 1 doesn't touch any
  // table; it confirms the pool is alive and the server is responsive.
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  // ── User store ──────────────────────────────────────────────────────────

  async createUser(username: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, password_hash) VALUES ($1, $2)`,
      [username, passwordHash]
    );
  }

  async getUser(username: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, password_hash, oauth_provider, created_at
       FROM users WHERE id = $1`,
      [username]
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  // Idempotent upsert for OAuth-provisioned users. password_hash stays
  // empty so /auth/login can never issue them a token even if the userId
  // is guessable.
  async upsertOAuthUser(userId: string, provider: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, password_hash, oauth_provider)
       VALUES ($1, '', $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, provider]
    );
  }

  // ── Documents ───────────────────────────────────────────────────────────

  async insertDocument(doc: Document): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents
        (id, user_id, filename, status, chunk_count, error_msg, uploaded_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        doc._id,
        doc.userId,
        doc.filename,
        doc.status,
        doc.chunkCount,
        doc.errorMsg ?? null,
        doc.uploadedAt,
        doc.updatedAt,
      ]
    );
  }

  async getDocument(id: string): Promise<Document | null> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT id, user_id, filename, status, chunk_count, error_msg, uploaded_at, updated_at
       FROM documents WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToDocument(rows[0]) : null;
  }

  async listDocuments(userId: string): Promise<Document[]> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT id, user_id, filename, status, chunk_count, error_msg, uploaded_at, updated_at
       FROM documents WHERE user_id = $1
       ORDER BY uploaded_at DESC`,
      [userId]
    );
    return rows.map(rowToDocument);
  }

  async updateStatus(
    id: string,
    status: DocumentStatus,
    chunkCount: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE documents
       SET status = $2, chunk_count = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, chunkCount]
    );
  }

  async markFailed(id: string, errorMsg: string): Promise<void> {
    await this.pool.query(
      `UPDATE documents
       SET status = $2, error_msg = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, DocumentStatus.Failed, errorMsg]
    );
  }

  async deleteDocument(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM documents WHERE id = $1`, [id]);
  }

  // Janitor support: every document's id + status, across all users. Used
  // for reconciliation against the filesystem and pgvector — never on the
  // user-facing read path.
  async listAllDocumentIds(): Promise<
    Array<{ id: string; status: DocumentStatus; updatedAt: Date }>
  > {
    const { rows } = await this.pool.query<{
      id: string;
      status: DocumentStatus;
      updated_at: Date;
    }>(`SELECT id, status, updated_at FROM documents`);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      updatedAt: r.updated_at,
    }));
  }

  async listStuckDocuments(
    olderThan: Date
  ): Promise<Array<{ id: string; status: DocumentStatus }>> {
    // The partial index `documents_stuck_idx` makes this scan O(stuck)
    // rather than O(table).
    const { rows } = await this.pool.query<{ id: string; status: DocumentStatus }>(
      `SELECT id, status FROM documents
       WHERE status IN ('pending', 'processing')
         AND updated_at < $1`,
      [olderThan]
    );
    return rows;
  }

  async getStatusSummary(
    userId: string
  ): Promise<{ status: DocumentStatus; count: number }[]> {
    const { rows } = await this.pool.query<{ status: DocumentStatus; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM documents WHERE user_id = $1
       GROUP BY status
       ORDER BY count DESC`,
      [userId]
    );
    // pg returns COUNT as a string (it can be a bigint); coerce to number.
    return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  }
}

// Row → domain mappings. Keep these as plain functions so the SQL-shape
// is contained to one file even if the domain shape changes later.

interface UserRow {
  id: string;
  password_hash: string;
  oauth_provider: string | null;
  created_at: Date;
}

function rowToUser(row: UserRow): User {
  return {
    _id: row.id,
    passwordHash: row.password_hash,
    oauthProvider: row.oauth_provider ?? undefined,
    createdAt: row.created_at,
  };
}

interface DocumentRow {
  id: string;
  user_id: string;
  filename: string;
  status: DocumentStatus;
  chunk_count: number;
  error_msg: string | null;
  uploaded_at: Date;
  updated_at: Date;
}

function rowToDocument(row: DocumentRow): Document {
  return {
    _id: row.id,
    userId: row.user_id,
    filename: row.filename,
    status: row.status,
    chunkCount: row.chunk_count,
    errorMsg: row.error_msg ?? undefined,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
  };
}
