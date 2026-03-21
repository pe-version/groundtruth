import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import { loadApiConfig, MongoDB, VectorStore } from "@direze/shared";
import { documentRoutes } from "./routes/documents.js";
import { queryRoutes } from "./routes/query.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { KafkaProducer } from "./services/kafka-producer.js";

async function main() {
  const config = loadApiConfig();

  const fastify = Fastify({
    logger: true,
    bodyLimit: 1_048_576, // 1 MB default body limit
  });

  // --- Plugins -----------------------------------------------------------

  await fastify.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
    },
  });

  // --- Dependencies -------------------------------------------------------

  const db = await MongoDB.connect(config.MONGO_URI);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);
  const kafkaProducer = new KafkaProducer(config.KAFKA_BROKERS);
  await kafkaProducer.connect();

  fastify.decorate("db", db);
  fastify.decorate("vectorStore", vectorStore);
  fastify.decorate("kafkaProducer", kafkaProducer);
  fastify.decorate("config", config);

  // --- Auth hook (skip /health) -------------------------------------------

  fastify.addHook("onRequest", async (request, reply) => {
    const publicPaths = ["/health", "/api/auth/login"];
    if (publicPaths.includes(request.url)) return;
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // --- Routes -------------------------------------------------------------

  await fastify.register(healthRoutes);
  await fastify.register(authRoutes, { prefix: "/api" });
  await fastify.register(documentRoutes, { prefix: "/api" });
  await fastify.register(queryRoutes, { prefix: "/api" });
  await fastify.register(dashboardRoutes, { prefix: "/api" });

  // --- Graceful shutdown ---------------------------------------------------

  const shutdown = async () => {
    fastify.log.info("Shutting down...");
    await fastify.close();
    await kafkaProducer.disconnect();
    await vectorStore.close();
    await db.disconnect();
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
