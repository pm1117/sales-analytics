import type Anthropic from "@anthropic-ai/sdk";
import {
  ExtractorOutputSchema,
  SIGNAL_CATALOG,
  type RawSignal,
  type SourceKind,
} from "@sa/shared";
import {
  RECORD_SIGNALS_TOOL,
  SNIPPET_SLICE_CHARS,
  buildFitSystemPrompt,
  buildFitUserMessage,
} from "./fit-prompt";

/**
 * 収集 Markdown からのシグナル抽出（詳細設計 §B-1 / §C-2）。
 * Fit 判定層で唯一 LLM を呼ぶ場所。tool use を強制し、出力は zod で検証する。
 * evidence の URL 突合・strength 付与は evidence-filter（orchestrator 側）が行う。
 */

export interface ContentSnippet {
  url: string;
  sourceKind: SourceKind;
  /** ISO8601（表示用にそのままプロンプトへ入る）。 */
  fetchedAt: string;
  markdown: string;
}

export interface ExtractionInput {
  company: { name: string; domain: string };
  /** §C-2 の組み立て順（careers → jobs_media → press → hp）で渡す。 */
  snippets: ContentSnippet[];
  /** 引用可能 URL リスト（収集済み canonical URL + careersCheck.checkedUrls）。 */
  allowedUrls: string[];
  /** 「本日の日付」。呼び出し側が渡す（プロンプトを決定的にし snapshot 可能にするため）。 */
  today: string;
}

export interface ExtractionResult {
  /** zod 検証済みの生シグナル（全 14 件）。URL 突合前。 */
  signals: RawSignal[];
  usage: { inputTokens: number; outputTokens: number };
  /** トークン予算超過で後方（hp 側）から落としたソース（呼び出し側でログする — §C-2）。 */
  droppedSnippetUrls: string[];
}

export interface SignalExtractorOpts {
  model: string;
  /** 文字数予算 = maxContextTokens * 3（既存 buildContext と同方式）。 */
  maxContextTokens: number;
}

const MAX_OUTPUT_TOKENS = 4096;

export class SignalExtractor {
  constructor(
    private readonly client: Anthropic,
    private readonly opts: SignalExtractorOpts,
  ) {}

  /** zod 検証失敗・tool_use 欠落は 1 回だけリトライ（エラー内容を追記して再送）→ 失敗なら throw。 */
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { snippets, droppedSnippetUrls } = pruneToBudget(
      input.snippets,
      this.opts.maxContextTokens * 3,
    );
    const system = buildFitSystemPrompt(SIGNAL_CATALOG);
    const baseMessage = buildFitUserMessage({ ...input, snippets });

    const usage = { inputTokens: 0, outputTokens: 0 };
    let lastError = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      const content =
        attempt === 0
          ? baseMessage
          : `${baseMessage}\n\n## 再送\n前回の出力はスキーマ検証に失敗しました:\n${lastError}\nrecord_signals ツールを正しいスキーマで再実行してください。`;

      const message = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content }],
        tools: [RECORD_SIGNALS_TOOL],
        tool_choice: { type: "tool", name: RECORD_SIGNALS_TOOL.name },
      });
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;

      const toolUse = message.content.find(
        (b): b is Anthropic.ToolUseBlock =>
          b.type === "tool_use" && b.name === RECORD_SIGNALS_TOOL.name,
      );
      if (!toolUse) {
        lastError = "record_signals の tool_use ブロックが返されなかった";
        continue;
      }

      const parsed = ExtractorOutputSchema.safeParse(toolUse.input);
      if (parsed.success) {
        return { signals: parsed.data.signals, usage, droppedSnippetUrls };
      }
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");
    }

    throw new Error(`signal extraction failed after retry: ${lastError}`);
  }
}

/**
 * §C-2 のトークン予算。snippets は組み立て順（careers → … → hp）で渡される前提で、
 * 予算を超えた位置以降（後方 = 優先度の低い側）をまとめて落とす。先頭 1 件は必ず残す。
 */
function pruneToBudget(
  snippets: ContentSnippet[],
  budgetChars: number,
): { snippets: ContentSnippet[]; droppedSnippetUrls: string[] } {
  const kept: ContentSnippet[] = [];
  const droppedSnippetUrls: string[] = [];
  let total = 0;
  let overflowed = false;

  for (const s of snippets) {
    const len = Math.min(s.markdown.length, SNIPPET_SLICE_CHARS);
    if (overflowed || (total + len > budgetChars && kept.length > 0)) {
      overflowed = true;
      droppedSnippetUrls.push(s.url);
    } else {
      kept.push(s);
      total += len;
    }
  }
  return { snippets: kept, droppedSnippetUrls };
}
