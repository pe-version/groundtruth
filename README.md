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
- NextAuth.js credentials provider on the frontend with session-based auth
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
| Auth | JWT (HS256) |

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
│       ├── types.ts                  # Document, Chunk, event interfaces
│       ├── config.ts                 # Zod-validated environment config
│       ├── mongo.ts                  # MongoDB client + operations
│       ├── vector-store.ts           # pgvector client (insert, search, delete)
│       ├── embedding.ts              # OpenAI embedding client (DRY)
│       └── index.ts                  # Barrel export
│
├── api/                              # Fastify HTTP API
│   └── src/
│       ├── index.ts                  # Server entrypoint, plugin registration
│       ├── middleware/auth.ts         # JWT token generation helper
│       ├── routes/
│       │   ├── documents.ts          # Upload, list, get, delete (with UUID validation)
│       │   ├── query.ts              # RAG query (embed → search → Claude)
│       │   └── health.ts             # Health check
│       └── services/
│           ├── anthropic.ts          # Claude chat completion
│           └── kafka-producer.ts     # KafkaJS producer
│
├── consumer/                         # Kafka consumer
│   └── src/
│       ├── index.ts                  # Consumer entrypoint
│       ├── processor.ts              # Pipeline: extract → chunk → embed → index
│       └── pdf-extract.ts            # PDF text extraction (pdf-parse)
│
├── frontend/                         # Next.js app
│   ├── app/
│   │   ├── upload/page.tsx           # Drag-and-drop upload
│   │   ├── documents/page.tsx        # Document library with status polling
│   │   └── chat/page.tsx             # Chat interface with source excerpts
│   └── lib/api.ts                    # Typed API client with JWT auth
│
├── infra/
│   └── init.sql                      # pgvector schema
│
├── docker-compose.yml
├── .env.example
├── tsconfig.base.json
└── package.json                      # Workspace root
```

## Authentication

The API uses JWT (HS256) with bcrypt password hashing. Tokens are set as httpOnly cookies and also returned in the response body for flexibility.

- `POST /api/auth/register` — create a new account (password min 8 chars, hashed with bcrypt)
- `POST /api/auth/login` — authenticate and receive a JWT token (1h expiry)
- All `/api/*` routes (except auth and `/health`) require a valid JWT
- Documents, queries, and dashboard stats are scoped per user — users can only access their own data

## Kafka Topics

| Topic | Producer | Consumer | Purpose |
|---|---|---|---|
| `raw-docs` | API on upload | Consumer (processor) | Trigger document processing |

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
- [ ] Answer quality evals
