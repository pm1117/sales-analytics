import { z } from "zod";
import type {
  CrawlRequest,
  CrawlResponse,
} from "../types/crawler-contract";

/**
 * Crawler サービスとのワイヤフォーマットは snake_case（Python/pydantic 側に合わせる）。
 * TS 側では camelCase の CrawlRequest/CrawlResponse を使い、ここで相互変換する。
 */

export const CrawlMetaWireSchema = z.object({
  title: z.string().optional(),
  fetched_at: z.string(),
  byte_size: z.number().int(),
  rendered: z.boolean(),
});

export const CrawlResponseWireSchema = z.object({
  final_url: z.string().nullable(),
  status: z.number().int(),
  markdown: z.string(),
  meta: CrawlMetaWireSchema.nullable(),
  robots_blocked: z.boolean(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable(),
});

export type CrawlResponseWire = z.infer<typeof CrawlResponseWireSchema>;

export function toCrawlRequestWire(req: CrawlRequest): Record<string, unknown> {
  return {
    url: req.url,
    render: req.render,
    ...(req.extractionHint !== undefined
      ? { extraction_hint: req.extractionHint }
      : {}),
    block_resources: req.blockResources,
    timeout_ms: req.timeoutMs,
    respect_robots: req.respectRobots,
  };
}

export function parseCrawlResponse(raw: unknown): CrawlResponse {
  const w = CrawlResponseWireSchema.parse(raw);
  return {
    finalUrl: w.final_url,
    status: w.status,
    markdown: w.markdown,
    meta: w.meta
      ? {
          ...(w.meta.title !== undefined ? { title: w.meta.title } : {}),
          fetchedAt: w.meta.fetched_at,
          byteSize: w.meta.byte_size,
          rendered: w.meta.rendered,
        }
      : null,
    robotsBlocked: w.robots_blocked,
    error: w.error,
  };
}
