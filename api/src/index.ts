import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import { loadApiConfig, MongoDB, VectorStore, JobQueue, RefreshTokenStore, createLogger } from "@groundtruth/shared";
import { documentRoutes } from "./routes/documents.js";
import { queryRoutes } from "./routes/query.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { JwtService } from "./services/jwt.js";
import { AnthropicProvider } from "./services/anthropic.js";
import { startJanitor } from "./services/janitor.js";

async function main() {
  const config = loadApiConfig();
  const logger = createLogger("api");

  const fastify = Fastify({
    logger,
    bodyLimit: 1_048_576, // 1 MB default body limit
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
  });

  // --- Plugins -----------------------------------------------------------

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // frontend served separately
  });

  await fastify.register(cookie);

  await fastify.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
    },
  });

  // --- Dependencies -------------------------------------------------------

  const db = await MongoDB.connect(config.MONGO_URI);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);
  const jobQueue = await JobQueue.connect(config.POSTGRES_DSN);
  const refreshTokens = await RefreshTokenStore.connect(config.POSTGRES_DSN);
  const jwtService = new JwtService(config.JWT_SECRET);
  const llm = new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY });

  fastify.decorate("db", db);
  fastify.decorate("vectorStore", vectorStore);
  fastify.decorate("jobQueue", jobQueue);
  fastify.decorate("refreshTokens", refreshTokens);
  fastify.decorate("jwt", jwtService);
  fastify.decorate("llm", llm);
  fastify.decorate("config", config);

  // --- Auth hook -----------------------------------------------------------
  //
  // Routes that should skip JWT verification mark themselves with
  // config.public = true. Checking a route flag is robust against query
  // strings, trailing slashes, and new routes being added without updating
  // a hardcoded allowlist.

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.config?.public) return;

    // Accept the token from either the Authorization: Bearer header or the
    // httpOnly cookie. The cookie path is what the browser uses; the header
    // path is what curl/CLIs and our smoke tests use.
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

    // Attach userId to the request logger so every subsequent line in this
    // request (and any downstream publishes) carries it automatically.
    request.log = request.log.child({ userId: request.user.sub });
  });

  // --- Routes -------------------------------------------------------------

  await fastify.register(healthRoutes);
  await fastify.register(authRoutes, { prefix: "/api" });
  await fastify.register(documentRoutes, { prefix: "/api" });
  await fastify.register(queryRoutes, { prefix: "/api" });
  await fastify.register(dashboardRoutes, { prefix: "/api" });

  // --- Janitor ------------------------------------------------------------
  //
  // Periodic reconciliation of the three storage systems (uploads volume,
  // Mongo metadata, pgvector chunks). Catches leaks from crashes, dropped
  // Kafka messages, and partial deletes.

  const stopJanitor = startJanitor({
    db,
    vectorStore,
    uploadDir: config.UPLOAD_DIR,
    log: logger.child({ component: "janitor" }),
    intervalMs: 10 * 60_000,   // every 10 min
    orphanAgeMs: 60 * 60_000,  // only touch things older than 1h
  });

  // --- Graceful shutdown ---------------------------------------------------

  const shutdown = async () => {
    fastify.log.info("Shutting down...");
    stopJanitor();
    try { await fastify.close(); } catch (err) { fastify.log.error(err, "Error closing Fastify"); }
    try { await jobQueue.close(); } catch (err) { fastify.log.error(err, "Error closing JobQueue"); }
    try { await refreshTokens.close(); } catch (err) { fastify.log.error(err, "Error closing RefreshTokenStore"); }
    try { await vectorStore.close(); } catch (err) { fastify.log.error(err, "Error closing VectorStore"); }
    try { await db.disconnect(); } catch (err) { fastify.log.error(err, "Error disconnecting MongoDB"); }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // --- Start --------------------------------------------------------------

  await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
