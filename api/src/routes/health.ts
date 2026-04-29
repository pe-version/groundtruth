import type { FastifyInstance } from "fastify";

// Deep health check. Returns 200 only when the API can actually serve
// requests — which requires Postgres to be reachable. A load balancer
// using this endpoint will drop a Postgres-disconnected instance from
// rotation rather than route real traffic at it.
//
// Kept off the /api prefix so it stays public and its auth surface is
// trivially zero. Rate limit caps probe traffic to a sensible bound.
export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/health",
    {
      config: {
        public: true,
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        await fastify.db.ping();
        return { status: "ok" };
      } catch (err) {
        request.log.warn({ err }, "Health probe failed: Postgres unreachable");
        return reply.code(503).send({ status: "unhealthy", reason: "postgres" });
      }
    }
  );
}
