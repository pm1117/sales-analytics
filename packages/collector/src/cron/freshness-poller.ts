import cron, { type ScheduledTask } from "node-cron";
import type { Env, Logger, Source } from "@sa/shared";
import type { Queue } from "../queue/queue";
import type { SourceRepo } from "../storage/repositories/source-repo";

/**
 * 軽量鮮度巡回（§7）。フィード種別だけを低頻度巡回し、新着 guid のメタを蓄積する。
 * 本文は取らない（needBody=false）。重い本文取得は次のカルテ要求まで遅延。
 */
export class FreshnessPoller {
  private task?: ScheduledTask;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly sourceRepo: SourceRepo,
    private readonly queue: Queue,
  ) {}

  start(): void {
    if (!this.env.FRESHNESS_POLL_ENABLED) {
      this.logger.info("freshness poller disabled");
      return;
    }
    if (!cron.validate(this.env.FRESHNESS_POLL_CRON)) {
      throw new Error(`Invalid FRESHNESS_POLL_CRON: ${this.env.FRESHNESS_POLL_CRON}`);
    }
    this.task = cron.schedule(this.env.FRESHNESS_POLL_CRON, () => {
      void this.tick();
    });
    this.logger.info(
      { cron: this.env.FRESHNESS_POLL_CRON },
      "freshness poller started",
    );
  }

  stop(): void {
    this.task?.stop();
  }

  async tick(): Promise<void> {
    const sources = await this.sourceRepo.listPollable([
      "press_feed",
      "news_feed",
    ]);
    this.logger.info({ count: sources.length }, "freshness tick");
    await Promise.allSettled(sources.map((s) => this.queue.enqueueFetch(this.pollJob(s))));
  }

  private pollJob(source: Source) {
    return {
      idempotencyKey: `${source.id}:${source.canonicalUrl}`,
      companyId: source.companyId,
      sourceId: source.id,
      sourceType: "press_release" as const,
      url: source.url,
      canonicalUrl: source.canonicalUrl,
      kind: source.kind,
      needBody: false,
    };
  }
}
