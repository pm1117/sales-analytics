import type {
  CounterSeverity,
  SignalId,
  SignalStrength,
} from "../types/fit";

/**
 * シグナルカタログ（データ）。docs/ui/fit-validation-signals.md v0.2 と 1:1。
 * judge の強度・プロンプトの判定基準文・web の表示名がすべてここを参照する
 * （定義の一元化 — 要件 §4-3 のバージョン管理単位。改訂時は SIGNALS_VERSION を上げる）。
 * 詳細設計 §A-2 / §C-1 / §C-2 に対応。
 */

export type SignalCategory =
  | "jobs"        // §1 求人（最優先）
  | "reviews"     // §2 口コミ
  | "management"  // §3 経営
  | "competitor"  // §4 競合・提携（逆指標）
  | "auxiliary";  // §5 補助

/** シグナルの検出主体。manual は LLM に判定させない（常に detected=false で返させる）。 */
export type SignalDetector = "llm" | "manual" | "probe+llm";

export interface SignalDef {
  id: SignalId;
  name: string;
  category: SignalCategory;
  /** 集約判定で使う強度の正。LLM 出力の強度は使わない。 */
  strength: SignalStrength;
  /** strength=counter のみ。fatal/major → low 直行、minor のみ medium を許す（詳細設計 §C-3）。 */
  counterSeverity?: CounterSeverity;
  detector: SignalDetector;
  /** LLM への判定基準文。system prompt のカタログ節にそのまま埋め込む（詳細設計 §C-2）。 */
  detectionHint: string;
  /** true: 掲載開始日等の時系列が必要（1-1/1-2）。無ければ insufficientHistory。 */
  requiresHistory: boolean;
}

export const SIGNALS_VERSION = "v0.2";

export const SIGNAL_CATALOG: readonly SignalDef[] = [
  {
    id: "1-1",
    name: "同一エンジニア職種の長期募集（6ヶ月以上）",
    category: "jobs",
    strength: "strong",
    detector: "llm",
    requiresHistory: true,
    detectionHint:
      "同じエンジニア職種の求人が 6 ヶ月以上掲載され続けている場合に検出。求人の掲載開始日・更新履歴・「募集開始から◯ヶ月」等の記述を根拠にする。掲載期間を示す情報が無ければ insufficientHistory: true。中途に人気の企業が常時オープンにしているだけの可能性がある場合は、その旨を quoteSummary に付記する",
  },
  {
    id: "1-2",
    name: "募集条件の急な緩和（未経験可・他業種歓迎 等）",
    category: "jobs",
    strength: "strong",
    detector: "llm",
    requiresHistory: true,
    detectionHint:
      "「未経験可」「他業種歓迎」など、以前より応募条件を緩めた形跡がある場合に検出。変更前後の求人票または条件変更時期を示す記述が根拠として必要。現在の求人票 1 枚だけでは判定できない（insufficientHistory: true）",
  },
  {
    id: "1-3",
    name: "大手の大量エンジニア募集 / 大手完全子会社で 2 名以上の募集",
    category: "jobs",
    strength: "strong",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "大手企業による大量（目安 5 名以上）のエンジニア募集、または大手完全子会社での 2 名以上の同時募集を検出。会社規模はコンテキスト内の記述（従業員数・資本関係）から判断し、根拠を quoteSummary に含める",
  },
  {
    id: "1-4",
    name: "エンジニア職種の複数同時募集",
    category: "jobs",
    strength: "strong",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "エンジニア職種（バックエンド・フロントエンド・SRE 等）が同時に複数募集されている場合に検出。職種名と件数を quoteSummary に列挙する",
  },
  {
    id: "1-5",
    name: "コーポレートサイトにエンジニア求人が見当たらない",
    category: "jobs",
    strength: "counter",
    counterSeverity: "major", // リファラル採用疑い → 問合せ対象外（signals §1-5）
    detector: "probe+llm",
    requiresHistory: false,
    detectionHint:
      "自社コーポレートサイト・採用ページにエンジニア求人が見当たらない場合に検出。採用ページのコンテキストが与えられており、かつエンジニア募集の記載が無いことを確認できた場合のみ。採用ページ自体がコンテキストに無い場合は detected: false（システム側で別途判定する）",
  },
  {
    id: "2-1",
    name: "エンジニア向けネガティブ口コミの増加",
    category: "reviews",
    strength: "strong",
    detector: "manual", // 口コミサイトは自動収集しない（要件 §6-1）。manualInputs 由来のみ
    requiresHistory: false,
    detectionHint:
      "（検出しない — 口コミ情報はコンテキストに含まれない。常に detected: false で返す）",
  },
  {
    id: "3-1",
    name: "新規 Web サービス・アプリのリリース",
    category: "management",
    strength: "strong",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "新規の Web サービス・アプリのリリースを告知するプレスリリース・ニュースを検出。リリース日と製品名を quoteSummary に含める。既存サービスの機能追加・アップデートは含めない",
  },
  {
    id: "3-2",
    name: "採用急拡大・組織拡大の明示",
    category: "management",
    strength: "strong",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "「採用強化」「組織拡大」「◯名採用計画」等、採用・組織の急拡大を明示する記述を検出",
  },
  {
    id: "4-1",
    name: "同種サービス（エンジニア×企業ミスマッチ防止）の自社開発",
    category: "competitor",
    strength: "counter",
    counterSeverity: "fatal", // 競合 → 問合せ対象外
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "対象企業自身が「エンジニアと企業のミスマッチ防止・適性見極め・エンジニア採用支援」に類するサービスを開発・提供している場合に検出（＝競合）。サービス紹介・プロダクト求人の JD が根拠",
  },
  {
    id: "4-2",
    name: "同種サービス提供企業との業務提携",
    category: "competitor",
    strength: "counter",
    counterSeverity: "minor", // 対策済みの可能性はあるが、強い求人シグナル併存なら medium を許す
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "ミスマッチ防止・適性検査・エンジニアマッチング系サービスとの業務提携・導入事例の告知を検出（＝対策済みの可能性）。提携先サービス名を quoteSummary に含める",
  },
  {
    id: "5-1",
    name: "カルチャー・価値観・チームフィットの強調",
    category: "auxiliary",
    strength: "weak",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "採用ページ・求人票で「カルチャーフィット」「価値観」「チームとの相性」を重視する記述を検出",
  },
  {
    id: "5-2",
    name: "早期離職・定着・ミスマッチへの自社言及",
    category: "auxiliary",
    strength: "weak",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "早期離職・定着率・ミスマッチという課題への自社言及（ブログ・PR・採用ページ）を検出",
  },
  {
    id: "5-3",
    name: "採用ページ・採用ブランドの刷新",
    category: "auxiliary",
    strength: "weak",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "採用サイトのリニューアル・採用ブランディング刷新の告知を検出",
  },
  {
    id: "5-4",
    name: "技術職の難易度が高い募集（専門スキル・希少スタック）",
    category: "auxiliary",
    strength: "weak",
    detector: "llm",
    requiresHistory: false,
    detectionHint:
      "希少スキル・専門性の高い技術スタック（例: 特定領域の研究開発職、Findy 等ハイスキル媒体の利用）を要する募集を検出",
  },
];

/** id → 定義の逆引き（judge / evidence-filter / web で使用）。 */
export const SIGNAL_BY_ID: ReadonlyMap<SignalId, SignalDef> = new Map(
  SIGNAL_CATALOG.map((def) => [def.id, def]),
);
