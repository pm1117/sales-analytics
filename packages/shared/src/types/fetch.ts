import type { FetchMethod, SourceKind, SourceType } from "./domain";

export type Gate = 0 | 1 | 2 | 3 | 4;

export type FetchOutcome =
  | "stored"
  | "not_modified"
  | "unchanged"
  | "blocked"
  | "skipped"
  | "error";

/** 冪等キー = `${sourceId}:${canonicalUrl}`。inflight dedup の合流キーにもなる。 */
export interface FetchJob {
  idempotencyKey: string;
  companyId: string;
  sourceId: string;
  sourceType: SourceType;
  url: string;
  canonicalUrl: string;
  kind: SourceKind;
  /** 本文が必要か。false ならフィード巡回（見出し/URL のみ）。 */
  needBody: boolean;
  /** Gate4 マネージド API を許可するか（既定 false, opt-in）。 */
  allowManaged?: boolean;
  renderHint?: "auto" | "static" | "js";
  /** プレス本文の子ジョブに付与するメタ（フィードから引き継ぐ）。 */
  press?: {
    guid?: string;
    publishedAt?: Date;
    title?: string;
  };
}

export interface FetchError {
  code: string;
  message: string;
}

export interface FetchResult {
  job: FetchJob;
  gate: Gate;
  method: FetchMethod;
  outcome: FetchOutcome;
  /** scraped_contents.id（保存時）。 */
  contentId?: string;
  httpStatus?: number;
  byteSize?: number;
  robotsBlocked?: boolean;
  error?: FetchError;
}
