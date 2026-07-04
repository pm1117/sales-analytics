import type { FreshnessPolicy, ScrapedContent, Source } from "@sa/shared";

/**
 * Gate0 の鮮度判定。planner が取得成功のたびに source.staleAfter を更新するため、
 * それが未来なら鮮度内（取得コスト0でスキップ）。無ければ policy の TTL でフォールバック。
 */
export class FreshnessJudge {
  constructor(private readonly now: () => number = Date.now) {}

  isFresh(
    source: Source,
    latest: ScrapedContent | undefined,
    policy: FreshnessPolicy,
  ): boolean {
    if (!latest) return false;

    if (source.staleAfter) {
      return this.now() < source.staleAfter.getTime();
    }
    // フォールバック: 最終取得 + html_ttl
    return this.now() < latest.fetchedAt.getTime() + policy.htmlTtlS * 1000;
  }
}
