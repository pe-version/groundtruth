# Groundtruth

Document Q&A. Upload PDFs, ask questions, get answers grounded in the source text.

*Built via Claude-augmented development.*

## Architecture

```
┌─────────────────┐
│  Next.js (3000) │  upload, library, chat
└────────┬────────┘
         │ REST + 15-min JWT, httpOnly refresh cookie
┌────────▼────────┐
│  Fastify (8080) │  auth, rate limiting, file handling, RAG query
└────────┬────────┘
         │ enqueue
         ▼
┌─────────────────────┐
│  Consumer worker    │  claims jobs via SELECT FOR UPDATE SKIP LOCKED
└────────┬────────────┘  extract → chunk → embed → index
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

| Layer | Choice |
|---|---|
| Frontend | Next.js 14, TypeScript, Tailwind |
| API | Fastify on Node 20, TypeScript |
| Consumer | Node 20, TypeScript |
| LLM | Anthropic Claude (`claude-sonnet-4-6`) behind an `LlmProvider` seam |
| Embeddings | `@xenova/transformers` running `bge-small-en-v1.5` (384 dims, in-process) |
| PDF | `unpdf` (pdf.js wrapper) |
| Storage | Postgres + pgvector (one instance: metadata, queue, refresh tokens, chunks) |
| Auth | argon2id passwords, jose-signed access JWTs, rotating refresh tokens stored as SHA-256 hashes |
| Observability | Prometheus-format `/metrics` on each process; opt-in Grafana dashboard |

## Quick Start

You need Docker, Node 20, and an Anthropic API key.

```bash
git clone https://github.com/pe-version/groundtruth
cd groundtruth
cp .env.example .env
# Set ANTHROPIC_API_KEY and JWT_SECRET (use `openssl rand -base64 32` for the latter).

docker compose up -d postgres
npm install
npm run build -w @groundtruth/shared

# Three terminals:
npm run dev:api
npm run dev:consumer
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000).

The consumer downloads the embedding model (~33 MB) on its first job and caches it under `~/.cache/transformers.js/`.

To run the whole stack in containers: `docker compose up --build`.

## Project layout

```
packages/shared/        domain types, config, logger
  src/metadata-store.ts users + documents (Postgres)
  src/job-queue.ts      SKIP LOCKED queue with retry/backoff
  src/refresh-tokens.ts atomic rotation + replay detection
  src/vector-store.ts   pgvector client
  src/embedding.ts      transformers.js wrapper

api/src/                Fastify HTTP API
  routes/auth.ts        register/login/refresh/logout
  routes/documents.ts   upload, list, get, delete
  routes/query.ts       RAG (embed → search → LLM, SSE streaming)
  routes/dashboard.ts   per-user counts
  routes/health.ts      Postgres-deep health probe
  services/jwt.ts       jose-backed JwtService
  services/llm.ts       LlmProvider interface
  services/anthropic.ts AnthropicProvider
  services/metrics.ts   prom-client registry, Fastify hook, queue gauges
  services/janitor.ts   periodic file/chunk/doc reconciliation

consumer/src/           job worker
  index.ts              poll loop, heartbeat, metrics server
  handle-job.ts         per-job orchestration
  processor.ts          extract → chunk → embed → index pipeline
  pdf-extract.ts        unpdf wrapper
  metrics.ts            embed/job histograms + http://:9091/metrics

frontend/               Next.js app
  app/login,register,documents,upload,chat,dashboard
  lib/api.ts            typed client with silent /auth/refresh on 401
  lib/auth-provider.tsx context, no NextAuth

infra/init.sql          schema (chunks, document_jobs, users, documents,
                        refresh_tokens, consumed_refresh_tokens)
infra/prometheus/       scrape config (observability profile)
infra/grafana/          provisioned datasource + dashboard JSON
scripts/                smoke test, fixture seeder
```

## Auth

Credentials only. Access tokens are 15-minute JWTs (jose, HS256). Refresh tokens are 30-day random secrets stored as SHA-256 hashes.

Rotation is atomic. `/auth/refresh` runs a single CTE that moves the row from `refresh_tokens` to `consumed_refresh_tokens` in one statement, so two concurrent calls racing the same cookie can't both succeed. If a hash shows up on a second consume — present in the consumed table, absent from the live one — that's a replay. The handler revokes every refresh token for that user and forces the legitimate session to sign in again. Painful, but the correct response to a refresh secret existing in two places.

Login runs an argon2 verify on every request: against the user's hash if they exist, against a precomputed sentinel hash if they don't. Both paths take the same wall-clock time, so response timing doesn't enumerate usernames.

Endpoints:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | argon2id, 8+ char password, 5/min |
| POST | `/api/auth/login` | constant-time-ish, 10/min |
| POST | `/api/auth/refresh` | atomic rotation, replay → revoke-all, 30/min |
| POST | `/api/auth/logout` | revokes presented refresh, clears cookies, 30/min |

All other `/api/*` routes (except `/health`) require a valid access JWT.

## Job queue

`document_jobs` is a Postgres table; the consumer claims rows with `SELECT … FOR UPDATE SKIP LOCKED`. A Kafka broker for one producer and one consumer group wasn't worth the second piece of infrastructure — SKIP LOCKED gives the same parallel-claim semantics, inspection is plain SQL, and the throughput ceiling is Postgres rather than a partitioned log. That's a fine ceiling for document ingest. It's the wrong choice for an event firehose; if this project ever became one, Kafka would come back.

A row is in one of four states: `pending`, `processing`, `completed`, `failed`. The "DLQ" is the `failed` rows on the same table — operators triage with `SELECT * FROM document_jobs WHERE status='failed' ORDER BY updated_at DESC`.

Failures split into two paths:

