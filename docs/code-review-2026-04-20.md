# Staff SWE Code Review — 2026-04-20

Two independent Staff-level reviews of the Direze codebase. Reviewer 1 focused on
security and correctness (OWASP, distributed systems, crypto). Reviewer 2 focused
on architecture, testability, observability, and operational excellence.

---

## Reviewer 1 — Security & Correctness

### Critical

**C1. OAuth `providerId` collision with username**
Files: `api/src/routes/auth.ts:147`, `packages/shared/src/mongo.ts:46`, `frontend/lib/auth-options.ts:55,76`

OAuth users and credential users share the `users` collection keyed on `_id`.
A user can register with username `github:12345` and squat the slot the real
GitHub user will upsert into. `upsertOAuthUser` uses `$setOnInsert` so it won't
overwrite, but the issued JWT `sub` equals the squatted username — so ownership
checks (`doc.userId !== request.user.sub`) collapse. The attacker now owns every
document the OAuth user uploads.

Fix: namespace credential users as `local:<name>`, or use opaque UUID `sub` with
username/provider as lookup keys. Reject `:` in usernames at registration.

**C2. OAuth callback issues a session when the secret is rejected**
File: `frontend/lib/auth-options.ts:64-79`

If `/api/auth/oauth-token` returns non-OK (wrong secret, API down), the JWT
callback silently returns without `accessToken`. NextAuth creates a session
anyway — user appears logged in, every API call 401s. Combined with C1, a
server component reading `token.sub` sees an unauthenticated-looking identity.

Fix: throw on non-OK so NextAuth refuses the sign-in.

**C3. [Withdrawn after deeper analysis — see M2]**

**C4. No CSRF defense-in-depth on state-changing POSTs**
File: `api/src/index.ts:30-50,72-80`

Relies entirely on `SameSite=Strict`. If CORS is ever loosened or `SameSite=Lax`
adopted, every POST/DELETE is CSRF-able. No Origin/Referer check, no double-
submit cookie.

Fix: `onRequest` hook that asserts `Origin` (or `Referer`) is in the allowlist
for non-GET/HEAD/OPTIONS methods.

**C5. Consumer commits offset on transient failure → silent data loss**
File: `consumer/src/index.ts:108-117`

When `processDocument` throws and retries aren't exhausted, the consumer marks
the doc `failed (attempt N)` and *commits the offset*. Message is gone from
Kafka — no actual retry. The retry counter only fires on a new user re-upload,
which never happens. DLQ-after-3-retries is illusory.

Fix: either (a) don't commit on failure, use `pause/resume` for backoff, and
store attempts in a typed field or Kafka header; or (b) DLQ on first failure
and remove the retry illusion.

**C6. Path traversal defense is incomplete; `event.filePath` is consumer-trusted**
Files: `api/src/routes/documents.ts:41,69`, `consumer/src/processor.ts:27-34`

The consumer's `startsWith(uploadDir)` check only validates containment, not
correspondence between `documentId` and `filePath`. A producer with Kafka
access can send `{documentId: A, filePath: /tmp/uploads/B.pdf}` and cross-
pollinate chunks — B's content gets indexed under A's user.

Fix: drop `filePath` from `KafkaDocumentEvent` entirely. Consumer derives
`path.join(uploadDir, ${event.documentId}.pdf)`. Also secure Kafka with
SASL/TLS in non-dev.

### High

**H1. Dashboard stats endpoint has no per-route rate limit**
File: `api/src/routes/dashboard.ts`, `frontend/app/dashboard/page.tsx:29`

Polls every 10s, never stops. At scale this self-DoSes the aggregation. Add
per-route limit; mirror documents-page termination on terminal states.

**H2. Cross-document search bypasses user isolation**
File: `api/src/routes/query.ts:33-51`, `infra/init.sql:5-12`

