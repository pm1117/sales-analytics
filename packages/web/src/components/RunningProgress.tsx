import type { FitAssessment } from "@sa/shared/types/fit";

const STEPS = [
  { key: "collect", label: "収集" },
  { key: "extract", label: "抽出" },
  { key: "judge", label: "判定" },
] as const;

/** 実行中の進捗表示。% バーは作らない — stage 表示が誠実（詳細設計 §D-4）。 */
export function RunningProgress({ assessment }: { assessment: FitAssessment }) {
  const currentIdx = STEPS.findIndex((s) => s.key === assessment.stage);
  const elapsedMin = (Date.now() - new Date(assessment.createdAt).getTime()) / 60_000;

  return (
    <div className="card">
      <div className="stepper">
        {STEPS.map((step, i) => (
          <span
            key={step.key}
            className={`step ${i < currentIdx ? "step--done" : ""} ${i === currentIdx ? "step--active" : ""}`}
          >
            {step.label}
          </span>
        ))}
        <span className="note">経過 {elapsedMin.toFixed(1)} 分</span>
      </div>
      <p className="note">
        収集はサイト負荷配慮のため 1 アクセス 10〜20 秒間隔で行います。数分かかります。
        ブラウザを閉じても実行は継続します（サーバー再起動時は失敗扱いになり再実行できます）。
      </p>
    </div>
  );
}
