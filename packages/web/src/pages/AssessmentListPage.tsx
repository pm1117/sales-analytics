import { useAssessments } from "../hooks/useAssessments";
import { CompanyInput } from "../components/CompanyInput";
import { AssessmentTable } from "../components/AssessmentTable";

/** 画面 1: 企業一覧 & 実行（詳細設計 §D-1 の `/`）。 */
export function AssessmentListPage() {
  const { data, isLoading, error } = useAssessments();
  const isMock = import.meta.env.VITE_USE_MOCK === "true";

  return (
    <div>
      <h1>Fit 判定 PoC</h1>
      {isMock && (
        <p className="note">
          デモモード（仮データ）— DB / API 不要。need 別: high / medium / low×2 / unknown の行をクリック。
        </p>
      )}
      <CompanyInput
        onSubmitted={() => {
          /* 202 → invalidate 済み。一覧に running 行が現れる（§D-4） */
        }}
      />
      {isLoading && <p className="note">読み込み中...</p>}
      {error instanceof Error && <p className="error-text">{error.message}</p>}
      {data && <AssessmentTable items={data.items} />}
    </div>
  );
}
