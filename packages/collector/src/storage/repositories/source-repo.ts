import type { FeedKind, Source, SourceKind } from "@sa/shared";
import type { Db } from "../db";

interface SourceRow {
  id: string;
  company_id: string;
  kind: SourceKind;
  url: string;
  canonical_url: string;
  feed_kind: FeedKind | null;
  etag: string | null;
  last_modified: string | null;
  robots_allowed: boolean;
  crawl_delay_ms: number | null;
  last_polled_at: Date | null;
  stale_after: Date | null;
  enabled: boolean;
}

function mapRow(r: SourceRow): Source {
  return {
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    url: r.url,
    canonicalUrl: r.canonical_url,
    ...(r.feed_kind !== null ? { feedKind: r.feed_kind } : {}),
    ...(r.etag !== null ? { etag: r.etag } : {}),
    ...(r.last_modified !== null ? { lastModified: r.last_modified } : {}),
    robotsAllowed: r.robots_allowed,
    ...(r.crawl_delay_ms !== null ? { crawlDelayMs: r.crawl_delay_ms } : {}),
    ...(r.last_polled_at !== null ? { lastPolledAt: r.last_polled_at } : {}),
    ...(r.stale_after !== null ? { staleAfter: r.stale_after } : {}),
    enabled: r.enabled,
  };
}

const COLS = `id, company_id, kind, url, canonical_url, feed_kind, etag,
              last_modified, robots_allowed, crawl_delay_ms, last_polled_at,
              stale_after, enabled`;

export class SourceRepo {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Source | undefined> {
    const row = await this.db.queryOne<SourceRow>(
      `SELECT ${COLS} FROM sources WHERE id = $1`,
      [id],
    );
    return row ? mapRow(row) : undefined;
  }

  async listByCompany(companyId: string): Promise<Source[]> {
    const rows = await this.db.query<SourceRow>(
      `SELECT ${COLS} FROM sources WHERE company_id = $1 AND enabled`,
      [companyId],
    );
    return rows.map(mapRow);
  }

  /** 巡回対象（フィード種別で間隔超過）を返す。§7 の producer が使う。 */
  async listPollable(kinds: SourceKind[]): Promise<Source[]> {
    const rows = await this.db.query<SourceRow>(
      `SELECT s.${COLS.replace(/\n\s+/g, " ")}
         FROM sources s
         JOIN source_freshness_policy p ON p.source_kind = s.kind
        WHERE s.kind = ANY($1)
          AND s.enabled AND s.robots_allowed
          AND (s.last_polled_at IS NULL
               OR now() - s.last_polled_at >= make_interval(secs => p.feed_poll_interval_s))`,
      [kinds],
    );
    return rows.map(mapRow);
  }

  async insert(input: {
    companyId: string;
    kind: SourceKind;
    url: string;
    canonicalUrl: string;
    feedKind?: FeedKind;
    robotsAllowed: boolean;
    crawlDelayMs?: number;
  }): Promise<Source> {
    const row = await this.db.queryOne<SourceRow>(
      `INSERT INTO sources (company_id, kind, url, canonical_url, feed_kind, robots_allowed, crawl_delay_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, canonical_url) DO UPDATE SET updated_at = now()
       RETURNING ${COLS}`,
      [
        input.companyId,
        input.kind,
        input.url,
        input.canonicalUrl,
        input.feedKind ?? null,
        input.robotsAllowed,
        input.crawlDelayMs ?? null,
      ],
    );
    return mapRow(row as SourceRow);
  }

  /** 条件付き GET の状態と鮮度・巡回時刻を更新する。 */
  async updateFetchState(
    id: string,
    patch: {
      etag?: string | null;
      lastModified?: string | null;
      staleAfter?: Date;
      lastPolledAt?: Date;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE sources SET
         etag = COALESCE($2, etag),
         last_modified = COALESCE($3, last_modified),
         stale_after = COALESCE($4, stale_after),
         last_polled_at = COALESCE($5, last_polled_at),
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        patch.etag ?? null,
        patch.lastModified ?? null,
        patch.staleAfter ?? null,
        patch.lastPolledAt ?? null,
      ],
    );
  }
}
