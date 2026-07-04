import robotsParser from "robots-parser";
import type { Env } from "@sa/shared";
import { originOf } from "./url-canonical";

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
}

interface CacheEntry {
  decisionFor: (path: string) => RobotsDecision;
  expiresAt: number;
}

/**
 * robots.txt を取得・キャッシュし、URL の許可判定と Crawl-delay を返す。
 * 取得不能/404 は「許可」とみなす（一般慣行）。5xx も保守的に許可扱い + ログ想定。
 */
export class RobotsGuard {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly env: Env,
    private readonly now: () => number = Date.now,
  ) {}

  async isAllowed(rawUrl: string): Promise<RobotsDecision> {
    const origin = originOf(rawUrl);
    const entry = await this.getEntry(origin);
    const path = new URL(rawUrl).pathname;
    return entry.decisionFor(path);
  }

  private async getEntry(origin: string): Promise<CacheEntry> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached;

    const decisionFor = await this.fetchAndBuild(origin);
    const entry: CacheEntry = {
      decisionFor,
      expiresAt: this.now() + this.env.ROBOTS_CACHE_TTL_SEC * 1000,
    };
    this.cache.set(origin, entry);
    return entry;
  }

  private async fetchAndBuild(
    origin: string,
  ): Promise<(path: string) => RobotsDecision> {
    const ua = this.env.USER_AGENT;
    const defaultDelay = this.env.DEFAULT_CRAWL_DELAY_MS;
    const robotsUrl = `${origin}/robots.txt`;

    let body: string | undefined;
    try {
      const res = await fetch(robotsUrl, {
        headers: { "user-agent": ua },
        signal: AbortSignal.timeout(this.env.LIGHT_HTTP_TIMEOUT_MS),
      });
      if (res.ok) body = await res.text();
    } catch {
      /* 取得不能は許可扱い */
    }

    if (body === undefined) {
      return () => ({ allowed: true, crawlDelayMs: defaultDelay });
    }

    const robots = robotsParser(robotsUrl, body);
    return (path: string): RobotsDecision => {
      const fullUrl = `${origin}${path}`;
      const allowed = robots.isAllowed(fullUrl, ua) ?? true;
      const delaySec = robots.getCrawlDelay(ua);
      return {
        allowed,
        crawlDelayMs:
          typeof delaySec === "number" ? delaySec * 1000 : defaultDelay,
      };
    };
  }
}
