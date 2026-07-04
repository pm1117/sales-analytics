import { XMLParser } from "fast-xml-parser";
import type {
  AdapterContext,
  FeedEntry,
  SitemapAdapter,
} from "./source-adapter";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Gate1: sitemap.xml を取得し URL 一覧を返す（lastmod を publishedAt に）。 */
export class HttpSitemapAdapter implements SitemapAdapter {
  async fetchSitemap(
    sitemapUrl: string,
    ctx: AdapterContext,
  ): Promise<FeedEntry[]> {
    const res = await fetch(sitemapUrl, {
      headers: { "user-agent": ctx.userAgent },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const doc = parser.parse(xml) as Record<string, unknown>;

    const urlset = doc["urlset"] as Record<string, unknown> | undefined;
    if (!urlset) {
      // sitemapindex は MVP では未追跡（子 sitemap の再帰取得は将来対応）
      return [];
    }

    const entries: FeedEntry[] = [];
    for (const raw of asArray(urlset["url"])) {
      const u = raw as Record<string, unknown>;
      const loc = str(u["loc"]);
      if (!loc) continue;
      const lastmod = str(u["lastmod"]);
      const entry: FeedEntry = { url: loc };
      if (lastmod) {
        const d = new Date(lastmod);
        if (!Number.isNaN(d.getTime())) entry.publishedAt = d;
      }
      entries.push(entry);
    }
    return entries;
  }
}
