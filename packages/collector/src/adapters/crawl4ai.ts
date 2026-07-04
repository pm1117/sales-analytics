import {
  parseCrawlResponse,
  toCrawlRequestWire,
  type CrawlRequest,
  type CrawlResponse,
} from "@sa/shared";
import type { AdapterContext, Crawl4aiAdapter } from "./source-adapter";

/** Gate3: Python Crawler サービス（FastAPI + Crawl4AI）の HTTP クライアント。 */
export class HttpCrawl4aiAdapter implements Crawl4aiAdapter {
  constructor(private readonly baseUrl: string) {}

  async crawl(req: CrawlRequest, ctx: AdapterContext): Promise<CrawlResponse> {
    const res = await fetch(`${this.baseUrl}/crawl`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": ctx.userAgent,
      },
      body: JSON.stringify(toCrawlRequestWire(req)),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs),
    });

    // crawler はエラーもボディ（error フィールド）で表現するが、
    // 4xx/5xx かつ JSON 不正なケースは例外にする。
    const raw: unknown = await res.json().catch(() => null);
    if (raw === null) {
      return {
        finalUrl: null,
        status: res.status,
        markdown: "",
        meta: null,
        robotsBlocked: false,
        error: { code: "upstream_error", message: `crawler HTTP ${res.status}` },
      };
    }
    return parseCrawlResponse(raw);
  }
}
