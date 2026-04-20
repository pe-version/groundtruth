import type { FastifyInstance } from "fastify";

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", { config: { public: true } }, async () => {
    return { status: "ok" };
  });
}
