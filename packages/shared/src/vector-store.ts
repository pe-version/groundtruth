import pg from "pg";
import pgvector from "pgvector/pg";
import type { Chunk } from "./types.js";

export class VectorStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(dsn: string): Promise<VectorStore> {
    const pool = new pg.Pool({
      connectionString: dsn,
      // Bound every stage of the connection lifecycle. Without these a stalled
      // Postgres or a broken network path hangs request handlers forever.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
    });
    // Per-session 10s statement timeout — caps any single query. Set on each
    // connection as it enters the pool so pool-recycled connections stay bounded.
    pool.on("connect", (c) => {
      c.query("SET statement_timeout = 10000").catch(() => {});
    });
    const client = await pool.connect();
    try {
      await pgvector.registerType(client);
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    return new VectorStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async insertChunk(
    userId: string,
    documentId: string,
    chunkIndex: number,
    content: string,
    embedding: number[]
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO chunks (user_id, document_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [userId, documentId, chunkIndex, content, pgvector.toSql(embedding)]
    );
  }

  async similarChunks(
    userId: string,
    documentId: string | null,
    queryEmbedding: number[],
    topK: number
  ): Promise<Chunk[]> {
    const vec = pgvector.toSql(queryEmbedding);

    if (documentId) {
      const { rows } = await this.pool.query(
        `SELECT id, document_id AS "documentId", content, chunk_index AS "chunkIndex",
                1 - (embedding <=> $1) AS score
         FROM chunks
         WHERE user_id = $2 AND document_id = $3
         ORDER BY embedding <=> $1
         LIMIT $4`,
        [vec, userId, documentId, topK]
      );
      return rows;
    }

    const { rows } = await this.pool.query(
      `SELECT id, document_id AS "documentId", content, chunk_index AS "chunkIndex",
              1 - (embedding <=> $1) AS score
       FROM chunks
       WHERE user_id = $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [vec, userId, topK]
    );
    return rows;
  }

  async deleteChunks(userId: string, documentId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM chunks WHERE user_id = $1 AND document_id = $2",
      [userId, documentId]
    );
  }

  // Janitor support: list distinct document_ids with chunks. The janitor
  // cross-references this with Mongo to find orphaned chunks (document was
  // deleted but chunk cleanup didn't complete).
  async listAllDocumentIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ document_id: string }>(
      "SELECT DISTINCT document_id FROM chunks"
    );
    return rows.map((r) => r.document_id);
  }

  async deleteOrphanChunks(documentId: string): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM chunks WHERE document_id = $1",
      [documentId]
    );
    return result.rowCount ?? 0;
  }
}
