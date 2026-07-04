/**
 * ドメイン型。scraped_contents は source_type でポリモーフィック（additive-only）。
 * SNS/ニュースは現状スコープ外だが、enum に 'x_post'|'note_article' を足すだけで拡張可能。
 */

export type SourceType = "corporate_hp" | "press_release";
export type SourceKind = "corporate_hp" | "careers" | "press_feed" | "news_feed";
export type FeedKind = "rss" | "atom" | "sitemap";

export type FetchMethod =
  | "cache_hit"
  | "rss"
  | "sitemap"
  | "conditional_get"
  | "not_modified"
  | "crawl4ai"
  | "managed_api";

export interface Company {
  id: string;
  name: string;
  /** 正規化済みホスト（例: example.co.jp）。収集の canonical キー。 */
  domain: string;
  aliases: string[];
  corpNumber?: string;
}

export interface Source {
  id: string;
  companyId: string;
  kind: SourceKind;
  url: string;
  canonicalUrl: string;
  feedKind?: FeedKind;
  etag?: string;
  lastModified?: string;
  robotsAllowed: boolean;
  crawlDelayMs?: number;
  lastPolledAt?: Date;
  staleAfter?: Date;
  enabled: boolean;
}

export interface ScrapedContent {
  id: string;
  companyId: string;
  sourceId: string;
  sourceType: SourceType;
  url: string;
  canonicalUrl: string;
  title?: string;
  /** 生 Markdown。収集時に LLM 構造化しない。著作権法30条の4 を根拠に保持。 */
  contentMd: string;
  /** 正規化テキストの SHA-256（32 bytes）。 */
  contentHash: Buffer;
  fetchedAt: Date;
  fetchMethod: FetchMethod;
  httpStatus?: number;
  byteSize?: number;
  /** press_release のみ。 */
  guid?: string;
  /** press_release のみ。 */
  publishedAt?: Date;
  supersedes?: string;
}

export interface FreshnessPolicy {
  sourceKind: SourceKind;
  feedPollIntervalS: number;
  /** null = 無期限（プレス本文は取得後不変）。 */
  bodyTtlS: number | null;
  htmlTtlS: number;
}
