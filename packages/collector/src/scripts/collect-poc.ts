import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, loadEnv, type FetchJob } from "@sa/shared";
import { Db } from "../storage/db";
import { CompanyRepo } from "../storage/repositories/company-repo";
import { SourceRepo } from "../storage/repositories/source-repo";
import { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import { FetchLogRepo } from "../storage/repositories/fetch-log-repo";
import { PolicyRepo } from "../storage/repositories/policy-repo";
import { RobotsGuard } from "../compliance/robots";
import { RateLimiter } from "../compliance/rate-limiter";
import { domainOf } from "../compliance/url-canonical";
import { HttpRssAdapter } from "../adapters/rss";
import { HttpSitemapAdapter } from "../adapters/sitemap";
import { HttpConditionalGetAdapter } from "../adapters/conditional-get";
import { HttpCrawl4aiAdapter } from "../adapters/crawl4ai";
import { FirecrawlManagedAdapter } from "../adapters/managed-crawl";
import {
  createCrawlSemaphore,
  InProcessQueue,
} from "../queue/in-process-queue";
import { FetchPlanner } from "../orchestrator/fetch-planner";
import { FreshnessJudge } from "../orchestrator/freshness-judge";
import { SourceEnumerator } from "../orchestrator/source-enumerator";

/**
 * 収集のみ PoC。埋め込み(VOYAGE/OPENAI)とカルテ生成(ANTHROPIC)は行わない。
 * 取得→DB保存までを実データで検証し、fetch_log / scraped_contents を出力する。
 *   使い方: tsx packages/collector/src/scripts/collect-poc.ts <company-url>
 */
async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: collect-poc <company-url>");
    process.exit(1);
  }

  const env = loadEnv();
  const logger = createLogger("collect-poc");

  const db = new Db(env);
  const companyRepo = new CompanyRepo(db);
  const sourceRepo = new SourceRepo(db);
  const scrapedRepo = new ScrapedContentRepo(db);
  const fetchLogRepo = new FetchLogRepo(db);
  const policyRepo = new PolicyRepo(db);

  const robots = new RobotsGuard(env);
  const rateLimiter = new RateLimiter({
    minDelayMs: env.CRAWL_DELAY_MIN_MS,
    jitterMs: env.CRAWL_DELAY_JITTER_MS,
    maxConcurrency: env.DOMAIN_MAX_CONCURRENCY,
  });

  const queue = new InProcessQueue({
    fetchConcurrency: Math.max(env.CONCURRENT_CRAWL_LIMIT * 2, 4),
    embedConcurrency: env.EMBED_CONCURRENCY,
    logger,
  });
  const planner = new FetchPlanner({
    env,
    logger,
    sourceRepo,
    scrapedRepo,
    policyRepo,
    fetchLogRepo,
    robots,
    rateLimiter,
    rss: new HttpRssAdapter(),
    sitemap: new HttpSitemapAdapter(),
    conditionalGet: new HttpConditionalGetAdapter(),
    crawl4ai: new HttpCrawl4aiAdapter(env.CRAWLER_BASE_URL),
    managedCrawl: new FirecrawlManagedAdapter({
      enabled: env.MANAGED_CRAWL_ENABLED,
    }),
    crawlSemaphore: createCrawlSemaphore(env.CONCURRENT_CRAWL_LIMIT),
    queue,
    freshnessJudge: new FreshnessJudge(),
  });
  // 収集のみ: 埋め込みは no-op（キー未設定のため）
  queue.setRunners(
    (job) => planner.plan(job),
    async () => {
      /* embedding skipped (no API key in collection-only PoC) */
    },
  );

  // company を URL から解決
  const domain = domainOf(target);
  const company =
    (await companyRepo.findByDomain(domain)) ??
    (await companyRepo.upsertByDomain({ name: domain, domain }));

  // robots プレビュー
  const enumerator = new SourceEnumerator(env, sourceRepo, robots);
  const sources = await enumerator.ensureSources(company);
  console.log("\n=== sources (robots preview) ===");
  for (const s of sources) {
    console.log(
      `  [${s.kind}] ${s.url}  robotsAllowed=${s.robotsAllowed} crawlDelayMs=${s.crawlDelayMs ?? "-"} feedKind=${s.feedKind ?? "-"}`,
    );
  }

  // 収集（部分失敗許容）
  const jobs: FetchJob[] = sources.map((s) => ({
    idempotencyKey: `${s.id}:${s.canonicalUrl}`,
    companyId: company.id,
    sourceId: s.id,
    sourceType:
      s.kind === "press_feed" || s.kind === "news_feed"
        ? "press_release"
        : "corporate_hp",
    url: s.url,
    canonicalUrl: s.canonicalUrl,
    kind: s.kind,
    needBody: true,
    renderHint: "auto",
  }));

  console.log("\n=== collecting (10〜20s/domain, 並列1) ===");
  const t0 = Date.now();
  const results = await Promise.allSettled(
    jobs.map((j) => queue.enqueueFetch(j)),
  );
  results.forEach((r, i) => {
    const kind = sources[i]?.kind;
    if (r.status === "fulfilled") {
      console.log(
        `  [${kind}] gate=${r.value.gate} method=${r.value.method} outcome=${r.value.outcome}${r.value.error ? ` err=${r.value.error.code}` : ""}`,
      );
    } else {
      console.log(`  [${kind}] REJECTED ${String(r.reason)}`);
    }
  });
  console.log(`  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // DB 確認
  const log = await db.query<{
    gate: number | null;
    method: string;
    http_status: number | null;
    bytes: number | null;
    duration_ms: number | null;
    cache_hit: boolean;
    robots_blocked: boolean;
    requested_at: Date;
  }>(
    `SELECT gate, method, http_status, bytes, duration_ms, cache_hit, robots_blocked, requested_at
       FROM fetch_log WHERE company_id = $1 ORDER BY requested_at`,
    [company.id],
  );
  console.log("\n=== fetch_log ===");
  let prev: number | undefined;
  for (const l of log) {
    const at = l.requested_at.getTime();
    const gap = prev ? `${((at - prev) / 1000).toFixed(1)}s` : "-";
    prev = at;
    console.log(
      `  +${gap.padStart(6)}  gate=${l.gate ?? "-"} method=${l.method.padEnd(15)} http=${l.http_status ?? "-"} bytes=${l.bytes ?? "-"} cache=${l.cache_hit} robotsBlocked=${l.robots_blocked}`,
    );
  }

  const contents = await db.query<{
    source_type: string;
    url: string;
    canonical_url: string;
    title: string | null;
    content_md: string;
    fetch_method: string;
    guid: string | null;
    published_at: Date | null;
    fetched_at: Date;
  }>(
    `SELECT source_type, url, canonical_url, title, content_md, fetch_method, guid, published_at, fetched_at
       FROM scraped_contents WHERE company_id = $1 ORDER BY fetched_at`,
    [company.id],
  );
  console.log("\n=== scraped_contents ===");
  for (const c of contents) {
    console.log(
      `  [${c.source_type}] ${c.canonical_url}  md=${c.content_md.length}chars method=${c.fetch_method} guid=${c.guid ?? "-"}`,
    );
  }

  // === このディレクトリ内へ出力 ===
  const outDir = process.argv[3] ?? join("poc-output", domain);
  mkdirSync(join(outDir, "contents"), { recursive: true });

  contents.forEach((c, i) => {
    const slug = c.canonical_url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const header = [
      `<!--`,
      `source_type: ${c.source_type}`,
      `url: ${c.url}`,
      `canonical_url: ${c.canonical_url}`,
      `title: ${c.title ?? ""}`,
      `fetch_method: ${c.fetch_method}`,
      `guid: ${c.guid ?? ""}`,
      `published_at: ${c.published_at?.toISOString() ?? ""}`,
      `fetched_at: ${c.fetched_at.toISOString()}`,
      `-->`,
      "",
    ].join("\n");
    writeFileSync(
      join(outDir, "contents", `${String(i + 1).padStart(2, "0")}-${c.source_type}-${slug}.md`),
      header + c.content_md + "\n",
    );
  });

  const summary = {
    company: { id: company.id, name: company.name, domain: company.domain },
    fetchedAt: new Date().toISOString(),
    manners: {
      minDelayMs: env.CRAWL_DELAY_MIN_MS,
      jitterMs: env.CRAWL_DELAY_JITTER_MS,
      domainMaxConcurrency: env.DOMAIN_MAX_CONCURRENCY,
    },
    sources: sources.map((s) => ({
      kind: s.kind,
      url: s.url,
      robotsAllowed: s.robotsAllowed,
      crawlDelayMs: s.crawlDelayMs ?? null,
      feedKind: s.feedKind ?? null,
    })),
    results: results.map((r, i) => ({
      kind: sources[i]?.kind ?? null,
      ...(r.status === "fulfilled"
        ? {
            gate: r.value.gate,
            method: r.value.method,
            outcome: r.value.outcome,
            error: r.value.error?.code ?? null,
          }
        : { rejected: String(r.reason) }),
    })),
    fetchLog: log.map((l) => ({
      gate: l.gate,
      method: l.method,
      httpStatus: l.http_status,
      bytes: l.bytes,
      durationMs: l.duration_ms,
      cacheHit: l.cache_hit,
      robotsBlocked: l.robots_blocked,
      requestedAt: l.requested_at.toISOString(),
    })),
    scrapedContents: contents.map((c) => ({
      sourceType: c.source_type,
      canonicalUrl: c.canonical_url,
      title: c.title,
      mdLength: c.content_md.length,
      fetchMethod: c.fetch_method,
      guid: c.guid,
      publishedAt: c.published_at?.toISOString() ?? null,
    })),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n=== output written to ${outDir}/ ===`);
  console.log(`  summary.json + contents/*.md (${contents.length} files)`);

  await queue.shutdown();
  await db.close();
  console.log("\ndone.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
