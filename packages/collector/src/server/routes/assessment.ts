import type { FastifyInstance } from "fastify";
import {
  AssessmentInputSchema,
  HumanReviewSchema,
  SIGNALS_VERSION,
  type AssessmentInput,
} from "@sa/shared";
import { PROMPT_VERSION } from "../../fit/fit-prompt";
import { DomainRequiredError } from "../../orchestrator/dossier-orchestrator";
import type { FitOrchestrator } from "../../fit/fit-orchestrator";
import type { FitAssessmentRepo } from "../../storage/repositories/fit-assessment-repo";

/**
 * /assessments エンドポイント群（詳細設計 §A-4）。
 * POST は 202 を即返す非同期方式 — 実行は in-process fire-and-forget、進捗は
 * fit_assessments.status/stage をポーリングで読む。失敗も GET では 200 で返す
 * （ポーリングを壊さないため）。既存 /dossiers には触れない（並存 — 基本 §4-3）。
 */

export interface AssessmentRouteDeps {
  orchestrator: Pick<FitOrchestrator, "resolveCompany" | "run">;
  fitRepo: Pick<
    FitAssessmentRepo,
    "insert" | "get" | "list" | "setHumanReview" | "hasRunning"
  >;
}

/** zod の optional（`| undefined`）を exactOptionalPropertyTypes 互換の形に落とす。 */
function toInput(p: {
  companyNameOrUrl: string;
  seedUrls?: AssessmentInput["seedUrls"] | undefined;
  manualInputs?: AssessmentInput["manualInputs"] | undefined;
  allowManaged?: boolean | undefined;
}): AssessmentInput {
  return {
    companyNameOrUrl: p.companyNameOrUrl,
    ...(p.seedUrls !== undefined ? { seedUrls: p.seedUrls } : {}),
    ...(p.manualInputs !== undefined ? { manualInputs: p.manualInputs } : {}),
    ...(p.allowManaged !== undefined ? { allowManaged: p.allowManaged } : {}),
  };
}

export function registerAssessmentRoutes(
  app: FastifyInstance,
  deps: AssessmentRouteDeps,
): void {
  // ---- POST /assessments — 判定開始（202 非同期） ----
  app.post("/assessments", async (req, reply) => {
    const parsed = AssessmentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_request", issues: parsed.error.issues };
    }
    const input = toInput(parsed.data);

    let companyId: string;
    try {
      companyId = (await deps.orchestrator.resolveCompany(input.companyNameOrUrl)).id;
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
      throw err;
    }

    if (await deps.fitRepo.hasRunning(companyId)) {
      reply.code(409);
      return {
        error: "already_running",
        message: "この企業の判定は実行中です。完了を待ってから再実行してください。",
      };
    }

    const assessmentId = await deps.fitRepo.insert({
      companyId,
      input,
      signalsVersion: SIGNALS_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    // fire-and-forget（§A-4）。run() は throw しない設計（§C-6）
    void deps.orchestrator.run(assessmentId, input);

    reply.code(202);
    return { assessmentId, status: "running" };
  });

  // ---- GET /assessments — 一覧（企業ごと最新） ----
  app.get("/assessments", async () => {
    return { items: await deps.fitRepo.list() };
  });

  // ---- GET /assessments/:id — ポーリング先。failed も 200 ----
  app.get<{ Params: { id: string } }>("/assessments/:id", async (req, reply) => {
    const assessment = await deps.fitRepo.get(req.params.id);
    if (!assessment) {
      reply.code(404);
      return { error: "not_found", message: "assessment が見つかりません" };
    }
    return assessment;
  });

  // ---- PATCH /assessments/:id/human-review — 人間判定の記録（要件 §8） ----
  app.patch<{ Params: { id: string } }>(
    "/assessments/:id/human-review",
    async (req, reply) => {
      const parsed = HumanReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_request", issues: parsed.error.issues };
      }

      const assessment = await deps.fitRepo.get(req.params.id);
      if (!assessment) {
        reply.code(404);
        return { error: "not_found", message: "assessment が見つかりません" };
      }
      if (assessment.status !== "succeeded") {
        reply.code(409);
        return {
          error: "not_finished",
          message: "判定完了前の assessment には人間評価を記録できません",
        };
      }

      await deps.fitRepo.setHumanReview(req.params.id, parsed.data);
      return deps.fitRepo.get(req.params.id);
    },
  );
}
