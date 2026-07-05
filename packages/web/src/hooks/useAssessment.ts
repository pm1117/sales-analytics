import { useQuery } from "@tanstack/react-query";
import { getAssessment } from "../api/client";

/** 詳細。status=running の間だけ 5 秒ポーリング — 完了で自動停止（詳細設計 §D-3）。 */
export function useAssessment(id: string) {
  return useQuery({
    queryKey: ["assessment", id],
    queryFn: () => getAssessment(id),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5_000 : false,
  });
}
