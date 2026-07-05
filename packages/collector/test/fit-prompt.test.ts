import { describe, expect, it } from "vitest";
import { SIGNAL_CATALOG, SIGNAL_IDS } from "@sa/shared";
import {
  PROMPT_VERSION,
  RECORD_SIGNALS_TOOL,
  SNIPPET_SLICE_CHARS,
  buildFitSystemPrompt,
  buildFitUserMessage,
} from "../src/fit/fit-prompt";
import type { ExtractionInput } from "../src/fit/signal-extractor";

/**
 * snapshot の目的: 意図しないプロンプト変化の検知（詳細設計 §F-2）。
 * snapshot 更新を伴う変更では PROMPT_VERSION の bump を必須とする（レビュー規約）。
 */

// poc-output/bpio.co.jp/ の内容を縮約した固定 fixture（決定的 — 日付も固定）
const fixture: ExtractionInput = {
  company: { name: "bpio.co.jp", domain: "bpio.co.jp" },
  today: "2026-07-05",
  allowedUrls: ["https://bpio.co.jp/", "https://bpio.co.jp/news/1392"],
  snippets: [
    {
      url: "https://bpio.co.jp/",
      sourceKind: "corporate_hp",
      fetchedAt: "2026-07-04T17:00:25.506Z",
      markdown:
        "# BPIO\nバックオフィス支援の会社概要。事業内容とお知らせ一覧。",
    },
    {
      url: "https://bpio.co.jp/news/1392",
      sourceKind: "press_feed",
      fetchedAt: "2026-07-04T17:01:10.000Z",
      markdown: "## プレスリリース\n新サービス「◯◯」を 2026 年 6 月に提供開始。",
    },
  ],
};

describe("fit-prompt（詳細設計 §C-2 / §F-2）", () => {
  it(`system prompt snapshot（PROMPT_VERSION=${PROMPT_VERSION}）`, () => {
    expect(buildFitSystemPrompt(SIGNAL_CATALOG)).toMatchSnapshot();
  });

  it("user message snapshot", () => {
    expect(buildFitUserMessage(fixture)).toMatchSnapshot();
  });

  it("system にカタログ全 14 シグナルがレンダリングされる", () => {
    const system = buildFitSystemPrompt(SIGNAL_CATALOG);
    for (const id of SIGNAL_IDS) {
      expect(system).toContain(`### ${id} `);
    }
    expect(system).toContain(`全 ${SIGNAL_IDS.length} シグナル`);
  });

  it("user に引用可能 URL リストと本日の日付が入る", () => {
    const user = buildFitUserMessage(fixture);
    expect(user).toContain("## 引用可能 URL リスト");
    for (const url of fixture.allowedUrls) {
      expect(user).toContain(url);
    }
    expect(user).toContain("本日の日付: 2026-07-05");
  });

  it("スニペット本文は 8,000 字でスライスされる", () => {
    const long = "あ".repeat(SNIPPET_SLICE_CHARS + 100) + "END_MARKER";
    const user = buildFitUserMessage({
      ...fixture,
      snippets: [{ ...fixture.snippets[0]!, markdown: long }],
    });
    expect(user).not.toContain("END_MARKER");
  });

  it("record_signals ツールは 14 件固定・必須フィールドが §A-6 と一致", () => {
    const schema = RECORD_SIGNALS_TOOL.input_schema as {
      properties: {
        signals: {
          minItems: number;
          maxItems: number;
          items: { required: string[] };
        };
      };
    };
    expect(schema.properties.signals.minItems).toBe(14);
    expect(schema.properties.signals.maxItems).toBe(14);
    expect(schema.properties.signals.items.required).toEqual([
      "signalId",
      "detected",
      "evidence",
      "insufficientHistory",
    ]);
  });
});
