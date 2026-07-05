import { useQuery } from "@tanstack/react-query";
import { getAssessments } from "../api/client";

/** 一覧。running 行がある間だけ 5 秒ポーリング（詳細設計 §D-3）。 */
export function useAssessments() {
  return useQuery({
    queryKey: ["assessments"],
    queryFn: getAssessments,
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => i.status === "running") ? 5_000 : false,
  });
}
