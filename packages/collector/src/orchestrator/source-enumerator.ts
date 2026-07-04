import type { Company, Env, FeedKind, Source, SourceKind } from "@sa/shared";
import { canonicalizeUrl } from "../compliance/url-canonical";
import type { RobotsGuard } from "../compliance/robots";
import type { SourceRepo } from "../storage/repositories/source-repo";

interface DiscoveredFeed {
  url: string;
  kind: FeedKind;
}

/**
 * company の収集口（sources）を列挙・bootstrap する。
 * 既存があればそれを返し、無ければ HP / 採用 / プレスフィードを最小構成で登録する。
 */
export class SourceEnumerator {
  constructor(
    private readonly env: Env,
    private readonly sourceRepo: SourceRepo,
    private readonly robots: RobotsGuard,
  ) {}

  async ensureSources(company: Company): Promise<Source[]> {
    const existing = await this.sourceRepo.listByCompany(company.id);
    if (existing.length > 0) return existing;

    const base = `https://${company.domain}`;
    const created: Source[] = [];

    created.push(await this.register(company, "corporate_hp", `${base}/`));

    // プレスは (1) HP の RSS <link>、無ければ (2) robots の Sitemap から news 系を発見。
    const feed =
      (await this.discoverFeed(`${base}/`)) ??
      (await this.discoverNewsSitemap(base));
    if (feed) {
      created.push(
        await this.register(company, "press_feed", feed.url, feed.kind),
      );
    }
    return created;
  }

  private async register(
    company: Company,
    kind: SourceKind,
    url: string,
    feedKind?: FeedKind,
  ): Promise<Source> {
    const decision = await this.robots.isAllowed(url);
    return this.sourceRepo.insert({
      companyId: company.id,
      kind,
      url,
      canonicalUrl: canonicalizeUrl(url),
      ...(feedKind !== undefined ? { feedKind } : {}),
      robotsAllowed: decision.allowed,
      crawlDelayMs: decision.crawlDelayMs,
    });
  }

  /** HP の <link rel="alternate"> から RSS/Atom を発見する（軽量な最善努力）。 */
  private async discoverFeed(homeUrl: string): Promise<DiscoveredFeed | undefined> {
    let html: string;
    try {
      const res = await fetch(homeUrl, {
        headers: { "user-agent": this.env.USER_AGENT },
        signal: AbortSignal.timeout(this.env.LIGHT_HTTP_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      html = await res.text();
    } catch {
      return undefined;
    }

    const linkRe =
      /<link[^>]+rel=["']alternate["'][^>]*>/gi;
    for (const tag of html.match(linkRe) ?? []) {
      const type = /type=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href) continue;
      if (type.includes("rss")) {
        return { url: this.resolve(homeUrl, href), kind: "rss" };
      }
      if (type.includes("atom")) {
        return { url: this.resolve(homeUrl, href), kind: "atom" };
      }
    }
    return undefined;
  }

  /**
   * robots.txt の Sitemap 宣言 → sitemap index を辿り、news/press 系の
   * 子 sitemap を press ソース（feedKind='sitemap'）として発見する。
   * サイト自身が公開する sitemap を使うため低負荷でスクレイピングを最小化できる（Gate1）。
   */
  private async discoverNewsSitemap(
    base: string,
  ): Promise<DiscoveredFeed | undefined> {
    const indexUrl =
      (await this.sitemapFromRobots(base)) ?? `${base}/sitemap_index.xml`;
    const xml = await this.getText(indexUrl);
    if (!xml) return undefined;

    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
      (m) => m[1] ?? "",
    );
    // news → press → topics の優先順で最初に一致した子 sitemap を採用
    for (const kw of ["news", "press", "topics", "release"]) {
      const hit = locs.find((l) => l.toLowerCase().includes(kw));
      if (hit) return { url: hit, kind: "sitemap" };
    }
    return undefined;
  }

  private async sitemapFromRobots(base: string): Promise<string | undefined> {
    const txt = await this.getText(`${base}/robots.txt`);
    if (!txt) return undefined;
    const m = /^\s*Sitemap:\s*(\S+)/im.exec(txt);
    return m?.[1];
  }

  private async getText(url: string): Promise<string | undefined> {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": this.env.USER_AGENT },
        signal: AbortSignal.timeout(this.env.LIGHT_HTTP_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    }
  }

  private resolve(base: string, href: string): string {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }
}
