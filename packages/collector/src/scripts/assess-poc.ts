import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  SIGNAL_BY_ID,
  SIGNALS_VERSION,
  createLogger,
  loadEnv,
  type AssessmentCost,
  type CareersCheck,
  type FitAssessment,
  type NeedLevel,
  type SignalId,
  type SignalResult,
  type SourceType,
} from "@sa/shared";
import { Db } from "../storage/db";
import { CompanyRepo } from "../storage/repositories/company-repo";
import { SourceRepo } from "../storage/repositories/source-repo";
import { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import { FetchLogRepo } from "../storage/repositories/fetch-log-repo";
import { PolicyRepo } from "../storage/repositories/policy-repo";
import { FitAssessmentRepo } from "../storage/repositories/fit-assessment-repo";
import { RobotsGuard } from "../compliance/robots";
import { RateLimiter } from "../compliance/rate-limiter";
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
import { CareersProbe } from "../fit/careers-probe";
import { PROMPT_VERSION } from "../fit/fit-prompt";
import {
  FitOrchestrator,
  overrideCareersSignal,
  sourceTypeToKind,
} from "../fit/fit-orchestrator";
import { SignalExtractor, type ContentSnippet } from "../fit/signal-extractor";
import { filterEvidence } from "../fit/evidence-filter";
import { judge } from "../fit/need-judge";

/**
 * Fit 判定 PoC CLI（詳細設計 §E-1）。
 *
 *   フル実行（要 DB + migration 0002 + ANTHROPIC_API_KEY）:
 *     tsx packages/collector/src/scripts/assess-poc.ts <company-url> [--out <dir>]
 *
 *   オフライン（収集なし・DB 不要。ANTHROPIC_API_KEY のみ）:
 *     tsx packages/collector/src/scripts/assess-poc.ts --offline <dir> \
 *       [--careers-found <url> | --careers-none]
 *     <dir> は collect-poc.ts の出力（summary.json + contents/*.md）。
 *     careers フラグ省略時は「careers 未確認」= 収集最低要件未達 → unknown になる。
 *
 * どちらも <dir>/fit-judgement.json と fit-judgement.md を出力する。
 */

interface Judgement {
  company: { name: string; domain: string };
  judgedAt: string;
  signalsVersion: string;
  promptVersion: string;
  needLevel: NeedLevel;
  signals: SignalResult[];
  counterSignals: SignalId[];
  missingData: SignalId[];
  careersCheck: CareersCheck | null;
  rationale: string;
  cost: AssessmentCost;
}

function renderMarkdown(j: Judgement): string {
  const detected = j.signals.filter((s) => s.detected);
  const line = (s: SignalResult): string => {
    const def = SIGNAL_BY_ID.get(s.id);
    const links = s.evidence
      .map((e) => `[${e.url}](${e.url})（${e.source} / ${e.checkedAt}）`)
      .join(" / ");
    return `- **${s.id} ${def?.name ?? ""}**（${s.strength}）: ${s.evidence.map((e) => e.quoteSummary).join(" / ")}\n  - 出典: ${links}`;
  };
  return [
    `# Fit 判定: ${j.company.domain}`,
    "",
    `- 判定: **${j.needLevel}**（${j.judgedAt}）`,
    `- 根拠: ${j.rationale}`,
    `- バージョン: signals ${j.signalsVersion} / prompt ${j.promptVersion} / ${j.cost.model}`,
    "",
    "## 検出シグナル",
    ...(detected.filter((s) => s.strength !== "counter").map(line)
      ?? []),
    ...(detected.some((s) => s.strength !== "counter") ? [] : ["- なし"]),
    "",
    "## 逆指標",
    ...(detected.filter((s) => s.strength === "counter").map(line) ?? []),
    ...(detected.some((s) => s.strength === "counter") ? [] : ["- なし"]),
    "",
    "## 取得できなかった情報",
    j.missingData.length > 0
      ? j.missingData
          .map((id) => `- ${id} ${SIGNAL_BY_ID.get(id)?.name ?? ""}`)
          .join("\n")
      : "- なし",
    "",
    "## careers 確認",
    j.careersCheck
      ? [
          `- 発見: ${j.careersCheck.foundUrl ?? "なし"}`,
          ...j.careersCheck.checkedUrls.map((u) => `  - 確認: ${u}`),
        ].join("\n")
      : "- 未確認",
    "",
    `## コスト`,
    `- ${(j.cost.durationMs / 1000).toFixed(1)}s / in ${j.cost.inputTokens} tok / out ${j.cost.outputTokens} tok`,
    "",
  ].join("\n");
}

function writeJudgement(outDir: string, j: Judgement): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "fit-judgement.json"),
    JSON.stringify(j, null, 2),
  );
  writeFileSync(join(outDir, "fit-judgement.md"), renderMarkdown(j));
}