When `documentId` is omitted, `vectorStore.similarChunks(null, ...)` searches
*all* chunks across all users. The `chunks` table has no `user_id` column.
The README's "user isolation" claim doesn't hold for the global search path.
Arguably Critical.

Fix: add `user_id` to chunks table; filter `similarChunks` by user always.

**H3. SSE error path leaks LLM/Anthropic errors to clients**
File: `api/src/routes/query.ts:143-148`

`err.message` from `streamClaude` is forwarded to the user. Anthropic errors
can include API keys in URLs, internal 5xx descriptions, account IDs (OWASP A09).

Fix: emit generic `"LLM stream failed"` to the wire; log detail server-side.

**H4. `updateStatus`/`markFailed` invoked before validating message authenticity**
File: `consumer/src/index.ts:65,113`

Consumer flips docs to `processing`/`failed` before any ownership check. A
producer with topic access can rewrite any user's document state.

Fix: conditional updates: `updateOne({ _id, status: 'pending' }, ...)`. Use
`matchedCount` to detect spoofed events.

**H5. Chunk writes not atomic with status flip**
File: `consumer/src/processor.ts:60-63`, `consumer/src/index.ts:80-85`

Crash between `insertChunk` calls and the `ready` flip produces partial state.
Delete followed by Kafka redelivery resurrects chunks — no tombstone.

Fix: refuse to process events for documents whose status isn't `pending`;
make insertion truly idempotent on `(document_id, chunk_index, content_hash)`.

**H6. JWT hook doesn't assert `sub` is non-empty**
File: `api/src/index.ts:75-79`

If `jwtVerify()` succeeds but payload lacks `sub`, `request.user.sub` is
`undefined` → `listDocuments(undefined)` returns *all* docs for all users.
The optional `userId?` on `listDocuments`/`getStatusSummary` is the trap.

Fix: assert `request.user?.sub` is a non-empty string in the hook; make
`userId` required on list queries.

**H7. `OAUTH_SERVER_SECRET` is optional; misconfiguration produces broken sessions silently**
Files: `packages/shared/src/config.ts:18`, `api/src/routes/auth.ts:130-134`

If unset on the API, endpoint returns 503. If unset on frontend, timing-safe
compare fails → 401 → NextAuth session without `accessToken` (see C2).

Fix: required on both sides when any OAuth provider is enabled; validate at boot.

**H8. Heartbeat interval can outlive a fenced consumer**
File: `consumer/src/index.ts:75-91`

`heartbeat().catch(() => {})` silences rebalance errors. If fenced, processing
continues and may double-write while another instance processes the same partition.

### Medium

**M1.** `helmet` registered with `contentSecurityPolicy: false`; no CSP on Next.js frontend.

**M2.** JWT `sub` (= username) flows directly into Mongo filters. Username validation
allows `$`, `.`, control characters. Restrict to `[a-zA-Z0-9_.-]{3,64}`.

**M3.** `bcryptjs` is pure JS, ~3-5x slower than native `bcrypt`, blocks the event loop.
Use `bcrypt` (native) or `argon2`. Raise rounds to 12 if staying on bcrypt.

**M4.** Kafka message `JSON.parse` has no runtime schema validation. Validate with zod.

**M5.** No `user_id` column on `chunks` (see H2 — defense in depth).

**M6.** `ivfflat` with `lists = 100` on an empty table produces poor recall until
populated. Consider `hnsw` (PG16 + pgvector ≥ 0.5).

**M7.** SSE headers flushed after slow embedding call. No `request.raw.on('close')`
handler; no keepalive comments. Proxies can kill streams at 30-60s idle.

**M8.** Graceful shutdown `process.exit(0)` even when close steps fail.

**M9.** Consumer reads from a shared filesystem volume with the API — forces
colocation, prevents horizontal consumer scaling across nodes.

**M10.** JWTs lack `iss`, `aud` claims; no refresh token mechanism.

**M11.** `request.file()` loads 50MB into memory via `toBuffer()`. Stream to disk.

