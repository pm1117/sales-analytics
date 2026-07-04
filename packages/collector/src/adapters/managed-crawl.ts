import type { CrawlResponse } from "@sa/shared";
import { htmlToMarkdown } from "./html-text";
import type { AdapterContext, ManagedCrawlAdapter } from "./source-adapter";

/**
 * Gate4: マネージド API（Firecrawl 等）フォールバック。既定 OFF・opt-in の最終手段。
 * 従量課金はユーザー負担。RSS/Crawl4AI で取れない難サイト本文のみに使う。
 */
export class FirecrawlManagedAdapter implements ManagedCrawlAdapter {
  readonly enabled: boolean;

  constructor(
    private readonly opts: { enabled: boolean; apiKey?: string },
  ) {
    this.enabled = opts.enabled && Boolean(opts.apiKey);
  }

  async crawl(url: string, ctx: AdapterContext): Promise<CrawlResponse> {
    if (!this.enabled) {
      return {
        finalUrl: null,
        status: 0,
        markdown: "",
        meta: null,
        robotsBlocked: false,
        error: {
          code: "managed_disabled",
          message: "managed crawl is disabled (opt-in required)",
        },
      };
    }

    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey ?? ""}`,
        "user-agent": ctx.userAgent,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs),
    });

    const raw: unknown = await res.json().catch(() => null);
    const data =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)["data"]
        : undefined;
    const md =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)["markdown"]
        : undefined;
    const markdown =
      typeof md === "string" ? md : htmlToMarkdown("").markdown;

    if (!res.ok || typeof md !== "string") {
      return {
        finalUrl: url,
        status: res.status,
        markdown: "",
        meta: null,
        robotsBlocked: false,
        error: {
          code: "managed_error",
          message: `firecrawl HTTP ${res.status}`,
        },
      };
    }

    return {
      finalUrl: url,
      status: 200,
      markdown,
      meta: {
        fetchedAt: new Date().toISOString(),
        byteSize: Buffer.byteLength(markdown, "utf8"),
        rendered: true,
      },
      robotsBlocked: false,
      error: null,
    };
  }
}
