import type { FastifyInstance } from "fastify";
import type { MongoDB } from "@direze/shared";

export async function dashboardRoutes(fastify: FastifyInstance) {
  const db: MongoDB = (fastify as any).db;

  fastify.get("/dashboard/stats", async () => {
    const summary = await db.getStatusSummary();

    const total = summary.reduce((acc, s) => acc + s.count, 0);
    const byStatus: Record<string, number> = {};
    for (const s of summary) {
      byStatus[s.status] = s.count;
    }

    return {
      total,
      byStatus,
      ready: byStatus["ready"] ?? 0,
      processing: byStatus["processing"] ?? 0,
      pending: byStatus["pending"] ?? 0,
      failed: byStatus["failed"] ?? 0,
    };
  });
}
