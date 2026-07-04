/**
 * TS 本体 → Python Crawler の HTTP 契約（URL(+ヒント) → Markdown に限定）。
 * 実行時検証は schemas/crawler.ts の zod で行う。
 */

export type RenderMode = "auto" | "static" | "js";
export type BlockResource = "image" | "stylesheet" | "font" | "media";

export interface CrawlRequest {
  url: string;
  render: RenderMode;
  extractionHint?: string;
  /** 既定で image/stylesheet/font/media を block（帯域削減）。 */
  blockResources: BlockResource[];
  timeoutMs: number;
  respectRobots: boolean;
}

export interface CrawlMeta {
  title?: string;
  fetchedAt: string;
  byteSize: number;
  rendered: boolean;
}

export interface CrawlResponse {
  finalUrl: string | null;
  /** 上流 HTTP ステータス。robots ブロック時は 0。 */
  status: number;
  markdown: string;
  meta: CrawlMeta | null;
  robotsBlocked: boolean;
  error: { code: string; message: string } | null;
}
