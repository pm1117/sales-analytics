import { useNavigate } from "react-router-dom";
import type { AssessmentListItem } from "@sa/shared/types/fit";
import { NeedLevelBadge } from "./NeedLevelBadge";

const STAGE_JA: Record<string, string> = {
  collect: "実行中（収集）",
  extract: "実行中（抽出）",
  judge: "実行中（判定）",
  done: "完了",
};

function statusLabel(item: AssessmentListItem): string {
  if (item.status === "running") return STAGE_JA[item.stage] ?? "実行中";
  if (item.status === "failed") return "失敗";
  return "完了";
}

export function AssessmentTable({ items }: { items: AssessmentListItem[] }) {
  const navigate = useNavigate();
  if (items.length === 0) {
    return <p className="note">まだ判定がありません。企業 URL を入力して実行してください。</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>企業</th>
          <th>need</th>
          <th>状態</th>
          <th>人間評価</th>
          <th>実行日時</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={item.id}
            className="row--clickable"
            onClick={() => navigate(`/assessments/${item.id}`)}
          >
            <td>{item.company.domain}</td>
            <td><NeedLevelBadge level={item.needLevel} /></td>
            <td>{statusLabel(item)}</td>
            <td>
              {item.humanNeedLevel ? (
                <NeedLevelBadge level={item.humanNeedLevel} />
              ) : item.status === "succeeded" ? (
                <span className="note">未記入</span>
              ) : (
                "―"
              )}
            </td>
            <td>{new Date(item.createdAt).toLocaleString("ja-JP")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
