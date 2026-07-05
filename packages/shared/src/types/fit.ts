/**
 * Fit 判定 PoC の型。詳細設計 docs/ui/fit-validation-detailed-design.md §A-1 に対応。
 * collector（判定パイプライン）と web（表示）の両方から import するため shared に置く。
 * zod スキーマ（schemas/fit.ts）と ID リストを共有するため、enum 系は as const 配列を正とする。
 */

// ---- 基本 enum ----
export const NEED_LEVELS = ["high", "medium", "low", "unknown"] as const;
export type NeedLevel = (typeof NEED_LEVELS)[number];

export type SignalStrength = "strong" | "weak" | "counter";

export const SIGNAL_IDS = [
  "1-1", "1-2", "1-3", "1-4", "1-5", // 求人
  "2-1",                             // 口コミ
  "3-1", "3-2",                      // 経営
  "4-1", "4-2",                      // 競合・提携（逆指標）
  "5-1", "5-2", "5-3", "5-4",        // 補助
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export type AssessmentStatus = "running" | "succeeded" | "failed";
export type AssessmentStage = "collect" | "extract" | "judge" | "done";
export type EvidenceSource = "extracted" | "manual" | "careers_probe";

export const MISMATCH_REASONS = [
  "collection_gap",    // 収集漏れ
  "extraction_error",  // 抽出ミス
  "rule_issue",        // 集約ルールの問題
  "private_info",      // 人間側の根拠が非公開情報（要件 §8-3）
] as const;
export type MismatchReason = (typeof MISMATCH_REASONS)[number];

/** 逆指標の深刻度。fatal/major は low 直行、minor のみ medium を許す（詳細設計 §C-3）。 */
export type CounterSeverity = "fatal" | "major" | "minor";

// ---- 判定結果の構成要素 ----
export interface Evidence {
  /** 収集済み canonical URL / 手動確認 URL に限る（詳細設計 §C-5 の捏造ガード）。 */
  url: string;
  /** 要約のみ。逐語転載禁止（法務）。 */
  quoteSummary: string;
  /** ISO8601。extracted はコードが実行日を付与（LLM に書かせない）。 */
  checkedAt: string;
  source: EvidenceSource;
}

export interface SignalResult {
  id: SignalId;
  detected: boolean;
  /** カタログ（signal-catalog.ts）から引く。LLM 出力の強度は使わない。 */
  strength: SignalStrength;
  /** detected=true なら 1 件以上（0 件になったら detected=false に落とす）。 */
  evidence: Evidence[];
  /** 1-1/1-2 の時系列不足（要件 F2）。judge 上は「検出なし」扱い。 */
  insufficientHistory: boolean;
}

export interface CareersCheck {
  /** 404・robots ブロック含む確認済み URL 全件（シグナル 1-5 の根拠）。 */
  checkedUrls: string[];
  foundUrl: string | null;
}

export interface AssessmentCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** collect 開始〜persist 完了（S5 コスト実測）。 */
  durationMs: number;
}

export interface HumanReview {
  needLevel: NeedLevel;
  /** AI 判定と一致なら null。 */
  mismatchReason: MismatchReason | null;
  reviewedAt: string;
}

// ---- 入力 ----
export interface SeedUrl {
  kind: "careers" | "jobs_media";
  url: string;
}

export interface ManualInput {
  signalId: SignalId;
  url: string;
  quoteSummary: string;
  /** 人間が確認した日（YYYY-MM-DD 可）。 */
  checkedAt: string;
}

export interface AssessmentInput {
  companyNameOrUrl: string;
  seedUrls?: SeedUrl[];
  manualInputs?: ManualInput[];
  /** 既存 Gate4（managed crawl）opt-in と同じ。 */
  allowManaged?: boolean;
}

// ---- 集約ルート型 ----
export interface FitAssessment {
  id: string;
  status: AssessmentStatus;
  stage: AssessmentStage;
  company: { id: string; name: string; domain: string };
  /** 再実行の再現用（DB input カラムの写し）。 */
  input: AssessmentInput;
  signalsVersion: string;
  promptVersion: string;
  judgedAt: string | null;
  needLevel: NeedLevel | null;
  /** カタログ全 14 件ぶん必ず存在（detected=false 含む）。 */
  signals: SignalResult[];
  /** signals から導出（detected && strength=counter）。DB カラムには持たない。 */
  counterSignals: SignalId[];
  /** 取得不可・履歴不足のシグナル。 */
  missingData: SignalId[];
  careersCheck: CareersCheck | null;
  rationale: string | null;
  humanReview: HumanReview | null;
  cost: AssessmentCost | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** GET /assessments 一覧の 1 行（詳細設計 §A-4）。 */
export interface AssessmentListItem {
  id: string;
  company: { name: string; domain: string };
  status: AssessmentStatus;
  stage: AssessmentStage;
  needLevel: NeedLevel | null;
  humanNeedLevel: NeedLevel | null;
  createdAt: string;
}
