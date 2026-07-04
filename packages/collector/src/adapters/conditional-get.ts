import type {
  AdapterContext,
  ConditionalGetAdapter,
  ConditionalGetResult,
} from "./source-adapter";
import { htmlToMarkdown, looksDynamic } from "./html-text";

/** Gate2: ETag/Last-Modified 条件付き GET。304 は本文 DL を回避する。 */
export class HttpConditionalGetAdapter implements ConditionalGetAdapter {
  async fetch(
    url: string,
    prev: { etag?: string; lastModified?: string },
    ctx: AdapterContext,
  ): Promise<ConditionalGetResult> {
    const headers: Record<string, string> = { "user-agent": ctx.userAgent };
    if (prev.etag) headers["if-none-match"] = prev.etag;
    if (prev.lastModified) headers["if-modified-since"] = prev.lastModified;

    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: ctx.signal ?? AbortSignal.timeout(ctx.timeoutMs),
    });

    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;

    if (res.status === 304) {
      return {
        status: 304,
        ...(etag !== undefined ? { etag } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
      };
    }

    if (res.status === 200) {
      const html = await res.text();
      const { title, markdown } = htmlToMarkdown(html);
      return {
        status: 200,
        ...(etag !== undefined ? { etag } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        bodyMd: title ? `# ${title}\n\n${markdown}` : markdown,
        byteSize: Buffer.byteLength(html, "utf8"),
        looksDynamic: looksDynamic(html, markdown),
      };
    }

    return { status: res.status };
  }
}
