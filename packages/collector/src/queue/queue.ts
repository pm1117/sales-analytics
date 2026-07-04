import type { FetchJob, FetchResult } from "@sa/shared";

/** ジョブ実行本体。planner.plan を後から注入する（循環参照を避けるため late-binding）。 */
export type FetchRunner = (job: FetchJob) => Promise<FetchResult>;
export type EmbedRunner = (contentId: string) => Promise<void>;

/**
 * 差し替え点: in-process(p-limit) → pg-boss → BullMQ。
 * 呼び出し側はこの interface のみに依存する。
 */
export interface Queue {
  /** 冪等キーで inflight を合流。同一ジョブの二重フェッチを防ぐ。 */
  enqueueFetch(job: FetchJob): Promise<FetchResult>;
  /** store 時 async embed（fire-and-forget）。 */
  enqueueEmbed(contentId: string): void;
  size(): { pending: number; active: number };
  shutdown(): Promise<void>;
}
