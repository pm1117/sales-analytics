import type { FreshnessPolicy, SourceKind } from "@sa/shared";
import type { Db } from "../db";

interface PolicyRow {
  source_kind: SourceKind;
  feed_poll_interval_s: number;
  body_ttl_s: number | null;
  html_ttl_s: number;
}

/** source_freshness_policy を読み出す（メモリキャッシュ付き）。 */
export class PolicyRepo {
  private cache = new Map<SourceKind, FreshnessPolicy>();

  constructor(private readonly db: Db) {}

  async get(kind: SourceKind): Promise<FreshnessPolicy> {
    const cached = this.cache.get(kind);
    if (cached) return cached;

    const row = await this.db.queryOne<PolicyRow>(
      `SELECT source_kind, feed_poll_interval_s, body_ttl_s, html_ttl_s
         FROM source_freshness_policy WHERE source_kind = $1`,
      [kind],
    );
    if (!row) {
      throw new Error(`No freshness policy configured for source_kind=${kind}`);
    }
    const policy: FreshnessPolicy = {
      sourceKind: row.source_kind,
      feedPollIntervalS: row.feed_poll_interval_s,
      bodyTtlS: row.body_ttl_s,
      htmlTtlS: row.html_ttl_s,
    };
    this.cache.set(kind, policy);
    return policy;
  }
}
