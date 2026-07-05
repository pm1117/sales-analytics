import type { ManualInput, SignalResult } from "@sa/shared";

/**
 * 手動入力のマージ（詳細設計 §C-5 手順 3）。純関数（入力を破壊しない）。
 * - manualInput を該当シグナルの evidence（source="manual"）として追加し detected=true にする
 * - 人間が確認済みの URL のため allowedUrls 制約（evidence-filter）の対象外
 * - 人間の evidence は時系列不足を補う扱いとし insufficientHistory を解除する
 *   （例: 1-1 の掲載期間を人間が媒体で確認したケース。judge で「検出なし」に落とさないため）
 */
export function mergeManualInputs(
  signals: SignalResult[],
  manual: ManualInput[],
): SignalResult[] {
  if (manual.length === 0) return signals;

  const byId = new Map(manual.map((m) => [m.signalId, [] as ManualInput[]]));
  for (const m of manual) byId.get(m.signalId)!.push(m);

  return signals.map((s) => {
    const inputs = byId.get(s.id);
    if (!inputs || inputs.length === 0) return s;
    return {
      ...s,
      detected: true,
      insufficientHistory: false,
      evidence: [
        ...s.evidence,
        ...inputs.map((m) => ({
          url: m.url,
          quoteSummary: m.quoteSummary,
          checkedAt: m.checkedAt,
          source: "manual" as const,
        })),
      ],
    };
  });
}
