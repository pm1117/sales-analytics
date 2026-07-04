import type { FetchMethod, ScrapedContent, SourceType } from "@sa/shared";
import type { Db } from "../db";

interface ScrapedRow {
  id: string;
  company_id: string;
  source_id: string;
  source_type: SourceType;
  url: string;
  canonical_url: string;
  title: string | null;
  content_md: string;
  content_hash: Buffer;
  fetched_at: Date;
  fetch_method: FetchMethod;
  http_status: number | null;
  byte_size: number | null;
  guid: string | null;
  published_at: Date | null;
  supersedes: string | null;
}

const COLS = `id, company_id, source_id, source_type, url, canonical_url, title,
              content_md, content_hash, fetched_at, fetch_method, http_status,
              byte_size, guid, published_at, supersedes`;

function mapRow(r: ScrapedRow): ScrapedContent {
  return {
    id: r.id,
    companyId: r.company_id,
    sourceId: r.source_id,
    sourceType: r.source_type,
    url: r.url,
    canonicalUrl: r.canonical_url,
    ...(r.title !== null ? { title: r.title } : {}),
    contentMd: r.content_md,
    contentHash: r.content_hash,
    fetchedAt: r.fetched_at,
    fetchMethod: r.fetch_method,
    ...(r.http_status !== null ? { httpStatus: r.http_status } : {}),
    ...(r.byte_size !== null ? { byteSize: r.byte_size } : {}),
    ...(r.guid !== null ? { guid: r.guid } : {}),
    ...(r.published_at !== null ? { publishedAt: r.published_at } : {}),
    ...(r.supersedes !== null ? { supersedes: r.supersedes } : {}),
  };
}

export type ScrapedContentInput = Omit<
  ScrapedContent,
  "id" | "fetchedAt"
> & { fetchedAt?: Date };

export class ScrapedContentRepo {
  constructor(private readonly db: Db) {}

  /**
   * dedup upsert。(company_id, canonical_url, content_hash) 既存なら inserted=false。
   */
  async upsert(
    c: ScrapedContentInput,
  ): Promise<{ id: string; inserted: boolean }> {
    const inserted = await this.db.queryOne<{ id: string }>(
      `INSERT INTO scraped_contents
         (company_id, source_id, source_type, url, canonical_url, title,
          content_md, content_hash, fetch_method, http_status, byte_size,
          guid, published_at, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (company_id, canonical_url, content_hash) DO NOTHING
       RETURNING id`,
      [
        c.companyId,
        c.sourceId,
        c.sourceType,
        c.url,
        c.canonicalUrl,
        c.title ?? null,
        c.contentMd,
        c.contentHash,
        c.fetchMethod,
        c.httpStatus ?? null,
        c.byteSize ?? null,
        c.guid ?? null,
        c.publishedAt ?? null,
        c.supersedes ?? null,
      ],
    );
    if (inserted) return { id: inserted.id, inserted: true };

    const existing = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM scraped_contents
        WHERE company_id = $1 AND canonical_url = $2 AND content_hash = $3`,
      [c.companyId, c.canonicalUrl, c.contentHash],
    );
    return { id: (existing as { id: string }).id, inserted: false };
  }

  /**
   * プレスリリースを guid で upsert（1 リリース = 1 行）。
   * overwrite=false（フィード巡回のメタ）は既存を壊さず DO NOTHING、
   * overwrite=true（本文取得）は content_md/hash を更新して本文を充填する。
   */
  async upsertPress(
    c: ScrapedContentInput,
    overwrite: boolean,
  ): Promise<{ id: string; inserted: boolean }> {
    const conflictAction = overwrite
      ? `DO UPDATE SET
           content_md = EXCLUDED.content_md,
           content_hash = EXCLUDED.content_hash,
           fetch_method = EXCLUDED.fetch_method,
           http_status = EXCLUDED.http_status,
           byte_size = EXCLUDED.byte_size,
           title = COALESCE(EXCLUDED.title, scraped_contents.title),
           published_at = COALESCE(EXCLUDED.published_at, scraped_contents.published_at),
           fetched_at = now()`
      : `DO NOTHING`;

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO scraped_contents
         (company_id, source_id, source_type, url, canonical_url, title,
          content_md, content_hash, fetch_method, http_status, byte_size,
          guid, published_at)
       VALUES ($1,$2,'press_release',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (company_id, guid) WHERE source_type = 'press_release' AND guid IS NOT NULL
       ${conflictAction}
       RETURNING id`,
      [
        c.companyId,
        c.sourceId,
        c.url,
        c.canonicalUrl,
        c.title ?? null,
        c.contentMd,
        c.contentHash,
        c.fetchMethod,
        c.httpStatus ?? null,
        c.byteSize ?? null,
        c.guid ?? null,
        c.publishedAt ?? null,
      ],
    );
    if (row) return { id: row.id, inserted: true };
    // DO NOTHING で既存 → id を引く
    const existing = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM scraped_contents
        WHERE company_id = $1 AND guid = $2 AND source_type = 'press_release'`,
      [c.companyId, c.guid ?? null],
    );
    return { id: (existing as { id: string }).id, inserted: false };
  }

  async getById(id: string): Promise<ScrapedContent | undefined> {
    const row = await this.db.queryOne<ScrapedRow>(
      `SELECT ${COLS} FROM scraped_contents WHERE id = $1`,
      [id],
    );
    return row ? mapRow(row) : undefined;
  }

  async latestForSource(sourceId: string): Promise<ScrapedContent | undefined> {
    const row = await this.db.queryOne<ScrapedRow>(
      `SELECT ${COLS} FROM scraped_contents
        WHERE source_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [sourceId],
    );
    return row ? mapRow(row) : undefined;
  }

  async latestByCompany(
    companyId: string,
    types: SourceType[],
    limit: number,
  ): Promise<ScrapedContent[]> {
    const rows = await this.db.query<ScrapedRow>(
      `SELECT ${COLS} FROM scraped_contents
        WHERE company_id = $1 AND source_type = ANY($2)
        ORDER BY fetched_at DESC LIMIT $3`,
      [companyId, types, limit],
    );
    return rows.map(mapRow);
  }

  /** 既知の press guid 集合（Gate1 の新着差分判定用）。 */
  async existingGuids(companyId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ guid: string }>(
      `SELECT guid FROM scraped_contents
        WHERE company_id = $1 AND source_type = 'press_release' AND guid IS NOT NULL`,
      [companyId],
    );
    return new Set(rows.map((r) => r.guid));
  }

  /** 既知の press canonical_url 集合（guid の無い sitemap 由来エントリの差分判定用）。 */
  async existingPressUrls(companyId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ canonical_url: string }>(
      `SELECT canonical_url FROM scraped_contents
        WHERE company_id = $1 AND source_type = 'press_release'`,
      [companyId],
    );
    return new Set(rows.map((r) => r.canonical_url));
  }
}
