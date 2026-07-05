import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { createLogger, loadEnv } from "@sa/shared";
import { Db } from "./storage/db";
import { CompanyRepo } from "./storage/repositories/company-repo";
import { SourceRepo } from "./storage/repositories/source-repo";
import { ScrapedContentRepo } from "./storage/repositories/scraped-content-repo";
import { EmbeddingRepo } from "./storage/repositories/embedding-repo";
import { FetchLogRepo } from "./storage/repositories/fetch-log-repo";
import { PolicyRepo } from "./storage/repositories/policy-repo";
import { RobotsGuard } from "./compliance/robots";
import { RateLimiter } from "./compliance/rate-limiter";
import { HttpRssAdapter } from "./adapters/rss";
import { HttpSitemapAdapter } from "./adapters/sitemap";
import { HttpConditionalGetAdapter } from "./adapters/conditional-get";
import { HttpCrawl4aiAdapter } from "./adapters/crawl4ai";
import { FirecrawlManagedAdapter } from "./adapters/managed-crawl";
import {
  createCrawlSemaphore,
  InProcessQueue,
} from "./queue/in-process-queue";
import { FetchPlanner } from "./orchestrator/fetch-planner";
import { FreshnessJudge } from "./orchestrator/freshness-judge";
import { SourceEnumerator } from "./orchestrator/source-enumerator";
import { DossierOrchestrator } from "./orchestrator/dossier-orchestrator";
import { DossierGenerator } from "./claude/dossier-generator";
import { createEmbeddingProvider } from "./embedding/provider-factory";
import { EmbedPipeline } from "./embedding/embed-pipeline";
import { FreshnessPoller } from "./cron/freshness-poller";
import { FitAssessmentRepo } from "./storage/repositories/fit-assessment-repo";
import { CareersProbe } from "./fit/careers-probe";
import { SignalExtractor } from "./fit/signal-extractor";
import { FitOrchestrator } from "./fit/fit-orchestrator";
import { registerHealthRoute } from "./server/routes/health";
import { registerDossierRoute } from "./server/routes/dossier";
import { registerAssessmentRoutes } from "./server/routes/assessment";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger("collector");

  // --- storage ---
  const db = new Db(env);
  const companyRepo = new CompanyRepo(db);
  const sourceRepo = new SourceRepo(db);
  const scrapedRepo = new ScrapedContentRepo(db);
  const embeddingRepo = new EmbeddingRepo(db);
  const fetchLogRepo = new FetchLogRepo(db);
  const policyRepo = new PolicyRepo(db);

  // --- compliance ---
  const robots = new RobotsGuard(env);
  const rateLimiter = new RateLimiter({
    minDelayMs: env.CRAWL_DELAY_MIN_MS,
    jitterMs: env.CRAWL_DELAY_JITTER_MS,
    maxConcurrency: env.DOMAIN_MAX_CONCURRENCY,
  });

  // --- adapters ---
  const rss = new HttpRssAdapter();
  const sitemap = new HttpSitemapAdapter();
  const conditionalGet = new HttpConditionalGetAdapter();
  const crawl4ai = new HttpCrawl4aiAdapter(env.CRAWLER_BASE_URL);
  const managedCrawl = new FirecrawlManagedAdapter({
    enabled: env.MANAGED_CRAWL_ENABLED,
    ...(env.FIRECRAWL_API_KEY !== undefined
      ? { apiKey: env.FIRECRAWL_API_KEY }
      : {}),
  });

  // --- queue + planner (late-bound runners) ---
  const queue = new InProcessQueue({
    fetchConcurrency: Math.max(env.CONCURRENT_CRAWL_LIMIT * 2, 4),
    embedConcurrency: env.EMBED_CONCURRENCY,
    logger,
  });
  const crawlSemaphore = createCrawlSemaphore(env.CONCURRENT_CRAWL_LIMIT);

  const planner = new FetchPlanner({
    env,
    logger,
    sourceRepo,
    scrapedRepo,
    policyRepo,
    fetchLogRepo,
    robots,
    rateLimiter,
    rss,
    sitemap,
    conditionalGet,
    crawl4ai,
    managedCrawl,
    crawlSemaphore,
    queue,
    freshnessJudge: new FreshnessJudge(),
  });

  const embedProvider = createEmbeddingProvider(env);
  const embedPipeline = new EmbedPipeline(
    env,
    logger,
    scrapedRepo,
    embeddingRepo,
    embedProvider,
  );
  queue.setRunners(
    (job) => planner.plan(job),
    (contentId) => embedPipeline.run(contentId),
  );

  // --- orchestrator ---
  const enumerator = new SourceEnumerator(env, sourceRepo, robots);
  const generator = new DossierGenerator(env);
  const orchestrator = new DossierOrchestrator(
    env,
    logger,
    companyRepo,
    scrapedRepo,
    enumerator,
    queue,
    generator,
  );

  // --- fit 判定 (PoC) ---
  const fitRepo = new FitAssessmentRepo(db);
  try {
    // 孤児化した running を failed に倒す（基本設計 §9 リスク 5）
    const interrupted = await fitRepo.markInterrupted();
    if (interrupted > 0) {
      logger.warn({ interrupted }, "marked interrupted fit assessments as failed");
    }
  } catch (err) {
    // migration 0002 未適用でも /dossiers は提供し続ける（/assessments は実行時にエラーになる）
    logger.warn({ err }, "fit_assessments unavailable — apply 0002_fit.sql");
  }
  const fitOrchestrator = new FitOrchestrator({
    logger,
    companyRepo,
    contentRepo: scrapedRepo,
    fitRepo,
    queue,
    enumerator,
    careersProbe: new CareersProbe({
      conditionalGet,
      robots,
      rateLimiter,
      userAgent: env.USER_AGENT,
      timeoutMs: env.LIGHT_HTTP_TIMEOUT_MS,
    }),
    // ANTHROPIC_API_KEY は DossierGenerator のコンストラクタで存在確認済み
    extractor: new SignalExtractor(
      new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      { model: env.FIT_MODEL, maxContextTokens: env.FIT_MAX_CONTEXT_TOKENS },
    ),
    model: env.FIT_MODEL,
  });

  // --- cron ---
  const poller = new FreshnessPoller(env, logger, sourceRepo, queue);
  poller.start();

  // --- http ---
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
  });
  registerHealthRoute(app, db);
  registerDossierRoute(app, orchestrator);
  registerAssessmentRoutes(app, { orchestrator: fitOrchestrator, fitRepo });

  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });

  const shutdown = async (): Promise<void> => {
    poller.stop();
    await app.close();
    await queue.shutdown();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
