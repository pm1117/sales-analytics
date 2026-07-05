import { Link, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SIGNAL_BY_ID } from "@sa/shared/fit/signal-catalog";
import type { FitAssessment, SignalResult } from "@sa/shared/types/fit";
import { useAssessment } from "../hooks/useAssessment";
import { createAssessment } from "../api/client";
import { NeedLevelBadge } from "../components/NeedLevelBadge";
import { RunningProgress } from "../components/RunningProgress";
import { FitResult } from "../components/FitResult";
import { SignalCard } from "../components/SignalCard";
import { HumanReviewForm } from "../components/HumanReviewForm";
import { OutreachDraft } from "../components/OutreachDraft";

/** 表示順（詳細設計 §D-2）: counter → strong(detected) → weak(detected) → 未検出は折りたたみ。 */
function splitSignals(signals: SignalResult[]) {
  const detected = signals.filter((s) => s.detected);
  return {
    counters: detected.filter((s) => s.strength === "counter"),
    strong: detected.filter((s) => s.strength === "strong"),
    weak: detected.filter((s) => s.strength === "weak"),
    undetected: signals.filter((s) => !s.detected),
  };
}

function SignalList({ signals }: { signals: SignalResult[] }) {
  return (
    <>
      {signals.map((s) => {
        const def = SIGNAL_BY_ID.get(s.id);
        return def ? <SignalCard key={s.id} def={def} result={s} /> : null;
      })}
    </>
  );
}

function FailedView({ assessment }: { assessment: FitAssessment }) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    // 同じ入力で再実行 = 新規 assessment（詳細設計 §D-4）
    mutationFn: () => createAssessment(assessment.input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["assessments"] });
    },
  });
  return (
    <div className="card">
      <p className="error-text">
        {`stage=${assessment.stage} で失敗: ${assessment.error ?? "unknown"}`}
      </p>
      <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}>
        同じ入力で再実行
      </button>
      {retry.isSuccess && (
        <p className="note">
          再実行を開始しました。<Link to="/">一覧</Link>から新しい行を開いてください。
        </p>
      )}
      {retry.error instanceof Error && <p className="error-text">{retry.error.message}</p>}
    </div>
  );
}

/** 画面 2: 判定詳細（詳細設計 §D-1 の `/assessments/:id`）。 */
export function AssessmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: assessment, isLoading, error } = useAssessment(id!);

  if (isLoading) return <p className="note">読み込み中...</p>;
  if (error instanceof Error || !assessment) {
    return (
      <div>
        <p className="error-text">assessment を取得できません</p>
        <Link to="/">← 一覧へ</Link>
      </div>
    );
  }

  const { counters, strong, weak, undetected } = splitSignals(assessment.signals);

  return (
    <div>
      <p>
        <Link to="/">← 一覧へ</Link>
      </p>
      <h1>
        {assessment.company.domain} <NeedLevelBadge level={assessment.needLevel} />
      </h1>

      {assessment.status === "running" && <RunningProgress assessment={assessment} />}
      {assessment.status === "failed" && <FailedView assessment={assessment} />}

      {assessment.status === "succeeded" && (
        <>
          <FitResult assessment={assessment} />

          {counters.length > 0 && (
            <>
              <h2>逆指標</h2>
              <SignalList signals={counters} />
            </>
          )}
          <h2>検出シグナル</h2>
          {strong.length + weak.length > 0 ? (
            <SignalList signals={[...strong, ...weak]} />
          ) : (
            <p className="note">検出なし</p>
          )}
          <details>
            <summary>未検出のシグナル（{undetected.length} 件）</summary>
            <SignalList signals={undetected} />
          </details>

          <HumanReviewForm assessment={assessment} />
          <OutreachDraft assessment={assessment} />
        </>
      )}
    </div>
  );
}
