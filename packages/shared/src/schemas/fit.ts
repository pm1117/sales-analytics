import { z } from "zod";
import { MISMATCH_REASONS, NEED_LEVELS, SIGNAL_IDS } from "../types/fit";

/**
 * Fit 判定の zod スキーマ。詳細設計 §A-3 に対応。
 * API バリデーション（server/routes/assessment.ts）と
 * LLM structured output 検証（fit/signal-extractor.ts）の両方で使う。
 */

export const NeedLevelSchema = z.enum(NEED_LEVELS);
export const SignalIdSchema = z.enum(SIGNAL_IDS);
export const MismatchReasonSchema = z.enum(MISMATCH_REASONS);

export const SeedUrlSchema = z.object({
  kind: z.enum(["careers", "jobs_media"]),
  url: z.string().url(),
});

export const ManualInputSchema = z.object({
  signalId: SignalIdSchema,
  url: z.string().url(),
  quoteSummary: z.string().min(1).max(300),
  checkedAt: z.string().min(1),
});

/** POST /assessments のリクエストボディ。 */
export const AssessmentInputSchema = z.object({
  companyNameOrUrl: z.string().min(1),
  seedUrls: z.array(SeedUrlSchema).max(10).optional(),
  manualInputs: z.array(ManualInputSchema).max(20).optional(),
  allowManaged: z.boolean().optional(),
});
export type AssessmentInputParsed = z.infer<typeof AssessmentInputSchema>;

/** PATCH /assessments/:id/human-review のリクエストボディ。 */
export const HumanReviewSchema = z.object({
  needLevel: NeedLevelSchema,
  mismatchReason: MismatchReasonSchema.nullable(),
});
export type HumanReviewParsed = z.infer<typeof HumanReviewSchema>;

/**
 * LLM の record_signals ツール出力（詳細設計 §A-6 の JSON スキーマと同型）。
 * strength / checkedAt / source は LLM に書かせない（カタログとコードが付与する）。
 */
export const RawSignalSchema = z.object({
  signalId: SignalIdSchema,
  detected: z.boolean(),
  evidence: z.array(
    z.object({
      url: z.string(),
      quoteSummary: z.string().max(300),
    }),
  ),
  insufficientHistory: z.boolean(),
});
export type RawSignal = z.infer<typeof RawSignalSchema>;

export const ExtractorOutputSchema = z
  .object({
    // カタログ全 14 件を必ず 1 回ずつ（判定漏れ防止）
    signals: z.array(RawSignalSchema).length(SIGNAL_IDS.length),
  })
  .superRefine((value, ctx) => {
    const seen = new Set(value.signals.map((s) => s.signalId));
    if (seen.size !== SIGNAL_IDS.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signals"],
        message: `signalId が重複している（全 ${SIGNAL_IDS.length} シグナルを 1 回ずつ返すこと）`,
      });
    }
  });
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;