/** S3（出典付与率 100%）の機械チェック（要件 §2-2）。 */
function checkS3(j: Judgement): void {
  if (j.needLevel !== "high" && j.needLevel !== "medium") return;
  const violations = j.signals.filter(
    (s) => s.detected && s.evidence.length === 0,
  );
  console.log(
    violations.length === 0
      ? "S3 check: OK（検出シグナル全件に出典あり）"
      : `S3 check: NG（出典なしの検出シグナル: ${violations.map((s) => s.id).join(", ")}）`,
  );
}

function summarize(j: Judgement, extra: string[]): void {
  console.log(`\n=== fit judgement ===`);
  console.log(`  needLevel=${j.needLevel}`);
  console.log(`  rationale=${j.rationale}`);
  const detected = j.signals.filter((s) => s.detected).map((s) => s.id);
  console.log(`  detected=[${detected.join(", ")}] missing=[${j.missingData.join(", ")}]`);
  console.log(
    `  cost: ${(j.cost.durationMs / 1000).toFixed(1)}s / in ${j.cost.inputTokens} / out ${j.cost.outputTokens} (${j.cost.model})`,
  );
  for (const line of extra) console.log(`  ${line}`);
  checkS3(j);
}

// ---------- offline モード（§E-1） ----------

interface ParsedContent {
  sourceType: SourceType;
  url: string;
  canonicalUrl: string;
  fetchedAt: string;
  markdown: string;
}

/** collect-poc.ts が書く HTML コメントヘッダをパースする。 */
function parseContentFile(path: string): ParsedContent | null {
  const text = readFileSync(path, "utf8");
  const m = /^<!--\n([\s\S]*?)\n-->\n?/.exec(text);
  if (!m) return null;
  const meta = new Map<string, string>();
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const sourceType = meta.get("source_type") as SourceType | undefined;
  const url = meta.get("url");
  if (!sourceType || !url) return null;
  return {
    sourceType,
    url,
    canonicalUrl: meta.get("canonical_url") ?? url,
    fetchedAt: meta.get("fetched_at") ?? "",
    markdown: text.slice(m[0].length),
  };
}