**M12.** `react-markdown` in chat is XSS-safe by default — confirmed safe, flagged
as a known pivot if `rehype-raw` or `remark-html` is added later.

### Low

- **L1.** SSE spec uses `\r\n\r\n`; browser-tolerant but proxies can be picky.
- **L2.** `pdf-parse@1.1.1` unmaintained since 2018; switch to `unpdf` or `pdfjs-dist`.
- **L3.** Zookeeper → KRaft migration.
- **L4.** `next.config.js` empty — no CSP, X-Frame-Options, Referrer-Policy.
- **L5.** CORS missing `PUT`/`PATCH` (fine until routes exist).
- **L6.** Dockerfiles include dev dependencies.
- **L7.** `DocumentStatus` const + type pattern is correct.
- **L8.** `MAX_RETRIES = 3` magic number; move to config.
- **L9.** `assistantIdx = messages.length + 1` — stale-closure hazard; use functional setters.
- **L10.** `setTimeout` after upload has no unmount cleanup.

### Architectural Smells

- **A1. Identity vs. authorization conflation.** JWT `sub` == username couples renames,
  merges, OAuth provisioning to identity. Use opaque UUID `sub`.
- **A2. State machine encoded as strings.** No transition rules; stale redeliveries
  can flip `failed → processing → ready`.
- **A3. Kafka trust boundary undefended.** No broker auth, no message signing, no
  schema — see C6, H4, M4.
- **A4. Retry counter parsed from `errorMsg` regex.** Load-bearing regex on a free-
  form log string.
- **A5. Polling-based UI for status.** Replace with SSE or cache headers.
- **A6. No structured logging, no request correlation IDs.** Debugging cross-service
  issues requires grep.
- **A7. No tenancy at the storage layer.** Uploads is a flat directory; `chunks`
  has no `user_id`; Mongo has no `(userId, _id)` compound index. All isolation
  rests on application-layer filters being right everywhere — and they aren't (H2).

### Reviewer 1's Top Quick Wins

1. Drop `filePath` from `KafkaDocumentEvent` (fixes C6)
2. Reject `:` in usernames; namespace as `local:<name>` (fixes C1)
3. Throw on non-OK in OAuth callback (fixes C2)
4. Add `user_id` filter to chunks table and `similarChunks` (fixes H2)
5. Assert `sub` in JWT hook; remove `userId?` optional (fixes H6)
6. Drop the fake retry counter; pick one real mechanism (fixes C5)
7. Sanitize SSE error messages (fixes H3)

---

## Reviewer 2 — Architecture & Operations

### Critical

**C1. Consumer commits offset on transient failure**
Same finding as Reviewer 1's C5. Silent data loss.

**C2. PDF processing is inline on eachMessage — head-of-line blocking**
File: `consumer/src/index.ts:34-119`

Single-partition default + no `partitionsConsumedConcurrently`. `--scale consumer=3`
does nothing because only one consumer per group serves a partition. N sequential
embedding calls per doc instead of one batched `embedTexts`.

Fix: `partitionsConsumedConcurrently > 1`; create topic with N partitions
explicitly; use `embedTexts` batched calls.

**C3. No timeouts on Anthropic, OpenAI, Postgres, Mongo**
Files: `api/src/services/anthropic.ts:27-32`, `packages/shared/src/embedding.ts:14-40`,
`packages/shared/src/vector-store.ts:13`, `packages/shared/src/mongo.ts:19`

Every external call is unbounded. One slow upstream cascades into FD/connection
exhaustion. The single largest production-incident reducer.

Fix: `AbortController` with 30s embed / 60s LLM; `pg.Pool({ statement_timeout: 10000,
connectionTimeoutMillis: 5000, max: 10 })`; `MongoClient({ serverSelectionTimeoutMS })`.

**C4. Auth hook doesn't short-circuit properly**
File: `api/src/index.ts:72-80`

