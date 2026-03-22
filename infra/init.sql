-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks table: stores embedded text chunks with their vectors
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id TEXT        NOT NULL,   -- matches MongoDB document _id
    content     TEXT        NOT NULL,
    chunk_index INT         NOT NULL,
    embedding   vector(1536),           -- OpenAI text-embedding-3-small dimension
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast nearest-neighbor search (cosine distance)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Unique constraint to prevent duplicate chunks
ALTER TABLE chunks ADD CONSTRAINT chunks_document_chunk_unique
    UNIQUE (document_id, chunk_index);

-- Index for lookups by document
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);