- **Permanent** (default): the doc is unparseable, has no extractable text, or the error is otherwise content-shaped. The row terminates as `failed` immediately.
- **Transient**: classified by the consumer (AbortError from a stage timeout, ECONNRESET, ETIMEDOUT, etc.). The row goes back to `pending` with `run_after = NOW() + 2^attempts seconds`, up to `max_attempts`. On the last attempt or for permanent errors, it terminates.

Long-but-progressing jobs aren't mistaken for stuck. The consumer heartbeats every 30 s during a job, refreshing `locked_at`. Stale-lock recovery only fires on rows whose `locked_at` is older than 5 minutes.

To run multiple workers: `docker compose up --scale consumer=3`. SKIP LOCKED handles the rest.

## Embeddings

`bge-small-en-v1.5` runs in-process via `@xenova/transformers` — 384 dims, ~33 MB quantized, CPU-only. The pgvector column is declared `vector(384)`; `EMBED_DIM` in `packages/shared/src/embedding.ts` has to agree, and changing the model means re-embedding everything.

Generation quality matters more than embedding quality for grounded Q&A, so Claude is still hosted. Embeddings are an undifferentiated capability, and dropping the OpenAI dependency removed a paid API key, an SDK, and a third-party network hop on every chunk. The cost is a ~33 MB cold-start download (cached afterwards) and ~250 MB resident while the consumer is up.

## LLM provider seam

`api/src/services/llm.ts` defines a small interface — one method, `streamAnswer({systemPrompt, userPrompt})`. `AnthropicProvider` implements it; `routes/query.ts` only knows the interface.

The seam earns its keep through tests. `routes.test.ts` injects a stub provider that yields fixed text, so the query route's tests don't need an Anthropic API key and don't exercise streaming behavior they aren't testing. If Anthropic's API never changed shape again, the abstraction would still be worth keeping for that reason alone.

A swap to a different provider — Ollama, OpenAI, a local model — would be a new class implementing the same interface. That's a side benefit, not the motivation. Introducing the abstraction speculatively for a vendor swap that may never happen would have been over-engineering.

## Observability

Both processes expose Prometheus-format metrics:

- API on `:8080/metrics`: HTTP request duration (labeled by route pattern), queue depth, oldest pending age, terminal-failed count, and an auth event counter labeled by event (login/refresh) and outcome (success/failure/replay/missing).
- Consumer on `:9091/metrics`: per-call embed duration, per-job duration histogram, and a jobs-handled counter — all labeled by outcome.

Prometheus and Grafana are an opt-in compose profile so the base stack stays lean:

```bash
docker compose --profile observability up
```

Grafana auto-provisions the Prometheus datasource and loads `infra/grafana/dashboards/groundtruth.json`. The dashboard has seven panels: queue depth, oldest pending age, failed count, jobs by outcome (rate), embed p50/p95, API request latency p95 by route, and auth events. Default Grafana login is anonymous viewer, or `admin` / `admin`.

## Testing

```bash
npm test                                          # all unit tests across workspaces
npm test -w groundtruth-api                       # API only
npm test -w groundtruth-consumer                  # consumer only
npm run test:integration -w groundtruth-consumer  # testcontainers + real Postgres
```

The integration test boots a `pgvector/pgvector:pg16` container with `infra/init.sql` loaded, connects the live `MetadataStore` / `VectorStore` / `JobQueue`, generates a synthetic PDF with `pdfkit`, runs the full processor pipeline, and asserts similarity search returns a chunk with the seeded distinctive phrase. Two more specs cover the queue's enqueue/fetch/complete lifecycle and the retry-exhaustion path. Excluded from the default run because it needs Docker.

End-to-end smoke test:

```bash
scripts/smoke-test.sh path/to/document.pdf
```

Runs register → upload → poll-for-ready → query → broken-PDF rejection → cross-user isolation against a running stack. Uses `python3` for JSON parsing (no `jq` dependency).

A demo seed script is in `scripts/seed-fixtures.sh` — it downloads a couple of public-domain PDFs into `test-fixtures/` for the smoke test or for clicking around the UI.

## Production Readiness

What's missing for a real production deployment. Each item is a known gap, not a TODO masquerading as documentation.

**Auth & identity**

- OAuth (e.g., GitHub). Credentials-only today; re-adding it means a hand-rolled OAuth client and a separate provisioning path that issues the same access+refresh pair.
- Stable user IDs. Today `request.user.sub` is the lowercased username, which doubles as the FK on documents/jobs. A username change or OAuth merge silently orphans data; switching to immutable UUIDs fixes that.

**Data & storage**

- Object storage for uploads (S3/GCS/R2) so the API and consumer can run on separate hosts.
- Two-phase delete for documents: today the metadata row goes first, pgvector chunks second. A failure between the two leaves stale vectors; the janitor reaps them, but a single transaction is the right fix.

**Reliability**

- Bake the embedding model into the consumer image. Today it downloads from the HuggingFace CDN on first job — a third-party hot-path dependency.
- Idempotent upload. Re-uploading the same PDF creates a duplicate document; dedupe by `(content_hash, user_id)`.
- Sandbox the PDF parser. `unpdf` is more robust than `pdf-parse`, but pdf.js can still pin a CPU on a malicious document. Worth a separate container with cgroup / seccomp limits in production.

**Security**

- CSRF defense. The auth middleware accepts both `Authorization: Bearer` and the cookie. `sameSite: strict` is enough today; the moment that gets relaxed for SSO, every state-changing route is exposed via the cookie path. Pick one transport, or add a double-submit CSRF token.
- Rate limits are per-IP only. Login limit (10/min/IP) is weak against distributed brute-force; want per-username + per-IP with backoff.
- HS256 with a shared secret is fine for a monolith; an RS256/EdDSA key pair is the right move once a second verifier exists.
