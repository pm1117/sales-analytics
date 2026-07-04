/**
 * 法務・コンプライアンスポリシーの単一の真実。fetch_log 記録時などから参照する。
 * 生 Markdown の蓄積は著作権法 第30条の4（情報解析目的の複製）を根拠とする。
 */
export const COMPLIANCE_POLICY = {
  /** fetch_log.legal_basis の既定値と一致させる。 */
  legalBasis: "jp_copyright_art30_4",
  principles: [
    "robots.txt を尊重する（不許可なら取得しない）",
    "個人情報は公開ビジネス情報（役職・登壇・公開発信）に限定する",
    "全記述に出典 URL を付与する（ハルシネーション対策）",
    "アンチボットが厳しいサイトは公式 RSS/API を優先し、突破しない",
  ],
} as const;

export type CompliancePolicy = typeof COMPLIANCE_POLICY;
