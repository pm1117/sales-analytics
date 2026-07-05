import { describe, expect, it } from "vitest";
import {
  SIGNAL_BY_ID,
  SIGNAL_CATALOG,
  type SignalId,
  type SignalResult,
} from "@sa/shared";
import {
  judge,
  type CollectionStatus,
} from "../src/fit/need-judge";

/** 全 14 シグナル undetected のベースラインに、指定 ID だけ detected を立てる。 */
function makeSignals(
  detectedIds: SignalId[] = [],
  overrides: Partial<Record<SignalId, Partial<SignalResult>>> = {},
): SignalResult[] {
  return SIGNAL_CATALOG.map((def) => ({
    id: def.id,
    detected: detectedIds.includes(def.id),
    strength: def.strength,
    evidence: detectedIds.includes(def.id)
      ? [
          {
            url: `https://example.co.jp/${def.id}`,
            quoteSummary: "根拠の要約",
            checkedAt: "2026-07-05",
            source: "extracted" as const,
          },
        ]
      : [],
    insufficientHistory: false,
    ...overrides[def.id],
  }));
}

const met: CollectionStatus = {
  careersChecked: true,
  jobsInfoCount: 1,
  prNewsCount: 1,
};

describe("judge — 決定表（詳細設計 §C-3 全 7 行）", () => {
  it("行 1: 収集最低要件未達なら unknown（強い求人シグナルがあっても最優先）", () => {
    const r = judge({
      signals: makeSignals(["1-1"]),
      collection: { careersChecked: false, jobsInfoCount: 1, prNewsCount: 1 },
    });
    expect(r.needLevel).toBe("unknown");
    expect(r.rationale).toContain("自社 careers の有無確認");
  });

  it("行 1: 不足項目が rationale に列挙される", () => {
    const r = judge({
      signals: makeSignals(),
      collection: { careersChecked: true, jobsInfoCount: 0, prNewsCount: 0 },
    });
    expect(r.needLevel).toBe("unknown");
    expect(r.rationale).toContain("求人媒体の求人情報");
    expect(r.rationale).toContain("PR / ニュース");
  });

  it("行 2: fatal 逆指標（4-1 競合）は strongJobs×3 があっても low（S2 ハード制約）", () => {
    const r = judge({
      signals: makeSignals(["4-1", "1-1", "1-3", "1-4"]),
      collection: met,
    });
    expect(r.needLevel).toBe("low");
    expect(r.rationale).toContain("4-1");
    expect(r.rationale).toContain("競合");
    expect(r.rationale).toContain("問合せ対象外");
  });

  it("行 2: major 逆指標（1-5 リファラル疑い）+ weak×2 は low", () => {
    const r = judge({
      signals: makeSignals(["1-5", "5-1", "5-2"]),
      collection: met,
    });
    expect(r.needLevel).toBe("low");
    expect(r.rationale).toContain("リファラル採用疑い");
  });

  it("行 3: strongJobs + 軽微な逆指標（4-2）は medium", () => {
    const r = judge({ signals: makeSignals(["1-1", "4-2"]), collection: met });
    expect(r.needLevel).toBe("medium");
    expect(r.rationale).toContain("1-1");
    expect(r.rationale).toContain("4-2");
  });

  it("行 4: 軽微な逆指標（4-2）のみは low", () => {
    const r = judge({ signals: makeSignals(["4-2"]), collection: met });
    expect(r.needLevel).toBe("low");
    expect(r.rationale).toContain("4-2");
  });

  it("行 5: strongJobs 1 件・逆指標 0 は high", () => {
    const r = judge({ signals: makeSignals(["1-1"]), collection: met });
    expect(r.needLevel).toBe("high");
    expect(r.rationale).toContain("1-1");
    expect(r.rationale).toContain(SIGNAL_BY_ID.get("1-1")!.name);
  });

  it("行 5: strongOther 併存は high のまま確度 UP 付記", () => {
    const r = judge({ signals: makeSignals(["1-4", "3-1"]), collection: met });
    expect(r.needLevel).toBe("high");
    expect(r.rationale).toContain("確度 UP");
    expect(r.rationale).toContain("3-1");
  });

  it("行 6: weak×2・逆指標 0 は medium / weak×1 は low", () => {
    expect(
      judge({ signals: makeSignals(["5-1", "5-2"]), collection: met })
        .needLevel,
    ).toBe("medium");
    expect(
      judge({ signals: makeSignals(["5-1"]), collection: met }).needLevel,
    ).toBe("low");
  });

  it("行 6 が行 7 より先: 3-1 + weak×2 は medium（strongOther が weak≥2 判定を妨げない）", () => {
    const r = judge({
      signals: makeSignals(["3-1", "5-1", "5-3"]),
      collection: met,
    });
    expect(r.needLevel).toBe("medium");
  });

  it("行 7: strongOther 単独（3-1）は low — 求人シグナルなしでは問い合わせしない（2026-07-05 確定）", () => {
    const r = judge({ signals: makeSignals(["3-1"]), collection: met });
    expect(r.needLevel).toBe("low");
    expect(r.rationale).toContain("求人シグナルなし");
  });

  it("行 7: 2-1（手動口コミ）単独も low", () => {
    const r = judge({ signals: makeSignals(["2-1"]), collection: met });
    expect(r.needLevel).toBe("low");
  });

  it("行 7: シグナルなしは low", () => {
    const r = judge({ signals: makeSignals(), collection: met });
    expect(r.needLevel).toBe("low");
    expect(r.rationale).toContain("判定材料となるシグナルなし");
  });
});

describe("judge — insufficientHistory / missingData", () => {
  it("insufficientHistory=true の 1-1 は detected でも「検出なし」扱い（high にしない）", () => {
    const r = judge({
      signals: makeSignals(["1-1"], {
        "1-1": { insufficientHistory: true },
      }),
      collection: met,
    });
    expect(r.needLevel).toBe("low");
    expect(r.missingData).toContain("1-1");
  });

  it("manualInput の無い 2-1 は missingData に入る", () => {
    const r = judge({ signals: makeSignals(["1-1"]), collection: met });
    expect(r.missingData).toContain("2-1");
  });

  it("manual で検出済みの 2-1 は missingData に入らない", () => {
    const r = judge({ signals: makeSignals(["2-1"]), collection: met });
    expect(r.missingData).not.toContain("2-1");
  });
});