`reply.code(401).send()` without `return` inside the hook; downstream handlers
may still execute depending on plugin ordering. `includes(request.url)` breaks
on query strings.

Fix: `return reply.code(401).send(...)`. Use `config: { public: true }` on
public routes.

### High

- **H1.** Public-paths list matched by raw URL `includes` — test drift, query-string
  fragility. Test suite in `routes.test.ts:83` even omits `/api/auth/oauth-token`.
- **H2.** SSE `writeHead(200)` fires before embedding / chunk fetch; can't return 4xx
  after. Move pre-stream work before headers.
- **H3.** Chat message index race: `assistantIdx = messages.length + 1` captured at
  click; second message before first stream ends corrupts state. Use stable UUIDs.
- **H4.** Upload failure leaves orphan file + orphan Mongo record with no compensating
  delete. `unlink` in catch, or publish-before-write.
- **H5.** 50MB PDF buffered in memory. Stream to disk with `pipeline()`.
- **H6.** Retry counter as stringly-typed regex — same as Reviewer 1's A4.
- **H7.** `chunkByTokens` tail chunk edge case on `tokens.length = chunkSize + 1`;
  needs boundary test.
- **H8.** Dead legacy `chunkText` still exported.
- **H9.** `/health` always 200 — orchestrators route to dead instances. Split into
  `/health/live` (cheap) and `/health/ready` (pings Mongo/Postgres/Kafka).
- **H10.** TOCTOU in delete: ownership check → deleteChunks → deleteDocument not
  atomic. Fail-safe ordering + reconciliation job.
- **H11.** Mongo `_id: username` allows Unicode normalization collisions
  (`alice`, `Alice`, `alıce`). Normalize NFKC + lowercase at registration.
- **H12.** `consumer/src/index.ts` has zero test coverage — the file with all the
  retry/DLQ bugs. Refactor `eachMessage` into exported `handleMessage(deps, payload)`.

### Medium

- **M1.** Auth hook duplicated between prod and tests. Export as a plugin.
- **M2.** `as any` escape hatches throughout `mongo.ts` — hiding real type problems
  in the data layer.
- **M3.** SSE has no heartbeat comments; proxies idle-close at 30-60s.
- **M4.** SSE errors don't carry HTTP-like codes (`RATE_LIMIT`, `UPSTREAM`, `TIMEOUT`).
  Frontend can't differentiate retry-worthy errors.
- **M5.** Hardcoded constants scattered: chunk sizes, embedding dim (1536 in SQL),
  model names, `EMBED_CONCURRENCY`, `MAX_RETRIES`. Centralize + startup assertion
  that `EMBED_DIM` matches the SQL schema.
- **M6.** Mixed logging: `console.log` in consumer, pino in API. Unify with pino.
- **M7.** No trace propagation through Kafka headers (`traceparent`).
- **M8.** `loadApiConfig()` failure prints a Zod stack trace. Catch `ZodError`
  and format human-readable.
- **M9.** Graceful shutdown has no drain order (stop new work → wait in-flight →
  flush → close). `process.exit(0)` unconditional even when close throws.
- **M10.** Rate limit is per-IP — broken behind proxies, useless under shared NAT.
  `keyGenerator` on `request.user.sub` for authed routes.
- **M11.** Token in module-level singleton in `frontend/lib/api.ts:29-37`. SSR-unsafe;
  any server component calling the API leaks across tenants.
- **M12.** `next-env.d.ts` normally committed; document the gitignore decision.
- **M13.** SSE parser drops malformed lines silently — log warnings.
- **M14.** `embedTexts` is exported, tested, never called. Consumer still does
  5-concurrent single-item calls instead of one batch.
- **M15.** OAuth upsert ignores `upsertedCount` — no audit distinction between
  "new user" and "existing login."
- **M16.** `commitOffset` hand-rolls a Consumer type instead of importing.

### Low

