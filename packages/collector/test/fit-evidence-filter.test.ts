import { describe, expect, it } from "vitest";
import { SIGNAL_CATALOG, type RawSignal } from "@sa/shared";
import { filterEvidence } from "../src/fit/evidence-filter";

/** 全 14 件（extractor スキーマが保証する形）の RawSignal を作る。 */
function makeRaw(
  overrides: Partial<Record<string, Partial<RawSignal>>> = {},
): RawSignal[] {
  return SIGNAL_CATALOG.map((def) => ({
    signalId: def.id,
    detected: false,
    evidence: [],
    insufficientHistory: false,
    ...overrides[def.id],
  }));
}

const ALLOWED = new Set([
  "https://example.co.jp/recruit",
  "https://example.co.jp/news/123",
]);

describe("filterEvidence（詳細設計 §C-5 手順 1）", () => {
  it("allowedUrls 外の evidence を破棄し droppedCount に数える", () => {
    const { signals, droppedCount } = filterEvidence(
      makeRaw({
        "3-1": {
          detected: true,
          evidence: [
            { url: "https://example.co.jp/news/123", quoteSummary: "新サービス" },
            { url: "https://hallucinated.example.com/x", quoteSummary: "捏造" },
          ],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    const s31 = signals.find((s) => s.id === "3-1")!;
    expect(s31.detected).toBe(true);
    expect(s31.evidence).toHaveLength(1);
    expect(s31.evidence[0]!.url).toBe("https://example.co.jp/news/123");
    expect(droppedCount).toBe(1);
  });

  it("全 evidence が破棄されたシグナルは detected=false に落ちる（出典必須の機械的担保）", () => {
    const { signals, droppedCount } = filterEvidence(
      makeRaw({
        "1-4": {
          detected: true,
          evidence: [{ url: "https://elsewhere.com/", quoteSummary: "x" }],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    const s14 = signals.find((s) => s.id === "1-4")!;
    expect(s14.detected).toBe(false);
    expect(s14.evidence).toHaveLength(0);
    expect(droppedCount).toBe(1);
  });

  it("strength はカタログ値・checkedAt/source はコード付与", () => {
    const { signals } = filterEvidence(
      makeRaw({
        "4-1": {
          detected: true,
          evidence: [
            { url: "https://example.co.jp/recruit", quoteSummary: "同種開発" },
          ],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    const s41 = signals.find((s) => s.id === "4-1")!;
    expect(s41.strength).toBe("counter"); // カタログ値（LLM 出力に strength は無い）
    expect(s41.evidence[0]).toMatchObject({
      checkedAt: "2026-07-05",
      source: "extracted",
    });
  });

  it("URL 正規化差（末尾スラッシュ・utm・www）を同一視して突合する", () => {
    const { signals, droppedCount } = filterEvidence(
      makeRaw({
        "5-1": {
          detected: true,
          evidence: [
            {
              url: "http://www.example.co.jp/recruit/?utm_source=x",
              quoteSummary: "カルチャー重視",
            },
          ],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    expect(signals.find((s) => s.id === "5-1")!.detected).toBe(true);
    expect(droppedCount).toBe(0);
  });

  it("URL でない文字列の evidence は破棄する（例外にしない）", () => {
    const { signals, droppedCount } = filterEvidence(
      makeRaw({
        "5-2": {
          detected: true,
          evidence: [{ url: "見つかりませんでした", quoteSummary: "x" }],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    expect(signals.find((s) => s.id === "5-2")!.detected).toBe(false);
    expect(droppedCount).toBe(1);
  });

  it("detector=manual（2-1）の LLM 検出は evidence ごと破棄する（manualInputs のみ — §C-1）", () => {
    const { signals, droppedCount } = filterEvidence(
      makeRaw({
        "2-1": {
          detected: true,
          evidence: [
            { url: "https://example.co.jp/news/123", quoteSummary: "口コミ言及" },
          ],
        },
      }),
      ALLOWED,
      "2026-07-05",
    );
    const s21 = signals.find((s) => s.id === "2-1")!;
    expect(s21.detected).toBe(false);
    expect(s21.evidence).toHaveLength(0);
    expect(droppedCount).toBe(1);
  });
});
