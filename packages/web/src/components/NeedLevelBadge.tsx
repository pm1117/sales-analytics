import type { NeedLevel } from "@sa/shared/types/fit";

/** 色 + ラベル文字の両方で表す（色だけに頼らない — 詳細設計 §D-2）。 */
export function NeedLevelBadge({ level }: { level: NeedLevel | null }) {
  if (level === null) return <span className="badge badge--none">―</span>;
  return <span className={`badge badge--${level}`}>{level.toUpperCase()}</span>;
}
