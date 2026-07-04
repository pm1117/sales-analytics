import { originOf } from "./url-canonical";

interface Bucket {
  /** 次に取得可能になる時刻（ms）。 */
  nextAt: number;
  /** 同時実行スロット（DOMAIN_MAX_CONCURRENCY）。 */
  active: number;
  waiters: Array<() => void>;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export interface RateLimiterOptions {
  /** 連続リクエスト間隔の下限（ms）。 */
  minDelayMs: number;
  /** 下限に加算するランダム揺らぎの最大幅（ms）。0 なら固定間隔。 */
  jitterMs: number;
  /** 同一ドメインの同時接続上限。 */
  maxConcurrency: number;
}

/**
 * ドメイン単位のレート制御。相手サーバー保護のため、連続リクエストは
 * 「下限 + ランダム揺らぎ」の間隔をあける（例: 下限10s・揺らぎ10s → 10〜20s の不均一間隔）。
 * robots.txt の Crawl-delay がより長い場合はそちらを優先する。
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly opts: RateLimiterOptions,
    private readonly now: () => number = Date.now,
    private readonly rand: () => number = Math.random,
  ) {}

  /** この呼び出しに適用する実効遅延（ms）を計算する（純関数・テスト可能）。 */
  nextDelayMs(crawlDelayMs?: number): number {
    const base = Math.max(this.opts.minDelayMs, crawlDelayMs ?? 0);
    const jitter = Math.floor(this.rand() * (this.opts.jitterMs + 1));
    return base + jitter;
  }

  /** host に対する取得許可を得る。返り値の release() を必ず呼ぶこと。 */
  async acquire(rawUrl: string, crawlDelayMs?: number): Promise<() => void> {
    const host = originOf(rawUrl);
    const bucket = this.getBucket(host);

    // 同時実行スロット待ち
    while (bucket.active >= this.opts.maxConcurrency) {
      await new Promise<void>((resolve) => bucket.waiters.push(resolve));
    }
    bucket.active += 1;

    // 連続間隔（下限 + 揺らぎ）待ち
    const wait = bucket.nextAt - this.now();
    if (wait > 0) await sleep(wait);
    bucket.nextAt = this.now() + this.nextDelayMs(crawlDelayMs);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.active -= 1;
      const next = bucket.waiters.shift();
      if (next) next();
    };
  }

  private getBucket(host: string): Bucket {
    let b = this.buckets.get(host);
    if (!b) {
      b = { nextAt: 0, active: 0, waiters: [] };
      this.buckets.set(host, b);
    }
    return b;
  }
}
