import {
  SIGNAL_BY_ID,
  type Evidence,
  type RawSignal,
  type SignalResult,
} from "@sa/shared";
import { canonicalizeUrl } from "../compliance/url-canonical";

/**
 * LLM 出力の捏造ガード（詳細設計 §C-5 手順 1）。純関数。
 * - 引用可能 URL リスト外の evidence を破棄（URL は canonical 化して突合 — 末尾スラッシュ・utm 差を同一視）
 * - evidence が 0 件になったシグナルは detected=false に落とす（要件 §4-1「出典必須」の機械的担保）
 * - strength / checkedAt / source はカタログとコードが付与する（LLM 出力を信用しない）
 * - detector=manual のシグナル（2-1）は LLM に判定させない — 検出も evidence も破棄
 */

export interface FilterResult {
  signals: SignalResult[];
  /** 破棄した evidence 件数（頻発するならプロンプト改訂のシグナル — 基本設計 §9 リスク 6）。 */
  droppedCount: number;
}

function tryCanonicalize(url: string): string | null {
  try {
    return canonicalizeUrl(url);
  } catch {
    return null; // LLM が URL でない文字列を返した場合も「リスト外」として破棄
  }
}

export function filterEvidence(
  raw: RawSignal[],
  allowedUrls: Set<string>,
  checkedAt: string,
): FilterResult {
  const allowed = new Set<string>();
  for (const url of allowedUrls) {
    const canonical = tryCanonicalize(url);
    if (canonical) allowed.add(canonical);
  }

  let droppedCount = 0;
  const signals: SignalResult[] = raw.map((r) => {
    const def = SIGNAL_BY_ID.get(r.signalId);
    const strength = def?.strength ?? "weak";

    // manual 検出のシグナルは LLM 判定を受け付けない（manualInputs のみ — 詳細設計 §C-1）
    if (def?.detector === "manual") {
      droppedCount += r.evidence.length;
      return {
        id: r.signalId,
        detected: false,
        strength,
        evidence: [],
        insufficientHistory: false,
      };
    }

    const evidence: Evidence[] = [];
    for (const e of r.evidence) {
      const canonical = tryCanonicalize(e.url);
      if (canonical && allowed.has(canonical)) {
        evidence.push({
          url: e.url,
          quoteSummary: e.quoteSummary,
          checkedAt,
          source: "extracted",
        });
      } else {
        droppedCount += 1;
      }
    }

    return {
      id: r.signalId,
      detected: r.detected && evidence.length > 0,
      strength,
      evidence,
      insufficientHistory: r.insufficientHistory,
    };
  });

  return { signals, droppedCount };
}
