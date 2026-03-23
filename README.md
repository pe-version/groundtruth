# Direze — Document Q&A with RAG

A production-architecture document Q&A platform. Upload PDFs, ask questions, get answers grounded in the source text.

## Architecture

```
┌─────────────────┐
│  Next.js (3000) │  — Upload, document library, chat UI
└────────┬────────┘
         │ REST + JWT
┌────────▼────────┐
│  Fastify (8080) │  — Auth, rate limiting, file handling, RAG query
└──┬──────────┬───┘
   │ Kafka    │ pgvector
   │ publish  │ similarity search
   ▼          ▼
┌──────────┐  ┌─────────────────────┐
│  Kafka   │  │  Postgres + pgvector│  — vector embeddings
│ raw-docs │  └─────────────────────┘
└────┬─────┘
     │ consume
┌────▼──────────────────┐
│  TS Consumer          │  — extract PDF → chunk → embed → index
└──┬────────────────┬───┘
   │ status update  │ upsert vectors
   ▼                ▼
┌──────────┐  ┌─────────────────────┐
│  MongoDB │  │  Postgres + pgvector│
│ metadata │  │  embeddings         │
└──────────┘  └─────────────────────┘
```

**Key architectural decisions:**
- Full TypeScript monorepo with shared types and clients
- JWT authentication with bcrypt password hashing and httpOnly cookies
- Users stored in MongoDB (`users` collection) — persistent across restarts, no in-memory state
- GitHub OAuth via NextAuth.js — users auto-provisioned on first login; no password required
- Security headers via `@fastify/helmet`
- User isolation — documents and queries are scoped per user with ownership checks
- Rate limiting (100 req/min general, 20 req/min for LLM queries, 10 req/min for uploads, 5 req/min for registration)
- Input validation via Fastify JSON Schema (UUID format, body size limits)
- Upload returns immediately (202 Accepted) — all processing is async through Kafka
- Consumer uses p-limit for concurrent embedding calls with backpressure
- File path validation in consumer to prevent path traversal
- Real PDF text extraction via pdf-parse
- pgvector for vector storage — no external vector DB required
- MongoDB stores document metadata + status; aggregation pipelines power the dashboard
- Consumer commits Kafka offsets only after successful processing (at-least-once semantics)
- Streaming SSE responses with error handling for real-time LLM output in the chat UI
- Multi-document queries — search across all documents when no specific document is selected
- Token-aware chunking via js-tiktoken (cl100k_base, matching the embedding model)
- Dead letter queue (`raw-docs-dlq`) with persistent retry tracking before sending to DLQ
- Route protection via Next.js middleware — unauthenticated users redirected to `/login`
- Dashboard page with aggregation pipeline stats and visual status bar
- Anthropic Claude for LLM answers, OpenAI for embeddings

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 14, TypeScript, Tailwind |
| API | Node.js, Fastify, TypeScript |
| Consumer | Node.js, KafkaJS, TypeScript |
| LLM | Anthropic Claude (claude-sonnet-4-20250514) |
| Embeddings | OpenAI text-embedding-3-small |
| Message broker | Apache Kafka |
| Vector store | Postgres + pgvector extension |
| Document metadata | MongoDB |
| Auth | JWT (HS256) + NextAuth.js + optional GitHub OAuth |

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Anthropic API key
- OpenAI API key (for embeddings)

### 1. Clone and configure

```bash
git clone https://github.com/yourname/direze
cd direze
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY, OPENAI_API_KEY, and JWT_SECRET
```

### 2. Start infrastructure

```bash
docker-compose up -d zookeeper kafka mongo postgres
# Wait ~15s for Kafka to be ready
```

### 3. Install dependencies

```bash
npm install
npm run build -w @direze/shared
```

### 4. Run the API

```bash
npm run dev:api
```

### 5. Run the consumer

```bash
npm run dev:consumer
```

### 6. Run the frontend

```bash
npm run dev:frontend
```