async function runOffline(
  dir: string,
  careersFlag: { foundUrl?: string; none?: boolean },
): Promise<void> {
  // オフラインは DB 不要（§E-1）。EnvSchema の必須 DATABASE_URL はダミーで満たす。
  const env = loadEnv({
    ...process.env,
    DATABASE_URL:
      process.env["DATABASE_URL"] ?? "postgres://offline:offline@localhost:5432/offline",
  });
  if (!env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const summary = JSON.parse(
    readFileSync(join(dir, "summary.json"), "utf8"),
  ) as { company: { name: string; domain: string } };
  const company = summary.company;

  const contents = readdirSync(join(dir, "contents"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseContentFile(join(dir, "contents", f)))
    .filter((c): c is ParsedContent => c !== null);

  // §C-2 の組み立て順: careers → jobs_media → press(5) → hp(1)
  const byType = (t: SourceType): ParsedContent[] =>
    contents.filter((c) => c.sourceType === t);
  const ordered = [
    ...byType("careers_page"),
    ...byType("job_posting"),
    ...byType("press_release").slice(0, 5),
    ...byType("corporate_hp").slice(0, 1),
  ];
  const snippets: ContentSnippet[] = ordered.map((c) => ({
    url: c.canonicalUrl,
    sourceKind: sourceTypeToKind(c.sourceType),
    fetchedAt: c.fetchedAt,
    markdown: c.markdown,
  }));

  const careersCheck: CareersCheck = careersFlag.foundUrl
    ? { checkedUrls: [careersFlag.foundUrl], foundUrl: careersFlag.foundUrl }
    : careersFlag.none
      ? { checkedUrls: [`https://${company.domain}/recruit`], foundUrl: null }
      : { checkedUrls: [], foundUrl: null }; // 未確認 → 最低要件未達 = unknown

  const today = new Date().toISOString().slice(0, 10);
  const allowedUrls = [
    ...snippets.map((s) => s.url),
    ...careersCheck.checkedUrls,
  ];

  const t0 = Date.now();
  const extractor = new SignalExtractor(
    new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    { model: env.FIT_MODEL, maxContextTokens: env.FIT_MAX_CONTEXT_TOKENS },
  );
  const extraction = await extractor.extract({
    company,
    snippets,
    allowedUrls,
    today,
  });

  const filtered = filterEvidence(extraction.signals, new Set(allowedUrls), today);
  const signals = overrideCareersSignal(filtered.signals, careersCheck, today);
  const result = judge({
    signals,
    collection: {
      careersChecked: careersCheck.checkedUrls.length > 0,
      jobsInfoCount: byType("job_posting").length,
      prNewsCount: byType("press_release").length,
    },
  });

  const judgement: Judgement = {
    company,
    judgedAt: new Date().toISOString(),
    signalsVersion: SIGNALS_VERSION,
    promptVersion: PROMPT_VERSION,
    needLevel: result.needLevel,
    signals,
    counterSignals: signals
      .filter((s) => s.detected && s.strength === "counter")
      .map((s) => s.id),
    missingData: result.missingData,
    careersCheck,
    rationale: result.rationale,
    cost: {
      model: env.FIT_MODEL,
      inputTokens: extraction.usage.inputTokens,
      outputTokens: extraction.usage.outputTokens,
      durationMs: Date.now() - t0,
    },
  };
  writeJudgement(dir, judgement);
  summarize(judgement, [
    `droppedEvidence=${filtered.droppedCount} droppedSnippets=[${extraction.droppedSnippetUrls.join(", ")}]`,
    `output: ${dir}/fit-judgement.{json,md}`,
  ]);
}

// ---------- フル実行 ----------

async function runFull(target: string, outBase: string | undefined): Promise<void> {
  const env = loadEnv();
  const logger = createLogger("assess-poc");
  if (!env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const db = new Db(env);
  const companyRepo = new CompanyRepo(db);
  const sourceRepo = new SourceRepo(db);
  const scrapedRepo = new ScrapedContentRepo(db);
  const fetchLogRepo = new FetchLogRepo(db);
  const policyRepo = new PolicyRepo(db);
  const fitRepo = new FitAssessmentRepo(db);

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
  const conditionalGet = new HttpConditionalGetAdapter();
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
    conditionalGet,
    crawl4ai: new HttpCrawl4aiAdapter(env.CRAWLER_BASE_URL),
    managedCrawl: new FirecrawlManagedAdapter({
      enabled: env.MANAGED_CRAWL_ENABLED,
    }),
    crawlSemaphore: createCrawlSemaphore(env.CONCURRENT_CRAWL_LIMIT),
    queue,
    freshnessJudge: new FreshnessJudge(),
  });
  queue.setRunners(
    (job) => planner.plan(job),
    async () => {
      /* embedding skipped in fit PoC */
    },
  );

  const orchestrator = new FitOrchestrator({
    logger,
    companyRepo,
    contentRepo: scrapedRepo,
    fitRepo,
    queue,
    enumerator: new SourceEnumerator(env, sourceRepo, robots),
    careersProbe: new CareersProbe({
      conditionalGet,
      robots,
      rateLimiter,
      userAgent: env.USER_AGENT,
      timeoutMs: env.LIGHT_HTTP_TIMEOUT_MS,
    }),
    extractor: new SignalExtractor(
      new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      { model: env.FIT_MODEL, maxContextTokens: env.FIT_MAX_CONTEXT_TOKENS },
    ),
    model: env.FIT_MODEL,
  });

  const input = { companyNameOrUrl: target };
  const company = await orchestrator.resolveCompany(target);
  const id = await fitRepo.insert({
    companyId: company.id,
    input,
    signalsVersion: SIGNALS_VERSION,
    promptVersion: PROMPT_VERSION,
  });
  console.log(`assessment ${id} started（収集は 10〜20s/domain・並列1）`);
  await orchestrator.run(id, input); // CLI では完了まで待つ

  const assessment = (await fitRepo.get(id)) as FitAssessment;
  if (assessment.status !== "succeeded") {
    console.error(`assessment failed at stage=${assessment.stage}: ${assessment.error}`);
    await queue.shutdown();
    await db.close();
    process.exit(1);
  }

  const outDir = outBase ?? join("poc-output", company.domain);
  const judgement: Judgement = {
    company: { name: assessment.company.name, domain: assessment.company.domain },
    judgedAt: assessment.judgedAt ?? new Date().toISOString(),
    signalsVersion: assessment.signalsVersion,
    promptVersion: assessment.promptVersion,
    needLevel: assessment.needLevel as NeedLevel,
    signals: assessment.signals,
    counterSignals: assessment.counterSignals,
    missingData: assessment.missingData,
    careersCheck: assessment.careersCheck,
    rationale: assessment.rationale ?? "",
    cost: assessment.cost as AssessmentCost,
  };
  writeJudgement(outDir, judgement);
  summarize(judgement, [`assessmentId=${id}`, `output: ${outDir}/fit-judgement.{json,md}`]);

  await queue.shutdown();
  await db.close();
}

// ---------- entry ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--offline") {
    const dir = args[1];
    if (!dir) {
      console.error("usage: assess-poc --offline <dir> [--careers-found <url> | --careers-none]");
      process.exit(1);
    }
    const foundIdx = args.indexOf("--careers-found");
    await runOffline(dir, {
      ...(foundIdx >= 0 && args[foundIdx + 1]
        ? { foundUrl: args[foundIdx + 1] as string }
        : {}),
      ...(args.includes("--careers-none") ? { none: true } : {}),
    });
    return;
  }

  const target = args[0];
  if (!target) {
    console.error(
      "usage: assess-poc <company-url> [--out <dir>] | --offline <dir> [--careers-found <url> | --careers-none]",
    );
    process.exit(1);
  }
  const outIdx = args.indexOf("--out");
  await runFull(target, outIdx >= 0 ? args[outIdx + 1] : undefined);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
