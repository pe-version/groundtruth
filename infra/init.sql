-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks table: stores embedded text chunks with their vectors
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL,   -- owner; enforces tenant isolation at the storage layer
    document_id TEXT        NOT NULL,   -- matches MongoDB document _id
    content     TEXT        NOT NULL,
    chunk_index INT         NOT NULL,
    embedding   vector(384),            -- MUST match EMBED_DIM in packages/shared/src/embedding.ts
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast nearest-neighbor search (cosine distance)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Unique constraint to prevent duplicate chunks
ALTER TABLE chunks ADD CONSTRAINT chunks_document_chunk_unique
    UNIQUE (document_id, chunk_index);

-- Compound index for user-scoped lookups
CREATE INDEX IF NOT EXISTS chunks_user_document_idx ON chunks (user_id, document_id);

-- ── Job queue ───────────────────────────────────────────────────────────────
-- Replaces Kafka for the upload→processing signal. SELECT FOR UPDATE SKIP
-- LOCKED gives us multi-worker parallelism with no broker, no extra
-- infrastructure, and crash-safe lock recovery.
--
-- A job is in one of four states:
--   pending     — waiting for a worker
--   processing  — claimed by some worker; locked_at/locked_by tell which
--   completed   — kept briefly as an audit trail; janitor reaps old rows
--   failed      — the post-mortem record; equivalent to a DLQ entry
CREATE TABLE IF NOT EXISTS document_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   TEXT        NOT NULL,
    user_id       TEXT        NOT NULL,
    filename      TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'pending',
    attempts      INT         NOT NULL DEFAULT 0,
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index: fetchOne() scans only pending or stale-processing rows,
-- so a partial index is both smaller than a full one and lets the planner
-- skip completed/failed rows entirely.
CREATE INDEX IF NOT EXISTS document_jobs_claimable_idx
    ON document_jobs (created_at)
    WHERE status = 'pending' OR status = 'processing';

-- ── Refresh tokens ──────────────────────────────────────────────────────────
-- Stores hashed refresh tokens so revocation = deleting the row. Access
-- tokens stay stateless and short-lived (15 min); the ONLY state the server
-- keeps for auth lives here. We hash the token (SHA-256) so a leaked DB
-- dump doesn't hand the attacker live sessions.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash  TEXT        PRIMARY KEY,
    user_id     TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
    ON refresh_tokens (user_id);

-- Lets a periodic janitor drop expired rows in O(log n).
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx
    ON refresh_tokens (expires_at);

-- ── Users ───────────────────────────────────────────────────────────────────
-- Replaces the MongoDB users collection. The id is the canonical user
-- identifier (the username for credentials accounts, or "provider:id" for
-- OAuth-provisioned accounts when that flow comes back). password_hash is
-- empty for OAuth users — argon2.verify on an empty string returns false,
-- so /auth/login is categorically closed to them.
CREATE TABLE IF NOT EXISTS users (
    id              TEXT        PRIMARY KEY,
    password_hash   TEXT        NOT NULL DEFAULT '',
    oauth_provider  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Documents ───────────────────────────────────────────────────────────────
-- Replaces the MongoDB documents collection. Primary key is the upload UUID
-- so it can be referenced from the chunks and document_jobs tables without
-- a synthetic surrogate key.
CREATE TABLE IF NOT EXISTS documents (
    id            TEXT        PRIMARY KEY,
    user_id       TEXT        NOT NULL,
    filename      TEXT        NOT NULL,
    status        TEXT        NOT NULL,
    chunk_count   INT         NOT NULL DEFAULT 0,
    error_msg     TEXT,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list-by-user query is the hot path; ORDER BY uploaded_at DESC is the
-- canonical view shape. Reverse-order index avoids a sort.
CREATE INDEX IF NOT EXISTS documents_user_uploaded_idx
    ON documents (user_id, uploaded_at DESC);

-- Janitor scans for stuck pending/processing rows older than a threshold —
-- partial index keeps that query cheap even if the table grows large.
CREATE INDEX IF NOT EXISTS documents_stuck_idx
    ON documents (updated_at)
    WHERE status IN ('pending', 'processing');
