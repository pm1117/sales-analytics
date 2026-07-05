import { describe, expect, it } from "vitest";
import {
  SIGNAL_CATALOG,
  type ManualInput,
  type SignalResult,
} from "@sa/shared";
import { mergeManualInputs } from "../src/fit/merge-manual";

function baseline(): SignalResult[] {
  return SIGNAL_CATALOG.map((def) => ({
    id: def.id,
    detected: false,
    strength: def.strength,
    evidence: [],
    insufficientHistory: false,
  }));
}

const openwork: ManualInput = {
  signalId: "2-1",
  url: "https://www.openwork.jp/company/xxx",
  quoteSummary: "エンジニアから評価制度への不満が直近 3 件",
  checkedAt: "2026-07-05",
};

describe("mergeManualInputs（詳細設計 §C-5 手順 3）", () => {
  it("2-1 に manual evidence を追加して detected=true にする", () => {
    const merged = mergeManualInputs(baseline(), [openwork]);
    const s21 = merged.find((s) => s.id === "2-1")!;
    expect(s21.detected).toBe(true);
    expect(s21.evidence).toHaveLength(1);
    expect(s21.evidence[0]).toMatchObject({
      url: openwork.url,
      source: "manual",
      checkedAt: "2026-07-05",
    });
  });

  it("既に detected のシグナルへは evidence 追記のみ（extracted を残す）", () => {
    const signals = baseline().map((s) =>
      s.id === "1-1"
        ? {
            ...s,
            detected: true,
            evidence: [
              {
                url: "https://example.co.jp/recruit",
                quoteSummary: "6ヶ月以上掲載",
                checkedAt: "2026-07-05",
                source: "extracted" as const,
              },
            ],
          }
        : s,
    );
    const merged = mergeManualInputs(signals, [
      {
        signalId: "1-1",
        url: "https://www.wantedly.com/companies/xxx",
        quoteSummary: "媒体側でも 8 ヶ月掲載を確認",
        checkedAt: "2026-07-05",
      },
    ]);
    const s11 = merged.find((s) => s.id === "1-1")!;
    expect(s11.detected).toBe(true);
    expect(s11.evidence).toHaveLength(2);
    expect(s11.evidence.map((e) => e.source)).toEqual(["extracted", "manual"]);
  });

  it("allowedUrls 制約を受けない（収集済みでない URL でも evidence になる）+ 入力を破壊しない", () => {
    const original = baseline();
    const merged = mergeManualInputs(original, [openwork]);
    expect(merged.find((s) => s.id === "2-1")!.evidence[0]!.url).toBe(
      "https://www.openwork.jp/company/xxx", // 収集済み URL 集合に無い URL
    );
    expect(original.find((s) => s.id === "2-1")!.detected).toBe(false); // 純関数
  });

  it("insufficientHistory は人間の確認で解除される（1-1 の掲載期間を媒体で確認したケース）", () => {
    const signals = baseline().map((s) =>
      s.id === "1-1" ? { ...s, insufficientHistory: true } : s,
    );
    const merged = mergeManualInputs(signals, [
      {
        signalId: "1-1",
        url: "https://www.green-japan.com/job/xxx",
        quoteSummary: "掲載開始 2025-12 を確認",
        checkedAt: "2026-07-05",
      },
    ]);
    const s11 = merged.find((s) => s.id === "1-1")!;
    expect(s11.detected).toBe(true);
    expect(s11.insufficientHistory).toBe(false);
  });
});
