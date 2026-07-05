import type {
  AssessmentCost,
  AssessmentInput,
  AssessmentListItem,
  AssessmentStage,
  AssessmentStatus,
  CareersCheck,
  FitAssessment,
  HumanReview,
  MismatchReason,
  NeedLevel,
  SignalId,
  SignalResult,
} from "@sa/shared";
import type { Db } from "../db";

/**
 * fit_assessments（migration 0002_fit.sql）のリポジトリ。詳細設計 §A-5 / §B-1。
 * signals 等は JSONB にそのまま格納（camelCase のまま）。counterSignals は read 時に導出する。
 */

interface AssessmentRow {
  id: string;
  status: AssessmentStatus;
  stage: AssessmentStage;
  need_level: NeedLevel | null;
  signals: SignalResult[] | null;
  missing_data: SignalId[] | null;
  careers_check: CareersCheck | null;
  rationale: string | null;
  input: AssessmentInput;
  signals_version: string;
  prompt_version: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  error: string | null;
  human_need_level: NeedLevel | null;
  mismatch_reason: MismatchReason | null;
  human_reviewed_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  company_id: string;
  company_name: string;
  company_domain: string;
}

const SELECT_FULL = `
  SELECT a.id, a.status, a.stage, a.need_level, a.signals, a.missing_data,
         a.careers_check, a.rationale, a.input, a.signals_version, a.prompt_version,
         a.model, a.input_tokens, a.output_tokens, a.duration_ms, a.error,
         a.human_need_level, a.mismatch_reason, a.human_reviewed_at,
         a.created_at, a.finished_at,
         c.id AS company_id, c.name AS company_name, c.domain AS company_domain
    FROM fit_assessments a
    JOIN companies c ON c.id = a.company_id`;

function mapRow(r: AssessmentRow): FitAssessment {
  const signals = r.signals ?? [];
  const cost: AssessmentCost | null =
    r.model !== null && r.duration_ms !== null
      ? {
          model: r.model,
          inputTokens: r.input_tokens ?? 0,
          outputTokens: r.output_tokens ?? 0,
          durationMs: r.duration_ms,
        }
      : null;
  const humanReview: HumanReview | null =
    r.human_need_level !== null && r.human_reviewed_at !== null
      ? {
          needLevel: r.human_need_level,
          mismatchReason: r.mismatch_reason,
          reviewedAt: r.human_reviewed_at.toISOString(),
        }
      : null;
  return {
    id: r.id,
    status: r.status,
    stage: r.stage,
    company: {
      id: r.company_id,
      name: r.company_name,
      domain: r.company_domain,
    },
    input: r.input,
    signalsVersion: r.signals_version,
    promptVersion: r.prompt_version,
    // judgedAt = 判定完了時刻（succeeded のみ）
    judgedAt:
      r.status === "succeeded" && r.finished_at
        ? r.finished_at.toISOString()
        : null,
    needLevel: r.need_level,
    signals,
    counterSignals: signals
      .filter((s) => s.detected && s.strength === "counter")
      .map((s) => s.id),
    missingData: r.missing_data ?? [],
    careersCheck: r.careers_check,
    rationale: r.rationale,
    humanReview,
    cost,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export interface FitAssessmentInsert {
  companyId: string;
  input: AssessmentInput;
  signalsVersion: string;
  promptVersion: string;
}

export interface FitAssessmentSuccess {
  needLevel: NeedLevel;
  signals: SignalResult[];
  missingData: SignalId[];
  careersCheck: CareersCheck | null;
  rationale: string;
  cost: AssessmentCost;
}

export class FitAssessmentRepo {
  constructor(private readonly db: Db) {}

  /** status=running / stage=collect で新規行を作り id を返す。 */
  async insert(params: FitAssessmentInsert): Promise<string> {
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO fit_assessments (company_id, input, signals_version, prompt_version)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        params.companyId,
        JSON.stringify(params.input),
        params.signalsVersion,
        params.promptVersion,
      ],
    );
    return (row as { id: string }).id;
  }

  async updateStage(id: string, stage: AssessmentStage): Promise<void> {
    await this.db.query(
      `UPDATE fit_assessments SET stage = $2 WHERE id = $1`,
      [id, stage],
    );
  }

  async finishSuccess(id: string, result: FitAssessmentSuccess): Promise<void> {
    await this.db.query(
      `UPDATE fit_assessments
          SET status = 'succeeded', stage = 'done', need_level = $2,
              signals = $3, missing_data = $4, careers_check = $5, rationale = $6,
              model = $7, input_tokens = $8, output_tokens = $9, duration_ms = $10,
              finished_at = now()
        WHERE id = $1`,
      [
        id,
        result.needLevel,
        JSON.stringify(result.signals),
        JSON.stringify(result.missingData),
        result.careersCheck ? JSON.stringify(result.careersCheck) : null,
        result.rationale,
        result.cost.model,
        result.cost.inputTokens,
        result.cost.outputTokens,
        result.cost.durationMs,
      ],
    );
  }

  async finishFailure(
    id: string,
    stage: AssessmentStage,
    error: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE fit_assessments
          SET status = 'failed', stage = $2, error = $3, finished_at = now()
        WHERE id = $1`,
      [id, stage, error],
    );
  }

  async get(id: string): Promise<FitAssessment | null> {
    const row = await this.db.queryOne<AssessmentRow>(
      `${SELECT_FULL} WHERE a.id = $1`,
      [id],
    );
    return row ? mapRow(row) : null;
  }

  /** 企業ごと最新 1 件を created_at 降順で（§A-4 GET /assessments）。 */
  async list(): Promise<AssessmentListItem[]> {
    const rows = await this.db.query<AssessmentRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (a.company_id)
                a.id, a.status, a.stage, a.need_level, a.signals, a.missing_data,
                a.careers_check, a.rationale, a.input, a.signals_version, a.prompt_version,
                a.model, a.input_tokens, a.output_tokens, a.duration_ms, a.error,
                a.human_need_level, a.mismatch_reason, a.human_reviewed_at,
                a.created_at, a.finished_at,
                c.id AS company_id, c.name AS company_name, c.domain AS company_domain
           FROM fit_assessments a
           JOIN companies c ON c.id = a.company_id
          ORDER BY a.company_id, a.created_at DESC
       ) latest ORDER BY latest.created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      company: { name: r.company_name, domain: r.company_domain },
      status: r.status,
      stage: r.stage,
      needLevel: r.need_level,
      humanNeedLevel: r.human_need_level,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async setHumanReview(
    id: string,
    review: { needLevel: NeedLevel; mismatchReason: MismatchReason | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE fit_assessments
          SET human_need_level = $2, mismatch_reason = $3, human_reviewed_at = now()
        WHERE id = $1`,
      [id, review.needLevel, review.mismatchReason],
    );
  }

  /** 多重実行防止（§A-4 POST 409 already_running）。 */
  async hasRunning(companyId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM fit_assessments WHERE company_id = $1 AND status = 'running'
       ) AS exists`,
      [companyId],
    );
    return row?.exists ?? false;
  }

  /** サーバー起動時: 孤児化した running を failed に倒す（基本設計 §9 リスク 5）。 */
  async markInterrupted(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE fit_assessments
          SET status = 'failed', error = 'interrupted', finished_at = now()
        WHERE status = 'running' RETURNING id`,
    );
    return rows.length;
  }
}
