import type { FastifyInstance } from "fastify";
import type { Db } from "../../storage/db";

export function registerHealthRoute(app: FastifyInstance, db: Db): void {
  app.get("/healthz", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      reply.code(503);
      return { status: "degraded", error: String(err) };
    }
  });
}
