import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FitAssessment, MismatchReason, NeedLevel } from "@sa/shared/types/fit";
import { MISMATCH_REASONS, NEED_LEVELS } from "@sa/shared/types/fit";
import { saveHumanReview } from "../api/client";

const REASON_JA: Record<MismatchReason, string> = {
  collection_gap: "収集漏れ",
  extraction_error: "抽出ミス",
  rule_issue: "集約ルールの問題",
  private_info: "人間側の根拠が非公開情報",
};

/** 人間判定の記録（要件 §8。この画面は記録専用 — 正解づけはシステム実行前に済ませる）。 */
export function HumanReviewForm({ assessment }: { assessment: FitAssessment }) {
  const [needLevel, setNeedLevel] = useState<NeedLevel | null>(
    assessment.humanReview?.needLevel ?? null,
  );
  const [reason, setReason] = useState<MismatchReason | null>(
    assessment.humanReview?.mismatchReason ?? null,
  );
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      saveHumanReview(assessment.id, { needLevel: needLevel!, mismatchReason: reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["assessment", assessment.id] });
      await queryClient.invalidateQueries({ queryKey: ["assessments"] });
    },
  });

  return (
    <div className="card">
      <h2>人間判定の記録</h2>
      <p className="warning">
        ⚠ 正解づけはシステム判定を見る前に済ませること（要件 §8 ブラインド原則）。この画面は記録専用です。
      </p>
      <div className="form-row">
        need:
        {NEED_LEVELS.map((level) => (
          <label key={level}>
            <input
              type="radio"
              name="human-need"
              checked={needLevel === level}
              onChange={() => setNeedLevel(level)}
            />
            {level}
          </label>
        ))}
      </div>
      <div className="form-row">
        不一致理由:
        <select
          value={reason ?? ""}
          onChange={(e) =>
            setReason(e.target.value === "" ? null : (e.target.value as MismatchReason))
          }
        >
          <option value="">一致（なし）</option>
          {MISMATCH_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_JA[r]}
            </option>
          ))}
        </select>
        <button type="button" disabled={!needLevel || mutation.isPending} onClick={() => mutation.mutate()}>
          保存
        </button>
      </div>
      {assessment.humanReview && (
        <p className="note">記録済み: {assessment.humanReview.reviewedAt}</p>
      )}
      {mutation.error instanceof Error && (
        <p className="error-text">{mutation.error.message}</p>
      )}
    </div>
  );
}
