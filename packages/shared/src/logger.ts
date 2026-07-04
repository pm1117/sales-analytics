import { pino, type Logger } from "pino";

/** 構造化運用ログ（fetch_log の監査ログとは別物）。 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env["LOG_LEVEL"] ?? "info",
  });
}

export type { Logger };