- **L1.** `BigInt(offset) + 1n` — correct but needs explanatory comment.
- **L2.** `uuid` package is a dep but unused (`randomUUID` from `node:crypto`).
- **L3.** `/dashboard` route not in nav.
- **L4.** Middleware protects `/dashboard` correctly; README implies it's discoverable.
- **L5.** `NEXT_PUBLIC_API_URL=http://api:8080/api` works in Docker but ships to
  the browser bundle where it can't resolve.
- **L6.** Same as Reviewer 1's M3.
- **L7.** Schema bodies lack `additionalProperties: false`.
- **L8.** `insertChunk` runs sequentially — 200 round-trips for a 200-chunk doc.
  Batch INSERT.
- **L9.** `/dashboard` has no error handling on fetch failure.
- **L10.** `topK` default duplicated between schema and route destructure.
- **L11.** Vitest versions pinned loosely (`^2.0.0`).
- **L12.** No `.dockerignore` visible; Dockerfiles may be missing.

### Architectural Smells

- **A1. `MongoDB` class is a god object.** Split into `UserRepo`, `DocumentRepo`,
  `StatsRepo`.
- **A2. Mongo `_id` leaks into API types.** Introduce `DocumentDTO` at the API
  boundary.
- **A3. `@direze/shared` imports `mongodb`, `pg`, `openai`.** Frontend can't use
  its types. Split into `@direze/types` (pure) and `@direze/clients` (runtime).
- **A4. No service layer.** Routes mix auth + DB + business logic. Tests are
  integration tests masquerading as unit tests.
- **A5. No API versioning.** All routes under `/api/*` — breaking changes have no
  migration path.
- **A6. Frontend duplicates types** from shared because of A3.
- **A7. Implicit SQL/embedding-model coupling.** `vector(1536)` hardcoded; switching
  to `text-embedding-3-large` silently fails on insert.
- **A8. Three HS256 shared secrets** (`OAUTH_SERVER_SECRET`, `NEXTAUTH_SECRET`,
  `JWT_SECRET`). Consider RS256 with public-key verification.

### Things Done Well (Reviewer 2)

- Zod-validated config at process boundary
- Helmet + httpOnly cookies + bcrypt
- pgvector unique `(document_id, chunk_index)` makes at-least-once safe
- DLQ scaffolding preserves original metadata
- Heartbeat during long processing
- Schema-level input validation
- Streaming SSE with sources-then-tokens contract
- Per-user ownership checks consistently applied
- Token-aware chunking
- ADR for OAuth design choice in README
- Honest Production Readiness section

### Reviewer 2's Top 5

1. C1 — Consumer commit-on-failure → real data loss
2. C3 — Add timeouts to all external calls
3. C2 — Kafka partition count / concurrent consumption
4. C4 / H1 — Fix auth hook short-circuit + route flags
5. H2 — SSE error contract pre-stream

---

## Consolidated Top 7 (Merged)

1. **Consumer retry semantics.** Pick one mechanism (true retry with offset
   management, or DLQ-on-first-failure). Delete the `errorMsg` regex parser.
2. **Cross-document search user isolation.** Add `user_id` to `chunks` table;
   always filter in `similarChunks`. Biggest actual security hole.
3. **Derive `filePath` in consumer.** Drop it from the Kafka event entirely.
4. **Auth hook hardening.** `return reply.code(401)`; assert `sub` non-empty;
   make `userId` required on list queries; route flags instead of URL string list.
5. **Add timeouts** to every external call (Anthropic, OpenAI, Mongo, Postgres)
   via `AbortController` and pool config.
6. **Namespace usernames.** Reject `:`, or switch credential users to `local:<name>`
   prefix, or move to opaque UUID `sub`.
7. **SSE error path.** Move pre-stream work before `writeHead`; sanitize error
   messages to avoid leaking upstream details.

---

## Decisions Log

