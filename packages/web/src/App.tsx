import { Navigate, Route, Routes } from "react-router-dom";
import { AssessmentListPage } from "./pages/AssessmentListPage";
import { AssessmentDetailPage } from "./pages/AssessmentDetailPage";

/** ルーティング（詳細設計 §D-1）: 2 画面のみ。404 は一覧へ。 */
export function App() {
  return (
    <div className="container">
      <Routes>
        <Route path="/" element={<AssessmentListPage />} />
        <Route path="/assessments/:id" element={<AssessmentDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
