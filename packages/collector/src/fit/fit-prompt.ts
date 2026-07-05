import type Anthropic from "@anthropic-ai/sdk";
import { SIGNAL_IDS, type SignalDef, type SignalStrength } from "@sa/shared";
import type { ExtractionInput } from "./signal-extractor";

/**
 * シグナル抽出プロンプト（詳細設計 §A-6 / §C-2）。
 * 変更時は PROMPT_VERSION を上げる（snapshot テストの更新とセット — §F-2 のレビュー規約）。
 */
export const PROMPT_VERSION = "v1";

/** 1 スニペットの最大文字数（§C-2 user テンプレート「8,000 字でスライス」）。 */
export const SNIPPET_SLICE_CHARS = 8_000;

/**
 * record_signals ツール定義（§A-6）。tool_choice で強制する。
 * strength / checkedAt / source は LLM に書かせない（カタログとコードが付与）。
 */
export const RECORD_SIGNALS_TOOL: Anthropic.Tool = {
  name: "record_signals",
  description: "収集済みコンテンツから検出した Fit 判定シグナルを全件記録する",
  input_schema: {
    type: "object",
    required: ["signals"],
    properties: {
      signals: {
        type: "array",
        // カタログ全件を必ず 1 回ずつ（判定漏れ防止）
        minItems: SIGNAL_IDS.length,
        maxItems: SIGNAL_IDS.length,
        items: {
          type: "object",
          required: ["signalId", "detected", "evidence", "insufficientHistory"],
          properties: {
            signalId: { type: "string", enum: [...SIGNAL_IDS] },
            detected: { type: "boolean" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                required: ["url", "quoteSummary"],
                properties: {
                  url: {
                    type: "string",
                    description: "引用可能URLリスト内のURLのみ",
                  },
                  quoteSummary: {
                    type: "string",
                    maxLength: 300,
                    description: "根拠の要約。原文の逐語転載は禁止",
                  },
                },
              },
            },
            insufficientHistory: {
              type: "boolean",
              description:
                "時系列情報（掲載開始日・過去求人票）が無く判定不能の場合 true。1-1/1-2 以外は常に false",
            },
          },
        },
      },
    },
  },
};

const STRENGTH_JA: Record<SignalStrength, string> = {
  strong: "強い",
  weak: "弱い",
  counter: "逆指標",
};

export function buildFitSystemPrompt(
  catalog: readonly SignalDef[],
): string {
  const rendered = catalog
    .map(
      (def) =>
        `### ${def.id} ${def.name}（${STRENGTH_JA[def.strength]}）\n${def.detectionHint}`,
    )
    .join("\n\n");

  return `あなたは B2B 営業のリサーチアナリストです。収集済みの公開 Web コンテンツだけを根拠に、
対象企業について以下の「シグナルカタログ」の各シグナルを検出します。

ルール:
1. 必ず record_signals ツールを 1 回呼び、カタログの全 ${catalog.length} シグナルをそれぞれ 1 エントリずつ返す。
2. evidence の url は、ユーザーメッセージ内の「引用可能 URL リスト」にある URL のみ使用する。
   リスト外の URL・記憶・推測に基づく evidence は禁止。
3. 根拠となる記述が見つからないシグナルは detected: false・evidence: [] で返す。
   迷った場合は必ず detected: false に倒す（偽陽性より偽陰性を選ぶ）。
4. quoteSummary は自分の言葉での要約に限る。原文の逐語転載・長文引用は禁止（最大300字）。
5. need_level（high/medium 等）の判定はしない。あなたの仕事は個々のシグナルの検出のみ。
6. 掲載開始日・過去の求人票との比較が必要なシグナル（1-1, 1-2）で、コンテキストに
   時系列情報が無い場合は detected: false かつ insufficientHistory: true で返す。
7. 口コミシグナル（2-1）の情報はコンテキストに含まれない。常に detected: false で返す。

## シグナルカタログ
${rendered}`;
}

export function buildFitUserMessage(input: ExtractionInput): string {
  const urlList = input.allowedUrls.join("\n");
  const contents = input.snippets
    .map((s, i) => {
      const body = s.markdown.slice(0, SNIPPET_SLICE_CHARS);
      return `[${i + 1}] ${s.url}（種別: ${s.sourceKind} / 取得日: ${s.fetchedAt}）\n${body}`;
    })
    .join("\n\n");

  return `対象企業: ${input.company.name}（${input.company.domain}）
本日の日付: ${input.today}

## 引用可能 URL リスト
${urlList}

## 収集済みコンテンツ
${contents}`;
}