Open [http://localhost:3000](http://localhost:3000).

### Run everything with Docker Compose

```bash
docker-compose up --build
```

## Project Structure

```
direze/
├── packages/shared/                  # Shared TypeScript package
│   └── src/
│       ├── types.ts                  # Document, User, Chunk, event interfaces
│       ├── config.ts                 # Zod-validated environment config
│       ├── mongo.ts                  # MongoDB client (documents + users)
│       ├── vector-store.ts           # pgvector client (insert, search, delete)
│       ├── embedding.ts              # OpenAI embedding client (DRY)
│       ├── validation.ts             # Shared UUID_REGEX (DRY across routes)
│       └── index.ts                  # Barrel export
│
├── api/                              # Fastify HTTP API
│   └── src/
│       ├── index.ts                  # Server entrypoint, plugin registration
│       ├── types.d.ts                # Fastify type augmentation (typed decorators)
│       ├── routes/
│       │   ├── auth.ts               # Register + login (bcrypt, MongoDB-backed)
│       │   ├── documents.ts          # Upload, list, get, delete (ownership checks)
│       │   ├── query.ts              # RAG query (embed → search → Claude, SSE)
│       │   ├── dashboard.ts          # Per-user stats (aggregation pipeline)
│       │   └── health.ts             # Health check
│       └── services/
│           ├── anthropic.ts          # Claude chat completion
│           └── kafka-producer.ts     # KafkaJS producer
│
├── consumer/                         # Kafka consumer
│   └── src/
│       ├── index.ts                  # Consumer entrypoint + heartbeat + graceful shutdown
│       ├── processor.ts              # Pipeline: extract → chunk → embed → index
│       └── pdf-extract.ts            # PDF text extraction (pdf-parse)
│
├── frontend/                         # Next.js app
│   ├── middleware.ts                 # Route protection — redirects unauthenticated users
│   ├── app/
│   │   ├── login/page.tsx            # Sign-in form (credentials or GitHub OAuth)
│   │   ├── register/page.tsx         # Account creation form
│   │   ├── upload/page.tsx           # Drag-and-drop upload
│   │   ├── documents/page.tsx        # Document library with status polling
│   │   ├── chat/page.tsx             # Chat interface with markdown + source excerpts
│   │   └── api/auth/[...nextauth]/   # NextAuth handler (credentials + GitHub)
│   ├── components/nav.tsx            # Shared nav bar with sign-out
│   └── lib/
│       ├── api.ts                    # Typed API client (httpOnly cookie + Bearer token)
│       └── auth-provider.tsx         # SessionProvider + token sync to API client
│
├── infra/
│   └── init.sql                      # pgvector schema + unique chunk constraint
│
├── docker-compose.yml
├── .env.example
├── tsconfig.base.json
└── package.json                      # Workspace root
```

## Authentication

Auth uses a unified approach: the API issues JWTs (HS256) backed by MongoDB user storage, and the frontend session carries that same token. All API calls use it via `Authorization: Bearer` header plus an httpOnly cookie fallback.

**Credentials flow:**
1. User registers at `/register` → API hashes password (bcrypt, 10 rounds) and stores in MongoDB `users` collection
2. Login → API validates against hash, issues 1h JWT
3. NextAuth stores the token in its session; `AuthProvider` syncs it to the API client on every session change
4. Next.js `middleware.ts` redirects unauthenticated users to `/login` before any page renders

**GitHub OAuth flow (optional):**
1. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `OAUTH_PROVISION_SECRET` in `.env`
2. On first GitHub login, the NextAuth callback auto-provisions a MongoDB user using the GitHub user ID as the username
3. Subsequent logins re-authenticate against that provisioned account and receive a fresh API JWT

**Endpoints:**
- `POST /api/auth/register` — create account (min 8-char password, bcrypt, 5 req/min)
- `POST /api/auth/login` — validate credentials, receive JWT (10 req/min)
- All `/api/*` routes (except auth and `/health`) require a valid JWT
- Documents, queries, and dashboard stats are scoped per user

## Kafka Topics

| Topic | Producer | Consumer | Purpose |
|---|---|---|---|
| `raw-docs` | API on upload | Consumer (processor) | Trigger document processing |
| `raw-docs-dlq` | Consumer (after 3 retries) | — | Dead-letter queue for failed documents |

Topics are auto-created by Kafka on first use (see `KAFKA_AUTO_CREATE_TOPICS_ENABLE`).

## Scaling

To run multiple consumer instances for parallel processing:
```bash
docker-compose up --scale consumer=3
```
Kafka's consumer group (set via `KAFKA_GROUP_ID`) distributes partitions across instances automatically.

## Testing

```bash
npm test                    # Run all workspace tests
npm test -w direze-api      # API tests only
npm test -w direze-consumer # Consumer tests only
```

## Production Readiness

The architecture is intentionally production-shaped, but several gaps remain before actual production deployment. Listed by category:

### Auth & Identity
- **Token refresh** — Tokens expire after 1h with no refresh mechanism. Users are silently logged out mid-session. Implement refresh tokens (stored in MongoDB with a `revoked` flag) or use short-lived access tokens with longer-lived refresh tokens.
- **OAuth provisioning secret** — The `OAUTH_PROVISION_SECRET` used to register GitHub users on first login is a shared secret. A stronger approach: generate a random password per user on first OAuth login and store it in MongoDB rather than deriving it from a shared env var.
- **Password reset** — No recovery path if a user forgets their password. Requires email infrastructure (SMTP or transactional email service like Resend or SendGrid).
- **Email verification** — Accounts are created without verifying the username is a real identity. Add email-as-username with a verification flow to prevent account squatting.
- **Session revocation** — JWTs are stateless; a signed-out token remains valid until expiry. For true revocation, maintain a token denylist in Redis or MongoDB with TTL matching token expiry.

### Data & Storage
- **MongoDB indexes** — The `users` and `documents` collections have no indexes beyond `_id`. Add `{ userId: 1 }` index on `documents` for list/filter performance, and ensure `users._id` uniqueness is enforced at the DB level (it is, since `_id` is the username, but a compound unique index on `username` field would be more conventional).
- **File storage** — Uploaded PDFs are written to the local filesystem (`/tmp/uploads`). In production, use object storage (S3, GCS, R2) so the API and consumer can run on separate machines without a shared volume.
- **Vector tombstoning** — Deleted documents remove MongoDB metadata but chunks in pgvector are deleted via a separate call. If that call fails, stale vectors accumulate. Add a cleanup job or use a transaction-like two-phase delete.
- **Conversation persistence** — Chat history exists only in React state. Add a `conversations` collection in MongoDB to persist chat sessions per user, enabling multi-turn context and session resumption.

### Observability
- **Structured logging** — Fastify's built-in logger emits JSON but there's no log aggregation. Pipe to a log shipper (Fluent Bit, Vector) feeding into Loki, Datadog, or CloudWatch.
- **Metrics** — No application-level metrics. Instrument with Prometheus (via `fastify-metrics`) and export consumer lag, embedding latency, LLM latency, and error rates.
- **Distributed tracing** — Requests span the API, Kafka, and consumer with no trace correlation. Add OpenTelemetry with a W3C `traceparent` header propagated through Kafka message headers.
- **Alerting** — Set alerts on DLQ depth (documents stuck in dead-letter queue), consumer lag, and LLM error rate.

### Reliability
- **Idempotent upload** — Re-uploading the same file creates a duplicate document. Add a content hash on upload and deduplicate by hash + userId.
- **Consumer exactly-once** — The consumer uses at-least-once Kafka semantics. Duplicate processing is prevented by the pgvector unique constraint on `(document_id, chunk_index)`, but the MongoDB status update could still double-fire. Evaluate whether this matters for your workload.
- **API timeouts** — LLM calls and embedding calls have no explicit timeouts. A slow Anthropic or OpenAI response will hold the connection open indefinitely. Set `AbortController` timeouts on all external calls.
- **Health check depth** — The `/health` endpoint returns 200 without checking MongoDB, Postgres, or Kafka connectivity. A deep health check enables load balancers to remove unhealthy instances automatically.

### Security
- **CORS in production** — `CORS_ORIGINS` is a comma-separated env var. Validate it at startup (currently done) but also ensure it's set to the exact production domain, not a wildcard.
- **File type validation** — The API validates MIME type and extension on upload, but pdf-parse can panic on malformed PDFs. Run the consumer in a sandboxed environment (separate container, restricted syscalls via seccomp) to limit blast radius.
- **Dependency audit** — Run `npm audit` before each deployment and pin transitive dependencies with a lockfile. Consider Dependabot or Renovate for automated updates.
- **Secrets management** — `.env` files work for development. In production, use a secrets manager (AWS Secrets Manager, HashiCorp Vault, or Doppler) and inject secrets at runtime rather than baking them into container images.

### UX Gaps (deferred from code review)
- **Pagination** — All documents are fetched in one query. Add cursor-based pagination to the API and a "load more" or infinite scroll on the frontend.
- **Multi-file upload** — The upload form accepts one file at a time. Add `multiple` attribute and queue uploads with per-file progress, respecting the 10/min rate limit.
- **Dark/light mode** — The UI is hardcoded dark. Respect `prefers-color-scheme` via Tailwind's `dark:` variants.
- **Accessibility** — Several interactive elements lack `aria-label`, `aria-expanded`, and `aria-live` attributes. Run `axe` or Lighthouse accessibility audit before launch.

## Roadmap

- [x] Real PDF text extraction (pdf-parse)
- [x] JWT auth middleware
- [x] Rate limiting
- [x] Input validation (UUID, body size limits)
- [x] Anthropic Claude for LLM
- [x] Multi-document queries (search across all ready documents)
- [x] Streaming LLM responses (SSE via `/api/query/stream`)
- [x] NextAuth.js integration on frontend (credentials provider + session)
- [x] MongoDB dashboard page (`/dashboard` — aggregation pipeline stats)
- [x] Token-aware chunking (js-tiktoken, cl100k_base encoding)
- [x] Dead letter queue (`raw-docs-dlq` topic, 3 retries before DLQ)
- [x] bcrypt password hashing + httpOnly cookie auth
- [x] User isolation — per-user document scoping with ownership checks
- [x] MongoDB-backed user store (replaces in-memory Map)
- [x] GitHub OAuth via NextAuth.js (optional, zero-config if env vars absent)
- [x] Route protection via Next.js middleware
- [x] Registration page + login/register linking
- [x] Shared nav bar + sign-out
- [x] Markdown rendering in chat
- [ ] Token refresh / session extension
- [ ] Conversation persistence (MongoDB `conversations` collection)
- [ ] File deduplication by content hash
- [ ] Object storage for uploaded PDFs (S3/GCS/R2)
- [ ] Prometheus metrics + Grafana dashboard
- [ ] Answer quality evals
