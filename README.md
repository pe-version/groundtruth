# Groundtruth — Document Q&A with RAG

A document Q&A platform. Upload PDFs, ask questions, get answers grounded in the source text.

*Built via Claude-augmented development.*

## Design philosophy

The simplest stack that demonstrates the architecture. Every external dependency, broker, and library is something a senior reviewer can ask "why?" about — and every answer should be substantive. This README leads with the decisions, not the features.

```
┌─────────────────┐
│  Next.js (3000) │  — Upload, document library, chat UI
└────────┬────────┘
         │ REST + JWT (15-min access) + httpOnly refresh cookie
┌────────▼────────┐
│  Fastify (8080) │  — Auth, rate limiting, file handling, RAG query
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│  TS Consumer        │  — claims jobs via SELECT FOR UPDATE SKIP LOCKED
└────────┬────────────┘    extract → chunk → embed (local) → index
         │
         ▼
┌──────────────────────────────────────────────┐
│  Postgres + pgvector  (single instance)      │
│  • users, documents          (metadata)      │
│  • document_jobs             (queue)         │
│  • refresh_tokens            (auth state)    │
│  • chunks vector(384)        (embeddings)    │
└──────────────────────────────────────────────┘
```

## Stack

| Layer | Tech | Why this and not the obvious-bigger choice |
|---|---|---|
| Frontend | Next.js 14, TypeScript, Tailwind | — |
| API | Node.js, Fastify, TypeScript | Lightest fast HTTP framework with Schema validation built in |
| Consumer | Node.js, TypeScript | Same toolchain as the API, no extra runtime |
| LLM | Anthropic Claude (`claude-sonnet-4-6`) via an `LlmProvider` interface | Provider is one swap point; replacement is a new class, not a refactor |
| Embeddings | `@xenova/transformers` + `bge-small-en-v1.5` (384 dims, local) | No paid API key, no per-token cost, no third-party CVE feed on the hot path |
| PDF extraction | `unpdf` (pdf.js wrapper) | Maintained, ESM, no native deps; replaces `pdf-parse` |
| Message broker | None — Postgres `SELECT FOR UPDATE SKIP LOCKED` | One fewer container; Postgres is already in the stack |
| Vector store | Postgres + pgvector | Already running for the queue; no extra DB |
| Document metadata | Postgres `documents` + `users` tables | One database; the dashboard's "aggregation pipeline" is a single GROUP BY |
| Auth | argon2id passwords + 15-min access JWT (jose) + 30-day rotating refresh tokens (Postgres) | No NextAuth, no `jsonwebtoken`, no denylist; revocation is a row delete |

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Anthropic API key

### 1. Clone and configure

```bash
git clone https://github.com/pe-version/groundtruth
cd groundtruth
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY and JWT_SECRET ($(openssl rand -base64 32)).
```

### 2. Start infrastructure

```bash
docker compose up -d postgres
# Postgres has a healthcheck; dependents wait on it automatically.
```

### 3. Install dependencies

```bash
npm install
npm run build -w @groundtruth/shared
```

### 4. Run the services

```bash
npm run dev:api        # terminal 1
npm run dev:consumer   # terminal 2
npm run dev:frontend   # terminal 3
```

