import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { SIGNAL_CATALOG } from "@sa/shared";
import {
  SignalExtractor,
  type ExtractionInput,
} from "../src/fit/signal-extractor";

/** 全 14 件 undetected の正しい tool 出力。 */
function validToolInput() {
  return {
    signals: SIGNAL_CATALOG.map((def) => ({
      signalId: def.id,
      detected: false,
      evidence: [],
      insufficientHistory: false,
    })),
  };
}

function toolUseResponse(
  input: unknown,
  usage = { input_tokens: 100, output_tokens: 50 },
) {
  return {
    content: [
      { type: "tool_use", id: "tu_1", name: "record_signals", input },
    ],
    usage,
  };
}

function makeClient(responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

const input: ExtractionInput = {
  company: { name: "example", domain: "example.co.jp" },
  today: "2026-07-05",
  allowedUrls: ["https://example.co.jp/"],
  snippets: [
    {
      url: "https://example.co.jp/",
      sourceKind: "corporate_hp",
      fetchedAt: "2026-07-05T00:00:00Z",
      markdown: "会社概要",
    },
  ],
};

const opts = { model: "claude-opus-4-8", maxContextTokens: 180_000 };

describe("SignalExtractor（詳細設計 §B-1 / §F-3）", () => {
  it("正常系: tool_use → zod 通過で 14 シグナルと usage を返す", async () => {
    const { client, create } = makeClient([toolUseResponse(validToolInput())]);
    const result = await new SignalExtractor(client, opts).extract(input);

    expect(result.signals).toHaveLength(14);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0];
    expect(params.tool_choice).toEqual({
      type: "tool",
      name: "record_signals",
    });
    expect(params.model).toBe("claude-opus-4-8");
  });

  it("スキーマ不整合は 1 回リトライ（エラー内容を追記して再送）→ 成功。usage は合算", async () => {
    const invalid = { signals: validToolInput().signals.slice(0, 13) }; // 13 件 = length 不一致
    const { client, create } = makeClient([
      toolUseResponse(invalid, { input_tokens: 100, output_tokens: 50 }),
      toolUseResponse(validToolInput(), {
        input_tokens: 120,
        output_tokens: 60,
      }),
    ]);
    const result = await new SignalExtractor(client, opts).extract(input);

    expect(create).toHaveBeenCalledTimes(2);
    const retryContent = create.mock.calls[1]![0].messages[0].content as string;
    expect(retryContent).toContain("スキーマ検証に失敗");
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 110 });
  });

  it("リトライも失敗したら throw（zod issue を含む）", async () => {
    const invalid = { signals: [] };
    const { client, create } = makeClient([
      toolUseResponse(invalid),
      toolUseResponse(invalid),
    ]);
    await expect(
      new SignalExtractor(client, opts).extract(input),
    ).rejects.toThrow(/signal extraction failed after retry/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("tool_use ブロックが無い応答もリトライ対象", async () => {
    const { client, create } = makeClient([
      { content: [{ type: "text", text: "できません" }], usage: { input_tokens: 10, output_tokens: 5 } },
      toolUseResponse(validToolInput()),
    ]);
    const result = await new SignalExtractor(client, opts).extract(input);
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.signals).toHaveLength(14);
  });

  it("トークン予算超過時は後方（hp 側）のスニペットを落とし droppedSnippetUrls に記録", async () => {
    const { client, create } = makeClient([toolUseResponse(validToolInput())]);
    const budgeted: ExtractionInput = {
      ...input,
      snippets: [
        {
          url: "https://example.co.jp/recruit",
          sourceKind: "careers",
          fetchedAt: "2026-07-05T00:00:00Z",
          markdown: "採用ページ本文ダミー",
        },
        {
          url: "https://example.co.jp/",
          sourceKind: "corporate_hp",
          fetchedAt: "2026-07-05T00:00:00Z",
          markdown: "HP_MARKER 会社概要ダミー",
        },
      ],
    };
    // 予算 = 3 tokens * 3 = 9 文字 → 先頭（careers）のみ残る
    const result = await new SignalExtractor(client, {
      ...opts,
      maxContextTokens: 3,
    }).extract(budgeted);

    expect(result.droppedSnippetUrls).toEqual(["https://example.co.jp/"]);
    const sent = create.mock.calls[0]![0].messages[0].content as string;
    expect(sent).toContain("採用ページ本文ダミー");
    expect(sent).not.toContain("HP_MARKER");
  });
});
