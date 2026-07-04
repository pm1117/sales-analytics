import pLimit, { type LimitFunction } from "p-limit";
import type { FetchJob, FetchResult, Logger } from "@sa/shared";
import type { EmbedRunner, FetchRunner, Queue } from "./queue";

export interface InProcessQueueOptions {
  fetchConcurrency: number;
  embedConcurrency: number;
  logger: Logger;
}

/**
 * MVP のキュー実装。p-limit で並行度を制御し、Map で inflight dedup を行う。
 * fetchRunner/embedRunner は循環参照回避のため後から setRunners で注入する。
 */
export class InProcessQueue implements Queue {
  private readonly fetchLimit: LimitFunction;
  private readonly embedLimit: LimitFunction;
  private readonly inflight = new Map<string, Promise<FetchResult>>();
  private fetchRunner?: FetchRunner;
  private embedRunner?: EmbedRunner;

  constructor(private readonly opts: InProcessQueueOptions) {
    this.fetchLimit = pLimit(opts.fetchConcurrency);
    this.embedLimit = pLimit(opts.embedConcurrency);
  }

  setRunners(fetchRunner: FetchRunner, embedRunner: EmbedRunner): void {
    this.fetchRunner = fetchRunner;
    this.embedRunner = embedRunner;
  }

  enqueueFetch(job: FetchJob): Promise<FetchResult> {
    const existing = this.inflight.get(job.idempotencyKey);
    if (existing) return existing;

    const runner = this.fetchRunner;
    if (!runner) throw new Error("InProcessQueue: fetchRunner not set");

    const promise = this.fetchLimit(() => runner(job)).finally(() => {
      this.inflight.delete(job.idempotencyKey);
    });
    this.inflight.set(job.idempotencyKey, promise);
    return promise;
  }

  enqueueEmbed(contentId: string): void {
    const runner = this.embedRunner;
    if (!runner) throw new Error("InProcessQueue: embedRunner not set");
    void this.embedLimit(() => runner(contentId)).catch((err: unknown) => {
      this.opts.logger.error({ err, contentId }, "embed job failed");
    });
  }

  size(): { pending: number; active: number } {
    return {
      pending: this.fetchLimit.pendingCount,
      active: this.fetchLimit.activeCount,
    };
  }

  async shutdown(): Promise<void> {
    this.fetchLimit.clearQueue();
    this.embedLimit.clearQueue();
    // 実行中ジョブの完了待ち
    await Promise.allSettled([...this.inflight.values()]);
  }
}

/** Gate3(Playwright) 専用の同時実行セマフォ。メモリ安全のため CONCURRENT_CRAWL_LIMIT で絞る。 */
export function createCrawlSemaphore(limit: number): LimitFunction {
  return pLimit(limit);
}
