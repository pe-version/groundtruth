/// <reference path="../src/types.d.ts" />
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { authRoutes } from "../src/routes/auth.js";
import { documentRoutes } from "../src/routes/documents.js";
import { queryRoutes } from "../src/routes/query.js";
import { dashboardRoutes } from "../src/routes/dashboard.js";
import { JwtService } from "../src/services/jwt.js";

// --- Mocks ---

vi.mock("@groundtruth/shared", async () => {
  return {
    DocumentStatus: {
      Pending: "pending",
      Processing: "processing",
      Ready: "ready",
      Failed: "failed",
    },
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0)),
    UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    UUID_PATTERN: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  };
});

function createMockLlm() {
  return {
    name: "test",
    streamAnswer: vi.fn(async function* () {
      yield "Hello ";
      yield "world";
    }),
  };
}

function createMockDb() {
  const users = new Map<string, { _id: string; passwordHash: string; oauthProvider?: string; createdAt: Date }>();
  return {
    ping: vi.fn().mockResolvedValue(undefined),
    insertDocument: vi.fn().mockResolvedValue(undefined),
    getDocument: vi.fn().mockResolvedValue(null),
    listDocuments: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    getStatusSummary: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(async (username: string) => users.get(username) ?? null),
    createUser: vi.fn(async (username: string, passwordHash: string) => {
      users.set(username, { _id: username, passwordHash, createdAt: new Date() });
    }),
    upsertOAuthUser: vi.fn(async (userId: string, provider: string) => {
      if (!users.has(userId)) {
        users.set(userId, { _id: userId, passwordHash: "", oauthProvider: provider, createdAt: new Date() });
      }
    }),
  };
}

