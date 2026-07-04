import type { FetchMethod, Gate } from "@sa/shared";
import { COMPLIANCE_POLICY } from "@sa/shared";
import type { Db } from "../db";

export interface FetchLogEntry {
  sourceId?: string;
  companyId?: string;
  gate?: Gate | null;
  method: FetchMethod;
  httpStatus?: number;
  bytes?: number;
  durationMs?: number;
  cacheHit?: boolean;
  robotsBlocked?: boolean;
  costNote?: string;
}

/** 全取得を記録（監査・コスト計測・法務エビデンス）。legal_basis は著作権法30条の4。 */
export class FetchLogRepo {
  constructor(private readonly db: Db) {}

  async record(e: FetchLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO fetch_log
         (source_id, company_id, gate, method, http_status, bytes, duration_ms,
          cache_hit, robots_blocked, cost_note, legal_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        e.sourceId ?? null,
        e.companyId ?? null,
        e.gate ?? null,
        e.method,
        e.httpStatus ?? null,
        e.bytes ?? null,
        e.durationMs ?? null,
        e.cacheHit ?? false,
        e.robotsBlocked ?? false,
        e.costNote ?? null,
        COMPLIANCE_POLICY.legalBasis,
      ],
    );
  }
}