### 2026-04-20: Cross-document search isolation (fix #2) — IMPLEMENTED

Added `user_id` column to the `chunks` table, threaded through `VectorStore`
signatures (`insertChunk`, `similarChunks`, `deleteChunks` all require `userId`
now), added it to `KafkaDocumentEvent` so the consumer has it. The SQL filter
is always `WHERE user_id = $N AND ...`, so even if a future route forgets the
application-layer check the storage layer still enforces isolation.

**Alternatives considered:**
- *Application-layer filter only* (pass user-owned doc IDs into an `IN (...)`
  clause). Rejected — one forgotten call site leaks everything again.
- *Postgres RLS policies* (session variable per connection). Rejected — correct
  solution for large multi-tenant systems but overkill for this project; adds a
  real learning curve for any future contributor.

### 2026-04-20: Derive filePath in consumer (fix #3) — IMPLEMENTED

Dropped `filePath` from `KafkaDocumentEvent`. Added `getUploadPath(uploadDir,
documentId)` helper in `@direze/shared`. Both the API (writer) and consumer
(reader) call it, so the layout is defined in exactly one place and nothing
external can influence where the consumer reads from. The path-traversal
validation code in `processor.ts` is gone — there's nothing to validate
because there's no attacker-controlled path.

**Alternative considered: S3-ready `BlobStore` abstraction.** Rejected for now.
Would have required a `BlobStore` interface with `LocalFsBlobStore` + `S3BlobStore`
implementations, new env vars (`BLOB_STORAGE_TYPE`, `S3_BUCKET`, etc.), an AWS
SDK dependency, MinIO in docker-compose for dev, and updated tests. ~1 day of
work vs. ~30 min for the simpler fix. Both versions close the security hole
equally; the S3 version only pays off when deploying to production.

**How to upgrade to the S3-ready version later:**

1. Create a `BlobStore` interface in `packages/shared/src/blob-store.ts`:
   ```ts
   export interface BlobStore {
     put(key: string, body: Buffer | Readable): Promise<void>;
     get(key: string): Promise<Readable>;
     delete(key: string): Promise<void>;
   }
   ```
2. Add two implementations: `LocalFsBlobStore` (wraps the current `readFile`/
   `writeFile` calls + `getUploadPath`) and `S3BlobStore` (uses
   `@aws-sdk/client-s3`).
3. Change `KafkaDocumentEvent` to carry `objectKey: string` instead of relying
   on the derived path convention. Object keys are opaque — the consumer asks
   the blob store for them, it doesn't compute a filesystem path.
4. Replace `writeFile(filePath, buffer)` in `api/src/routes/documents.ts` with
   `blobStore.put(objectKey, buffer)`. While there, switch to streaming via
   `pipeline()` to also close the 50MB in-memory buffer issue
   (Reviewer 2's H5).
5. Replace `readFile(filePath)` in `consumer/src/processor.ts` with
   `await blobStore.get(objectKey)` returning a stream the PDF parser consumes.
6. Add `BLOB_STORAGE_TYPE=local|s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`,
   AWS credentials to `config.ts` schema.
7. Add MinIO to `docker-compose.yml` for local dev parity; add a bucket-init
   container that creates the bucket on startup.
8. Drop the `uploads` volume from the docker-compose API and consumer services
   — the shared-volume coupling (Reviewer 1's M9) goes away naturally.
9. Update the `DELETE /documents/:id` route to call `blobStore.delete(objectKey)`
   (best-effort, same as today's `unlink`).
10. Update tests — mock the `BlobStore` interface; add an integration test
    against MinIO to catch real S3 semantics differences (consistency model,
    key encoding rules).

The public contract (Kafka event shape at step 3) is the only breaking change;
everything else is internal. If the event carries both the old derived path
convention (step 1 of current implementation) and a new `objectKey`, you can
even do a gradual migration where the consumer prefers `objectKey` when present
and falls back to the derived path.
