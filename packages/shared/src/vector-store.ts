import pg from "pg";
import pgvector from "pgvector/pg";
import type { Chunk } from "./types.js";

export class VectorStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(dsn: string): Promise<VectorStore> {
    const pool = new pg.Pool({ connectionString: dsn });
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
    documentId: string,
    chunkIndex: number,
    content: string,
    embedding: number[]
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO chunks (document_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [documentId, chunkIndex, content, pgvector.toSql(embedding)]
    );
  }

  async similarChunks(
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
         WHERE document_id = $2
         ORDER BY embedding <=> $1
         LIMIT $3`,
        [vec, documentId, topK]
      );
      return rows;
    }

    const { rows } = await this.pool.query(
      `SELECT id, document_id AS "documentId", content, chunk_index AS "chunkIndex",
              1 - (embedding <=> $1) AS score
       FROM chunks
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [vec, topK]
    );
    return rows;
  }

  async deleteChunks(documentId: string): Promise<void> {
    await this.pool.query("DELETE FROM chunks WHERE document_id = $1", [
      documentId,
    ]);
  }
}
