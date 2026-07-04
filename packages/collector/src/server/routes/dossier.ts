import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DomainRequiredError,
  type DossierOrchestrator,
} from "../../orchestrator/dossier-orchestrator";

const BodySchema = z.object({
  companyNameOrUrl: z.string().min(1),
  allowManaged: z.boolean().optional(),
  selfProduct: z.string().optional(),
});

export function registerDossierRoute(
  app: FastifyInstance,
  orchestrator: DossierOrchestrator,
): void {
  app.post("/dossiers", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_request", issues: parsed.error.issues };
    }

    const { companyNameOrUrl, allowManaged, selfProduct } = parsed.data;
    try {
      const dossier = await orchestrator.run({
        companyNameOrUrl,
        ...(allowManaged !== undefined ? { allowManaged } : {}),
        ...(selfProduct !== undefined ? { selfProduct } : {}),
      });
      return dossier;
    } catch (err) {
      if (err instanceof DomainRequiredError) {
        reply.code(409);
        return {
          error: "domain_required",
          message:
            "企業名からドメインを特定できません。URL で指定してください。",
          companyName: err.companyName,
        };
      }
      req.log.error({ err }, "dossier generation failed");
      reply.code(502);
      return { error: "generation_failed", message: String(err) };
    }
  });
}