function createMockVectorStore() {
  return {
    insertChunk: vi.fn().mockResolvedValue(undefined),
    similarChunks: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockJobQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue("job-id-mock"),
    fetchOne: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    retryOrFail: vi.fn().mockResolvedValue("retried"),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRefreshTokens() {
  // In-memory store mimicking the atomic consume() + replay-detection
  // shape of the real RefreshTokenStore. Live tokens map → user; consumed
  // history is a separate Set so replay detection works in tests.
  const live = new Map<string, { userId: string; expiresAt: Date }>();
  const consumed = new Map<string, { userId: string; expiresAt: Date }>();
  let counter = 0;
  return {
    issue: vi.fn(async (userId: string) => {
      const token = `mock-refresh-${++counter}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      live.set(token, { userId, expiresAt });
      return { token, expiresAt };
    }),
    consume: vi.fn(async (token: string) => {
      const row = live.get(token);
      if (row) {
        live.delete(token);
        consumed.set(token, row);
        return { kind: "ok" as const, userId: row.userId };
      }
      const replay = consumed.get(token);
      if (replay) return { kind: "replay" as const, userId: replay.userId };
      return { kind: "missing" as const };
    }),
    revoke: vi.fn(async (token: string) => {
      live.delete(token);
    }),
    revokeAllForUser: vi.fn(async (userId: string) => {
      for (const [tok, row] of live) {
        if (row.userId === userId) live.delete(tok);
      }
    }),
    pruneExpired: vi.fn(async () => ({ active: 0, consumed: 0 })),
    close: vi.fn(async () => undefined),
  };
}

const JWT_SECRET = "test-secret-long-enough-for-jwt-32chars!";

async function buildApp() {
  const fastify = Fastify({ logger: false });

  await fastify.register(cookie);
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  const db = createMockDb();
  const vectorStore = createMockVectorStore();
  const jobQueue = createMockJobQueue();
  const refreshTokens = createMockRefreshTokens();
  const llm = createMockLlm();
  const jwtService = new JwtService(JWT_SECRET);

  // Mocks are partial — cast to `any` here so the test fixture can stay
  // narrow without rebuilding the full real interface.
  fastify.decorate("db", db as any);
  fastify.decorate("vectorStore", vectorStore as any);
  fastify.decorate("jobQueue", jobQueue as any);
  fastify.decorate("refreshTokens", refreshTokens as any);
  fastify.decorate("jwt", jwtService);
  fastify.decorate("llm", llm as any);
  fastify.decorate("config", { UPLOAD_DIR: "/tmp/test-uploads" } as any);

  // Auth hook — mirrors prod (api/src/index.ts). Routes opt out via
  // config.public = true on the route definition.
  fastify.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.config?.public) return;

    const authHeader = request.headers.authorization;
    const headerToken =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const cookieToken = request.cookies?.["groundtruth_token"];
    const token = headerToken ?? cookieToken;
    if (!token) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const claims = await jwtService.verifyAccessToken(token);
      request.user = { sub: claims.sub };
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await fastify.register(authRoutes, { prefix: "/api" });
  await fastify.register(documentRoutes, { prefix: "/api" });
  await fastify.register(queryRoutes, { prefix: "/api" });
  await fastify.register(dashboardRoutes, { prefix: "/api" });

  return { fastify, db, vectorStore, jobQueue, refreshTokens };
}

async function getToken(fastify: FastifyInstance, sub = "test-user"): Promise<string> {
  return await fastify.jwt.signAccessToken(sub);
}

// --- Tests ---

describe("Auth routes", () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    ({ fastify } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("POST /api/auth/register creates a user and returns token", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "alice", password: "secretpass123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.userId).toBe("alice");
    // Should set httpOnly cookie
    const cookies = res.cookies;
    const tokenCookie = cookies.find((c: { name: string }) => c.name === "groundtruth_token");
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie?.httpOnly).toBe(true);
  });

  it("POST /api/auth/register rejects duplicate username", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "alice", password: "anotherpass123" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /api/auth/register rejects short password", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "bob", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/auth/register rejects username with OAuth namespace separator", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "github:12345", password: "secretpass123" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/auth/register normalizes username (case-insensitive + NFKC)", async () => {
    // Mixed-case should normalize to lowercase; re-registering the lowercase
    // form should now conflict.
    const mixed = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "Charlie", password: "secretpass123" },
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().userId).toBe("charlie");

    const lower = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "charlie", password: "secretpass123" },
    });
    expect(lower.statusCode).toBe(409);
  });

  it("POST /api/auth/login succeeds with correct credentials", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "secretpass123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeDefined();
  });

  it("POST /api/auth/login rejects wrong password", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrongpassword" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/auth/login rejects non-existent user", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "password123" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/auth/login rejects missing fields", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("JWT auth middleware", () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    ({ fastify } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("rejects requests without Authorization header", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid JWT token", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
      headers: { authorization: "Bearer invalid.token.here" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid JWT token", async () => {
    const token = await getToken(fastify);
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects JWT with empty sub", async () => {
    const token = await fastify.jwt.signAccessToken("");
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts request with query string on protected route (no URL-string bypass)", async () => {
    const token = await getToken(fastify);
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents?foo=bar",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("skips JWT for public routes (register without auth header)", async () => {
    // Register is marked public — a call with no Authorization header must not
    // be blocked by the auth hook (it should reach the handler, returning
    // 200/409/400 depending on payload, but never 401 from the hook).
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "public-check-user", password: "secretpass123" },
    });
    expect([200, 409]).toContain(res.statusCode);
  });
});

describe("Document routes", () => {
  let fastify: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;

  beforeAll(async () => {
    ({ fastify, db, vectorStore } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("GET /api/documents returns list scoped to user", async () => {
    db.listDocuments.mockResolvedValueOnce([
      {
        _id: "550e8400-e29b-41d4-a716-446655440000",
        userId: "test-user",
        filename: "test.pdf",
        status: "ready",
        chunkCount: 5,
        uploadedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("550e8400-e29b-41d4-a716-446655440000");
    // listDocuments should be called with the user's ID
    expect(db.listDocuments).toHaveBeenCalledWith("test-user");
    // Ensure _id is mapped to id
    expect(body[0]._id).toBeUndefined();
  });

  it("GET /api/documents/:id rejects invalid UUID", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/not-a-uuid",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid document ID");
  });

  it("GET /api/documents/:id returns 404 for missing document", async () => {
    db.getDocument.mockResolvedValueOnce(null);
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/documents/:id returns 404 if document belongs to another user", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "other-user",
      filename: "test.pdf",
      status: "ready",
      chunkCount: 5,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/documents/:id returns document owned by user", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "test-user",
      filename: "test.pdf",
      status: "ready",
      chunkCount: 5,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("DELETE /api/documents/:id requires ownership", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "other-user",
      filename: "test.pdf",
      status: "ready",
    });

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/documents/:id deletes owned document", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    db.getDocument.mockResolvedValueOnce({
      _id: id,
      userId: "test-user",
      filename: "test.pdf",
      status: "ready",
    });

    const res = await fastify.inject({
      method: "DELETE",
      url: `/api/documents/${id}`,
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(204);
    expect(vectorStore.deleteChunks).toHaveBeenCalledWith("test-user", id);
    expect(db.deleteDocument).toHaveBeenCalledWith(id);
  });

  it("DELETE /api/documents/:id rejects invalid UUID", async () => {
    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/documents/bad-id",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Query routes", () => {
  let fastify: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;

  beforeAll(async () => {
    ({ fastify, db, vectorStore } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("POST /api/query returns answer with sources", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "test-user",
      filename: "test.pdf",
      status: "ready",
    });
    vectorStore.similarChunks.mockResolvedValueOnce([
      { id: "1", documentId: "abc", content: "Some relevant content", chunkIndex: 0, score: 0.9 },
    ]);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: {
        documentId: "550e8400-e29b-41d4-a716-446655440000",
        question: "What is this about?",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toBe("Hello world");
    expect(body.sources).toHaveLength(1);
  });

  it("POST /api/query returns 404 for unowned document", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "other-user",
    });

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: {
        documentId: "550e8400-e29b-41d4-a716-446655440000",
        question: "test?",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/query returns fallback when no chunks found", async () => {
    vectorStore.similarChunks.mockResolvedValueOnce([]);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: { question: "Anything?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain("No relevant content");
    expect(res.json().sources).toEqual([]);
  });

  it("POST /api/query rejects empty question", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: { question: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/query rejects invalid documentId format", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: { documentId: "not-a-uuid", question: "test?" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/query rejects topK out of bounds", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: { question: "test?", topK: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/query works without documentId (multi-doc)", async () => {
    vectorStore.similarChunks.mockResolvedValueOnce([
      { id: "1", documentId: "abc", content: "Content", chunkIndex: 0, score: 0.8 },
    ]);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
      payload: { question: "Multi-doc question?" },
    });
    expect(res.statusCode).toBe(200);
    expect(vectorStore.similarChunks).toHaveBeenCalledWith(
      "test-user",
      null,
      expect.any(Array),
      5
    );
  });
});

describe("Dashboard routes", () => {
  let fastify: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeAll(async () => {
    ({ fastify, db } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("GET /api/dashboard/stats returns user-scoped summary", async () => {
    db.getStatusSummary.mockResolvedValueOnce([
      { status: "ready", count: 5 },
      { status: "pending", count: 2 },
      { status: "failed", count: 1 },
    ]);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/dashboard/stats",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(8);
    expect(body.ready).toBe(5);
    expect(body.pending).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.processing).toBe(0);
    // Should be called with user ID
    expect(db.getStatusSummary).toHaveBeenCalledWith("test-user");
  });

  it("GET /api/dashboard/stats returns zeros when empty", async () => {
    db.getStatusSummary.mockResolvedValueOnce([]);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/dashboard/stats",
      headers: { authorization: `Bearer ${await getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.ready).toBe(0);
  });
});
