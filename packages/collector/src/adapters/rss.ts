import { XMLParser } from "fast-xml-parser";
import type { AdapterContext, FeedEntry, RssAdapter } from "./source-adapter";
import { htmlToMarkdown } from "./html-text";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  // { "#text": "..." } 形
  if (v && typeof v === "object" && "#text" in v) {
    const t = (v as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function toDate(v: unknown): Date | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function summaryToMd(v: unknown): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  return htmlToMarkdown(s).markdown || undefined;
}

/** undefined を確実に落として exactOptionalPropertyTypes を満たす。 */
function buildEntry(fields: {
  guid: string | undefined;
  url: string;
  title: string | undefined;
  publishedAt: Date | undefined;
  summaryMd: string | undefined;
}): FeedEntry {
  const e: FeedEntry = { url: fields.url };
  if (fields.guid !== undefined) e.guid = fields.guid;
  if (fields.title !== undefined) e.title = fields.title;
  if (fields.publishedAt !== undefined) e.publishedAt = fields.publishedAt;
  if (fields.summaryMd !== undefined) e.summaryMd = fields.summaryMd;
  return e;
}

/** Gate1: RSS 2.0 / Atom フィードを取得し新着エントリのメタを返す（本文は取らない）。 */
export class HttpRssAdapter implements RssAdapter {
  async fetchFeed(feedUrl: string, ctx: AdapterContext): Promise<FeedEntry[]> {
    const res = await fetch(feedUrl, {
      headers: { "user-agent": ctx.userAgent },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const doc = parser.parse(xml) as Record<string, unknown>;

    // RSS 2.0
    const rss = doc["rss"] as Record<string, unknown> | undefined;
    if (rss) {
      const channel = rss["channel"] as Record<string, unknown> | undefined;
      return asArray(channel?.["item"]).map((it) =>
        this.mapRssItem(it as Record<string, unknown>),
      );
    }

    // Atom
    const feed = doc["feed"] as Record<string, unknown> | undefined;
    if (feed) {
      return asArray(feed["entry"]).map((e) =>
        this.mapAtomEntry(e as Record<string, unknown>),
      );
    }

    return [];
  }

  private mapRssItem(item: Record<string, unknown>): FeedEntry {
    const guid = asString(item["guid"]);
    const link = asString(item["link"]);
    return buildEntry({
      guid,
      url: link ?? guid ?? "",
      title: asString(item["title"]),
      publishedAt: toDate(item["pubDate"]),
      summaryMd: summaryToMd(item["description"]),
    });
  }

  private mapAtomEntry(entry: Record<string, unknown>): FeedEntry {
    const id = asString(entry["id"]);
    // Atom link は属性 href を持つ
    const linkRaw = entry["link"];
    let href: string | undefined;
    if (Array.isArray(linkRaw)) {
      const first = linkRaw[0] as Record<string, unknown> | undefined;
      href = first ? asString(first["@_href"]) : undefined;
    } else if (linkRaw && typeof linkRaw === "object") {
      href = asString((linkRaw as Record<string, unknown>)["@_href"]);
    }
    return buildEntry({
      guid: id,
      url: href ?? id ?? "",
      title: asString(entry["title"]),
      publishedAt: toDate(entry["updated"] ?? entry["published"]),
      summaryMd:
        summaryToMd(entry["summary"]) ?? summaryToMd(entry["content"]),
    });
  }
}
