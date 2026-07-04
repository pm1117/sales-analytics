import type { CrawlRequest, CrawlResponse } from "@sa/shared";

export interface AdapterContext {
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Gate1: フィード内の新着エントリ（本文は取らない）。 */
export interface FeedEntry {
  guid?: string;
  url: string;
  title?: string;
  publishedAt?: Date;
  /** RSS summary で足りる場合の本文代替。 */
  summaryMd?: string;
}

export interface ConditionalGetResult {
  status: number;
  etag?: string;
  lastModified?: string;
  /** 200 のとき（静的で軽い場合はここで完結）。 */
  bodyMd?: string;
  byteSize?: number;
  /** JS レンダ痕跡があり Crawl4AI へのエスカレーションが要るか。 */
  looksDynamic?: boolean;
}

export interface RssAdapter {
  fetchFeed(feedUrl: string, ctx: AdapterContext): Promise<FeedEntry[]>;
}

export interface SitemapAdapter {
  fetchSitemap(sitemapUrl: string, ctx: AdapterContext): Promise<FeedEntry[]>;
}

export interface ConditionalGetAdapter {
  fetch(
    url: string,
    prev: { etag?: string; lastModified?: string },
    ctx: AdapterContext,
  ): Promise<ConditionalGetResult>;
}

export interface Crawl4aiAdapter {
  crawl(req: CrawlRequest, ctx: AdapterContext): Promise<CrawlResponse>;
}

export interface ManagedCrawlAdapter {
  readonly enabled: boolean;
  crawl(url: string, ctx: AdapterContext): Promise<CrawlResponse>;
}
