import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { authRoutes } from "../src/routes/auth.js";
import { documentRoutes } from "../src/routes/documents.js";
import { queryRoutes } from "../src/routes/query.js";
import { dashboardRoutes } from "../src/routes/dashboard.js";

// --- Mocks ---

vi.mock("@direze/shared", async () => {
  return {
    DocumentStatus: {
      Pending: "pending",
      Processing: "processing",
      Ready: "ready",
      Failed: "failed",
    },
    embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  };
});

vi.mock("../src/services/anthropic.js", () => ({
  streamClaude: vi.fn(async function* () {
    yield "Hello ";
    yield "world";
  }),
}));

function createMockDb() {
  return {
    insertDocument: vi.fn().mockResolvedValue(undefined),
    getDocument: vi.fn().mockResolvedValue(null),
    listDocuments: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    getStatusSummary: vi.fn().mockResolvedValue([]),
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

function createMockKafkaProducer() {
  return {
    publishDocumentEvent: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const JWT_SECRET = "test-secret-long-enough-for-jwt";

async function buildApp() {
  const fastify = Fastify({ logger: false });

  await fastify.register(jwt, { secret: JWT_SECRET });
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  const db = createMockDb();
  const vectorStore = createMockVectorStore();
  const kafkaProducer = createMockKafkaProducer();

  fastify.decorate("db", db);
  fastify.decorate("vectorStore", vectorStore);
  fastify.decorate("kafkaProducer", kafkaProducer);
  fastify.decorate("config", { UPLOAD_DIR: "/tmp/test-uploads" });

  // Auth hook — skip /health and /api/auth/login
  fastify.addHook("onRequest", async (request, reply) => {
    const publicPaths = ["/health", "/api/auth/login"];
    if (publicPaths.includes(request.url)) return;
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await fastify.register(authRoutes, { prefix: "/api" });
  await fastify.register(documentRoutes, { prefix: "/api" });
  await fastify.register(queryRoutes, { prefix: "/api" });
  await fastify.register(dashboardRoutes, { prefix: "/api" });

  return { fastify, db, vectorStore, kafkaProducer };
}

function getToken(fastify: FastifyInstance): string {
  return fastify.jwt.sign({ sub: "test-user" }, { expiresIn: "1h" });
}

// --- Tests ---

describe("Auth routes", () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    ({ fastify } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("POST /api/auth/login returns a token", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "secret123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.userId).toBe("alice");
  });

  it("POST /api/auth/login rejects missing fields (schema validation)", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/auth/login rejects empty username", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "", password: "pass" },
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
    const token = getToken(fastify);
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Document routes", () => {
  let fastify: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let kafkaProducer: ReturnType<typeof createMockKafkaProducer>;

  beforeAll(async () => {
    ({ fastify, db, vectorStore, kafkaProducer } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("GET /api/documents returns list", async () => {
    db.listDocuments.mockResolvedValueOnce([
      {
        _id: "550e8400-e29b-41d4-a716-446655440000",
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
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body[0].filename).toBe("test.pdf");
    // Ensure _id is mapped to id (no _id in response)
    expect(body[0]._id).toBeUndefined();
  });

  it("GET /api/documents/:id rejects invalid UUID", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/not-a-uuid",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid document ID");
  });

  it("GET /api/documents/:id returns 404 for missing document", async () => {
    db.getDocument.mockResolvedValueOnce(null);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/documents/:id returns document", async () => {
    db.getDocument.mockResolvedValueOnce({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      filename: "test.pdf",
      status: "ready",
      chunkCount: 5,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fastify.inject({
      method: "GET",
      url: "/api/documents/550e8400-e29b-41d4-a716-446655440000",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("DELETE /api/documents/:id deletes chunks, document, and returns 204", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const res = await fastify.inject({
      method: "DELETE",
      url: `/api/documents/${id}`,
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(204);
    expect(vectorStore.deleteChunks).toHaveBeenCalledWith(id);
    expect(db.deleteDocument).toHaveBeenCalledWith(id);
  });

  it("DELETE /api/documents/:id rejects invalid UUID", async () => {
    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/documents/bad-id",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Query routes", () => {
  let fastify: FastifyInstance;
  let vectorStore: ReturnType<typeof createMockVectorStore>;

  beforeAll(async () => {
    ({ fastify, vectorStore } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("POST /api/query returns answer with sources", async () => {
    vectorStore.similarChunks.mockResolvedValueOnce([
      { id: "1", documentId: "abc", content: "Some relevant content", chunkIndex: 0, score: 0.9 },
    ]);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
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

  it("POST /api/query returns fallback when no chunks found", async () => {
    vectorStore.similarChunks.mockResolvedValueOnce([]);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
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
      headers: { authorization: `Bearer ${getToken(fastify)}` },
      payload: { question: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/query rejects invalid documentId format", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
      payload: { documentId: "not-a-uuid", question: "test?" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/query rejects topK out of bounds", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/query",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
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
      headers: { authorization: `Bearer ${getToken(fastify)}` },
      payload: { question: "Multi-doc question?" },
    });
    expect(res.statusCode).toBe(200);
    expect(vectorStore.similarChunks).toHaveBeenCalledWith(null, expect.any(Array), 5);
  });
});

describe("Dashboard routes", () => {
  let fastify: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeAll(async () => {
    ({ fastify, db } = await buildApp());
  });
  afterAll(async () => { await fastify.close(); });

  it("GET /api/dashboard/stats returns summary", async () => {
    db.getStatusSummary.mockResolvedValueOnce([
      { status: "ready", count: 5 },
      { status: "pending", count: 2 },
      { status: "failed", count: 1 },
    ]);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/dashboard/stats",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(8);
    expect(body.ready).toBe(5);
    expect(body.pending).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.processing).toBe(0);
  });

  it("GET /api/dashboard/stats returns zeros when empty", async () => {
    db.getStatusSummary.mockResolvedValueOnce([]);

    const res = await fastify.inject({
      method: "GET",
      url: "/api/dashboard/stats",
      headers: { authorization: `Bearer ${getToken(fastify)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.ready).toBe(0);
  });
});
