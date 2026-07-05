import type { FitAssessment } from "@sa/shared/types/fit";
import { SIGNAL_BY_ID } from "@sa/shared/fit/signal-catalog";
import { NeedLevelBadge } from "./NeedLevelBadge";

/** 判定サマリー（詳細設計 §D-2）: バッジ + rationale + careersCheck + missingData + コスト。 */
export function FitResult({ assessment }: { assessment: FitAssessment }) {
  const { careersCheck, cost } = assessment;
  return (
    <div className="card">
      <p>
        <NeedLevelBadge level={assessment.needLevel} />{" "}
        <strong>{assessment.rationale}</strong>
      </p>

      {assessment.missingData.length > 0 && (
        <p className="note">
          取得できなかった情報:{" "}
          {assessment.missingData
            .map((id) => `${id}（${SIGNAL_BY_ID.get(id)?.name ?? ""}）`)
            .join("、")}
        </p>
      )}

      {careersCheck && (
        <details>
          <summary>
            careers 確認: {careersCheck.foundUrl ? `✓ ${careersCheck.foundUrl}` : `採用ページなし（確認 ${careersCheck.checkedUrls.length} URL）`}
          </summary>
          <ul>
            {careersCheck.checkedUrls.map((u) => (
              <li key={u} className="note">{u}</li>
            ))}
          </ul>
        </details>
      )}

      {cost && (
        <p className="note">
          コスト: {(cost.durationMs / 60_000).toFixed(1)} 分 / in {(cost.inputTokens / 1000).toFixed(1)}k / out{" "}
          {(cost.outputTokens / 1000).toFixed(1)}k tok（{cost.model}） ・ signals {assessment.signalsVersion} / prompt{" "}
          {assessment.promptVersion}
        </p>
      )}
    </div>
  );
}
