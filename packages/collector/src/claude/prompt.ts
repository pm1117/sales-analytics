import type { Company } from "@sa/shared";

export interface ContextSnippet {
  sourceUrl: string;
  text: string;
}

export interface DossierPromptInput {
  company: Company;
  snippets: ContextSnippet[];
  /** ユーザーが登録した自社プロダクト情報（文面パーソナライズ用）。 */
  selfProduct?: string;
  /** 取得できなかったソースの注記（透明性のためカルテに反映）。 */
  gaps: string[];
}

export const DOSSIER_SYSTEM_PROMPT = `あなたは BtoB 営業のためのリサーチアナリストです。
与えられた公開 Web の抜粋（出典 URL 付き）だけを根拠に、営業担当者向けの「リサーチカルテ」を作成します。

厳守事項:
- すべての事実記述に出典を [n] 形式で付与する（n は与えた抜粋番号）。
- 抜粋に無い情報は推測で断定しない。推測は「仮説:」と明示する。
- 個人情報は公開ビジネス情報（役職・登壇・公開発信）に限定する。

出力は日本語の Markdown で、次の 7 セクション構成:
1. 事業サマリー
2. 攻め筋の仮説
3. 刺さる文脈（フック）
4. キーパーソン候補
5. 競合利用状況
6. パーソナライズ文面案
7. 出典リンク（使用した [n] と URL の対応表）`;

/** 抜粋を番号付きコンテキストに整形し、user メッセージ本文を作る。 */
export function buildDossierUserMessage(input: DossierPromptInput): string {
  const sources = input.snippets
    .map((s, i) => `[${i + 1}] ${s.sourceUrl}\n${s.text}`)
    .join("\n\n---\n\n");

  const parts = [
    `# 対象企業\n${input.company.name}（${input.company.domain}）`,
    input.selfProduct
      ? `# 自社プロダクト情報（文面パーソナライズに使用）\n${input.selfProduct}`
      : "",
    input.gaps.length > 0
      ? `# 取得できなかったソース（カルテに注記すること）\n- ${input.gaps.join("\n- ")}`
      : "",
    `# 収集済みの抜粋（出典付き。これ以外は使わないこと）\n${sources}`,
  ];
  return parts.filter((p) => p.length > 0).join("\n\n");
}