Open [http://localhost:3000](http://localhost:3000).

The first time the consumer processes a document it will download the embedding model (~33 MB, cached afterwards under `~/.cache/transformers.js/`).

### Run everything in Docker

```bash
docker compose up --build
```

## Project Structure

```
groundtruth/
├── packages/shared/                  # Shared TypeScript package
│   └── src/
│       ├── types.ts                  # Document, User, Chunk types
│       ├── config.ts                 # Zod-validated env config
│       ├── logger.ts                 # Shared pino structured logger factory
│       ├── metadata-store.ts        # Postgres-backed users + documents store
│       ├── vector-store.ts           # pgvector client (insert, search, delete)
│       ├── embedding.ts              # Local transformers.js embeddings
│       ├── job-queue.ts              # Postgres SKIP LOCKED queue (replaces Kafka)
│       ├── refresh-tokens.ts         # Hashed refresh-token store
│       ├── storage.ts                # Single source of truth for upload paths
│       ├── validation.ts             # Shared UUID_REGEX
│       └── index.ts                  # Barrel export
│
├── api/                              # Fastify HTTP API
│   └── src/
│       ├── index.ts                  # Server entrypoint, plugin registration
│       ├── types.d.ts                # Fastify type augmentation
│       ├── routes/
│       │   ├── auth.ts               # Register / login / refresh / logout
│       │   ├── documents.ts          # Upload, list, get, delete (ownership checks)
│       │   ├── query.ts              # RAG query (embed → search → LLM, SSE)
│       │   ├── dashboard.ts          # Per-user stats
│       │   └── health.ts             # Health check
│       └── services/
│           ├── llm.ts                # LlmProvider interface
│           ├── anthropic.ts          # AnthropicProvider (default impl)
│           ├── jwt.ts                # jose-backed JwtService
│           └── janitor.ts            # Periodic cleanup of orphaned uploads + vectors
│
├── consumer/                         # Job-queue worker
│   └── src/
│       ├── index.ts                  # Poll loop + graceful shutdown
│       ├── handle-job.ts             # Per-job handler (success → complete; fail → mark)
│       ├── processor.ts              # Pipeline: extract → chunk → embed → index
│       └── pdf-extract.ts            # PDF text extraction (unpdf)
│
├── frontend/                         # Next.js app
│   ├── app/
│   │   ├── login/page.tsx            # Sign-in form
│   │   ├── register/page.tsx         # Account creation form
│   │   ├── upload/page.tsx           # Drag-and-drop upload
│   │   ├── documents/page.tsx        # Document library with status polling
│   │   ├── chat/page.tsx             # Chat with markdown + source excerpts
│   │   └── dashboard/page.tsx        # Per-user stats
│   ├── components/nav.tsx            # Shared nav bar
│   └── lib/
│       ├── api.ts                    # Typed API client + silent refresh on 401
│       └── auth-provider.tsx         # Auth context (no NextAuth)
│
├── infra/init.sql                    # pgvector + jobs + refresh_tokens schema
├── docker-compose.yml
├── .env.example
├── tsconfig.base.json
└── package.json                      # Workspace root
```

## Decision records

These are the choices a reviewer or interviewer is most likely to probe. Each one is here as evidence that an obvious-bigger option was considered and rejected on substance.

### ADR: No Kafka — Postgres job queue

**Decision:** Document-processing jobs are stored as rows in `document_jobs` and claimed via `SELECT … FOR UPDATE SKIP LOCKED`. No Kafka, no ZooKeeper, no Redpanda.

**Why not Kafka.** This system has one producer (the API) and one consumer group (the worker). Kafka's strengths — partitioned logs, replay, multi-consumer fan-out, durability under broker failures — solve problems we don't have. Running a broker for one queue with one reader is the textbook over-engineering signal a senior reviewer flags first.

**Why not Redpanda.** Same problem as Kafka here: the abstraction is heavier than the workload deserves. Redpanda is a great Kafka replacement when you've already decided you need Kafka semantics.

**What Postgres gives us.** Postgres is already in the stack for pgvector. The queue is a single table:

```sql
CREATE TABLE document_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id TEXT, user_id TEXT, filename TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
    attempts INT NOT NULL DEFAULT 0,
    locked_at TIMESTAMPTZ, locked_by TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

The consumer's claim is one statement:

```sql
UPDATE document_jobs
SET status='processing', locked_at=NOW(), locked_by=$1, attempts=attempts+1
WHERE id = (
  SELECT id FROM document_jobs
  WHERE status='pending'
     OR (status='processing' AND locked_at < NOW() - $2 * INTERVAL '1 ms')
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING ...;
```

`SKIP LOCKED` lets N workers run in parallel without coordination. A worker that crashes mid-job leaves a `processing` row with a stale `locked_at`, which any other worker reclaims after the staleness threshold (default 5 minutes).

**Failed jobs ARE the DLQ.** A failed row stays in the table with `status='failed'` and `error_message` populated. Inspection is `SELECT * FROM document_jobs WHERE status='failed'` — operators don't need a separate Kafka topic to peek at the post-mortem.

**When this would not be the right call.** Multiple independent consumer groups, replay-as-feature, multi-thousand events/sec sustained, or a hard requirement to keep the broker outside the database. None of those apply here.

### ADR: Local embeddings — no OpenAI

**Decision:** Embed text in-process with `@xenova/transformers` running `Xenova/bge-small-en-v1.5` (384 dims). No OpenAI dependency, no API key, no per-token cost, no network on the hot path.

**Why.** OpenAI's `text-embedding-3-small` is a fine model, but it's also the path-of-least-resistance choice. For this workload it added: a paid API key, an SDK with its own CVE feed, network latency on every chunk, and a vendor lock-in for an undifferentiated capability. `bge-small-en-v1.5` is ~33 MB quantized, runs CPU-only, and is competitive on the BEIR retrieval benchmark with much larger commercial models.

**Cost.** First-time download of ~33 MB to `~/.cache/transformers.js/`, ~250 MB resident memory while the consumer runs, ~30–80 ms per chunk on a modern laptop CPU. No GPU required.

**Schema coupling.** The pgvector column is declared `vector(384)`; `EMBED_DIM` in `packages/shared/src/embedding.ts` must match. Changing the model means re-embedding every document, so the model name and dim are pinned alongside the schema.

**LLM is still hosted.** Generation quality matters more than embedding quality for grounded Q&A — Claude's prose is hard to match locally without a 7B+ model and a GPU. The `LlmProvider` interface keeps the swap point clean if that calculation changes.

### ADR: No denylist — short access tokens + rotating refresh tokens

**Decision:** Access tokens are 15-minute JWTs (jose, HS256). Refresh tokens are 30-day random secrets, hashed with SHA-256 and stored in Postgres. Revocation = `DELETE` on the row. No per-request lookup, no separate denylist store.

**Why not a denylist.** A denylist defeats the only thing a stateless JWT is good for (zero per-request DB lookup). The right answer is short access tokens + rotating refresh tokens, not a denylist of any kind.

**What this design gives us.**
- Stateless access path: every authenticated request verifies the JWT signature locally; no auth lookup.
- Revocation horizon ≤ 15 minutes (the access TTL), with no per-request cost.
- Refresh-token rotation: every `/auth/refresh` deletes the presented token before issuing a new one. A replayed refresh token (e.g., stolen) hits a 401 the second time it's used; the legitimate session continues.
- Stored hashes, not cleartext: a leaked DB dump cannot be used to mint new access tokens.

**OAuth deferred.** The previous build had GitHub OAuth via NextAuth + a server-to-server `/auth/oauth-token` endpoint with a shared secret. That was removed for this iteration to keep the auth surface tight. Re-adding OAuth would mean a small handwritten OAuth client (no NextAuth) and a separate provisioning path that issues the same access+refresh pair. See Production Readiness.

### ADR: LLM provider abstraction

**Decision:** The query route calls `fastify.llm.streamAnswer({systemPrompt, userPrompt})`. The implementation is `AnthropicProvider`. The interface is deliberately narrow — text streaming only, no function calling or vision — because every additional capability widens what we'd have to keep consistent across providers.

**Why bother.** Dropping the OpenAI embeddings dependency removed one vendor; keeping all of Claude's surface accessible only through one concrete class would defeat the lesson. The abstraction is one file (`api/src/services/llm.ts`) and exists so a future swap to Ollama, llama.cpp, or a different hosted vendor is a new class implementation, not a route refactor.

## Authentication

Auth is plain credentials + JWTs against Fastify-issued tokens.

**Flow:**
1. `POST /api/auth/register` or `POST /api/auth/login` — returns `{ token, userId }` and sets two cookies:
   - `groundtruth_token` (httpOnly, 15-min) — the access JWT
   - `groundtruth_refresh` (httpOnly, 30-day, path scoped to `/api/auth`) — the refresh secret
2. The frontend mirrors the access token into module-local state so it can also send `Authorization: Bearer …` (cookies are the browser-only path; the header path is what curl and the smoke test use).
3. On any 401, the API client calls `POST /api/auth/refresh` once and retries. If the refresh fails, the user is bounced to `/login`.
4. `POST /api/auth/logout` revokes the presented refresh token and clears both cookies.

**Endpoints:**
- `POST /api/auth/register` — create account (8+ char password, argon2id, 5 req/min)
- `POST /api/auth/login` — validate credentials, receive access + refresh (10 req/min)
- `POST /api/auth/refresh` — rotate refresh, mint new access (30 req/min)
- `POST /api/auth/logout` — revoke refresh, clear cookies (30 req/min)
- All other `/api/*` routes (except `/health`) require a valid access JWT
- Documents, queries, and dashboard stats are scoped per user

## Job queue

| Status | Meaning |
|---|---|
| `pending` | waiting for a worker |
| `processing` | claimed by `locked_by`; `locked_at` says when |
| `completed` | success; kept briefly as audit trail |
| `failed` | `error_message` populated; equivalent to a DLQ entry |

Inspect failures: `SELECT id, document_id, error_message FROM document_jobs WHERE status='failed' ORDER BY updated_at DESC;`

Run multiple workers for parallel processing — each one calls `SKIP LOCKED` so they never block each other:
```bash
docker compose up --scale consumer=3
```

## Testing

```bash
npm test                              # runs shared + api + consumer (frontend has no test suite)
npm test -w groundtruth-api           # API tests only
npm test -w groundtruth-consumer      # Consumer tests only
```

A scripted smoke test that exercises the full HTTP path lives at `scripts/smoke-test.sh`:
```bash
scripts/smoke-test.sh path/to/some.pdf
```

## Production Readiness

The architecture is intentionally small, but several gaps remain before production. Listed by category.

### Auth & Identity
- **OAuth (e.g., GitHub).** Removed in this iteration. A small hand-rolled OAuth client (no NextAuth) plus a `provider:id` user row + the same refresh-token issuance path is the next step.
- **Password reset.** No recovery path. Requires email infrastructure (SMTP or transactional service).
- **Email verification.** Accounts are created without verifying the username is a real identity.
- **"Sign out everywhere".** `RefreshTokenStore.revokeAllForUser` is implemented but not exposed via an endpoint.

### Data & Storage
- **Stable user IDs.** Today `request.user.sub` is the lowercased username, used as the FK on documents/jobs. A future username change or OAuth merge silently orphans data — switch to immutable UUIDs.
- **File storage.** Uploaded PDFs are written to a local volume. Production = S3/GCS so the API and consumer can run on separate hosts.
- **Vector tombstoning.** Document deletion removes the `documents` row first, pgvector chunks second; a failure between them leaves stale vectors. Move to a single transaction or a janitor sweep.
- **Postgres split.** One Postgres carries both pgvector and the queue. If vector-query load grows enough to compete with queue locking, split them onto separate clusters with appropriate sizing.
- **Refresh-token janitor.** `pruneExpired()` exists but isn't invoked yet; wire it into the existing janitor loop.
- **Job audit retention.** Completed and failed rows accumulate; reap with a janitor sweep (e.g., delete completed > 7 days, failed > 30 days).

### Observability
- **Log aggregation.** Pino emits JSON; production needs a shipper (Vector / Fluent Bit) into Loki / Datadog / CloudWatch.
- **Metrics.** No application metrics. `fastify-metrics` would expose Prometheus counters for queue depth, embedding latency, LLM latency, error rates.
- **Distributed tracing.** No `traceparent` propagation today. OpenTelemetry across HTTP → queue → consumer would be the right shape.
- **Alerting.** Set thresholds on `failed` job count, oldest pending job age, and LLM error rate.

### Reliability
- **Idempotent upload.** Re-uploading the same PDF creates a duplicate document. Add a content hash and dedupe by `(hash, userId)`.
- **API timeouts.** Anthropic calls have a 60s timeout; embedding calls do not. Add `AbortController` timeouts to the embedding pipeline so a stuck inference doesn't pin a worker.
- **Health check depth.** `/health` returns 200 unconditionally. A deep check would probe Postgres connectivity so a load balancer can drop unhealthy instances.

### Security
- **CORS in production.** `CORS_ORIGINS` defaults to `http://localhost:3000`; production must set it to the exact production domain.
- **PDF blast radius.** unpdf wraps pdf.js, which is more robust than pdf-parse, but a malicious PDF can still consume CPU. Run the consumer with restricted resources (cgroups / k8s limits / seccomp).
- **Dependency audit.** Run `npm audit` before each deployment.
- **Secrets management.** Production should use a secrets manager (AWS Secrets Manager, HashiCorp Vault, Doppler) rather than baking `.env` into images.

### UX
- **Pagination.** Documents list is one query; add cursor-based pagination.
- **Multi-file upload.** Single-file at a time today.
- **Dark/light mode.** UI is hardcoded dark.
- **Accessibility.** Missing `aria-label`/`aria-live` on several interactive elements.

## Roadmap

- [x] Real PDF text extraction (unpdf, replacing pdf-parse)
- [x] Local embeddings (transformers.js + bge-small-en-v1.5)
- [x] Postgres job queue (replacing Kafka)
- [x] argon2id password hashing
- [x] jose-based JWT (replacing jsonwebtoken)
- [x] Rotating refresh tokens (no denylist, no NextAuth)
- [x] LLM provider abstraction (Anthropic default)
- [x] User isolation — per-user document scoping with ownership checks
- [x] Streaming LLM responses (SSE via `/api/query/stream`)
- [x] Multi-document queries
- [x] Token-aware chunking (js-tiktoken)
- [x] Dashboard with aggregation pipeline stats
- [ ] OAuth (GitHub) — hand-rolled, no NextAuth
- [ ] Conversation persistence (Postgres `conversations` table)
- [ ] File deduplication by content hash
- [ ] Object storage for uploaded PDFs (S3/GCS/R2)
- [ ] Prometheus metrics + Grafana dashboard
- [ ] Answer quality evals
