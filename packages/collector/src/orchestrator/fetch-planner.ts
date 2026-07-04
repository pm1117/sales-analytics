import type {
  Env,
  FetchJob,
  FetchMethod,
  FetchResult,
  Gate,
  Logger,
  Source,
  SourceType,
} from "@sa/shared";
import type { LimitFunction } from "p-limit";
import { canonicalizeUrl, contentHash } from "../compliance/url-canonical";
import type { RateLimiter } from "../compliance/rate-limiter";
import type { RobotsGuard } from "../compliance/robots";
import type {
  AdapterContext,
  ConditionalGetAdapter,
  Crawl4aiAdapter,
  FeedEntry,
  ManagedCrawlAdapter,
  RssAdapter,
  SitemapAdapter,
} from "../adapters/source-adapter";
import type { Queue } from "../queue/queue";
import type { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import type { SourceRepo } from "../storage/repositories/source-repo";
import type { PolicyRepo } from "../storage/repositories/policy-repo";
import type { FetchLogRepo } from "../storage/repositories/fetch-log-repo";
import { FreshnessJudge } from "./freshness-judge";

/** オンデマンド要求時、フィードから本文を取得するプレスの上限件数。 */
const PRESS_BODY_LIMIT = 5;

export interface PlannerDeps {
  env: Env;
  logger: Logger;
  sourceRepo: SourceRepo;
  scrapedRepo: ScrapedContentRepo;
  policyRepo: PolicyRepo;
  fetchLogRepo: FetchLogRepo;
  robots: RobotsGuard;
  rateLimiter: RateLimiter;
  rss: RssAdapter;
  sitemap: SitemapAdapter;
  conditionalGet: ConditionalGetAdapter;
  crawl4ai: Crawl4aiAdapter;
  managedCrawl: ManagedCrawlAdapter;
  /** Gate3(Playwright) 専用セマフォ。CONCURRENT_CRAWL_LIMIT で絞る。 */
  crawlSemaphore: LimitFunction;
  queue: Queue;
  freshnessJudge: FreshnessJudge;
}

/**
 * 取得決定木（Gate0..Gate4）の中枢。上ほど安い手段を優先し、足りたら降りない。
 * 詳細設計 §4 に対応。
 */
export class FetchPlanner {
  constructor(private readonly d: PlannerDeps) {}

  async plan(job: FetchJob): Promise<FetchResult> {
    const t0 = Date.now();
    const source = await this.d.sourceRepo.get(job.sourceId);
    if (!source) {
      return this.errorResult(job, "no_source", "source not found");
    }
    const policy = await this.d.policyRepo.get(job.kind);

    // robots チェック（不許可なら crawler を呼ばず中止）
    const decision = await this.d.robots.isAllowed(job.canonicalUrl);
    if (!decision.allowed) {
      await this.log(job, 3, "crawl4ai", t0, { robotsBlocked: true });
      return {
        job,
        gate: 3,
        method: "crawl4ai",
        outcome: "blocked",
        robotsBlocked: true,
      };
    }

    const isFeedPoll =
      source.feedKind !== undefined &&
      job.canonicalUrl === source.canonicalUrl;

    // ===== Gate 0: キャッシュ命中 & 鮮度 =====
    const latest = await this.d.scrapedRepo.latestForSource(source.id);
    if (this.d.freshnessJudge.isFresh(source, latest, policy)) {
      await this.log(job, 0, "cache_hit", t0, { cacheHit: true });
      return {
        job,
        gate: 0,
        method: "cache_hit",
        outcome: "skipped",
        ...(latest ? { contentId: latest.id } : {}),
      };
    }

    if (isFeedPoll) {
      return this.runFeed(job, source, t0, decision.crawlDelayMs);
    }
    return this.runPage(job, source, t0, decision.crawlDelayMs);
  }

  // ===== Gate 1: RSS/Atom/sitemap =====
  private async runFeed(
    job: FetchJob,
    source: Source,
    t0: number,
    crawlDelayMs: number,
  ): Promise<FetchResult> {
    const ctx = this.ctx(this.d.env.LIGHT_HTTP_TIMEOUT_MS);
    const release = await this.d.rateLimiter.acquire(
      source.url,
      crawlDelayMs,
    );
    let entries: FeedEntry[];
    try {
      entries =
        source.feedKind === "sitemap"
          ? await this.d.sitemap.fetchSitemap(source.url, ctx)
          : await this.d.rss.fetchFeed(source.url, ctx);
    } finally {
      release();
    }

    const policy = await this.d.policyRepo.get(job.kind);
    const staleAfter = new Date(
      Date.now() + policy.feedPollIntervalS * 1000,
    );
    await this.d.sourceRepo.updateFetchState(source.id, {
      lastPolledAt: new Date(),
      staleAfter,
    });

    // 新着のみ抽出（guid があれば guid、無ければ canonical_url を identity に）
    const knownUrls = await this.d.scrapedRepo.existingPressUrls(
      source.companyId,
    );
    const fresh = entries.filter(
      (e) => e.url.length > 0 && !knownUrls.has(canonicalizeUrl(e.url)),
    );

    // 新着メタを保存（本文は取らない）。summary のある RSS のみ。sitemap は本文取得へ。
    for (const e of fresh) {
      if (e.guid !== undefined && e.summaryMd !== undefined) {
        await this.storePressMeta(job, source, e);
      }
    }

    await this.log(job, 1, "rss", t0, {
      costNote: `feed entries=${entries.length} new=${fresh.length}`,
    });

    if (!job.needBody) {
      return { job, gate: 1, method: "rss", outcome: "stored" };
    }

    // 本文が必要: 直近 N 件だけ本文を取得（子ジョブ）
    const recent = [...fresh]
      .sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      )
      .slice(0, PRESS_BODY_LIMIT);

    await Promise.allSettled(
      recent.map((e) => this.d.queue.enqueueFetch(this.childBodyJob(job, source, e))),
    );

    return {
      job,
      gate: 1,
      method: "rss",
      outcome: "stored",
    };
  }

  // ===== Gate 2 → 3 → 4: 単一ページ / プレス本文 =====
  private async runPage(
    job: FetchJob,
    source: Source,
    t0: number,
    crawlDelayMs: number,
  ): Promise<FetchResult> {
    const policy = await this.d.policyRepo.get(job.kind);
    const isPressBody = job.sourceType === "press_release";
    const release = await this.d.rateLimiter.acquire(
      job.url,
      crawlDelayMs,
    );
    try {
      // ---- Gate 2: 条件付き GET ----
      const prev = isPressBody
        ? {}
        : {
            ...(source.etag !== undefined ? { etag: source.etag } : {}),
            ...(source.lastModified !== undefined
              ? { lastModified: source.lastModified }
              : {}),
          };
      const cg = await this.d.conditionalGet.fetch(
        job.url,
        prev,
        this.ctx(this.d.env.LIGHT_HTTP_TIMEOUT_MS),
      );

      if (cg.status === 304) {
        await this.d.sourceRepo.updateFetchState(source.id, {
          staleAfter: new Date(Date.now() + policy.htmlTtlS * 1000),
        });
        await this.log(job, 2, "not_modified", t0, { httpStatus: 304 });
        return {
          job,
          gate: 2,
          method: "not_modified",
          outcome: "not_modified",
        };
      }

      if (cg.status === 200 && cg.bodyMd && !cg.looksDynamic) {
        // 静的で軽い → Gate2 で完結
        if (!isPressBody) {
          await this.d.sourceRepo.updateFetchState(source.id, {
            etag: cg.etag ?? null,
            lastModified: cg.lastModified ?? null,
            staleAfter: new Date(Date.now() + policy.htmlTtlS * 1000),
          });
        }
        return this.store(job, source, cg.bodyMd, "conditional_get", 2, 200, t0, {
          byteSize: cg.byteSize,
        });
      }

      // ---- Gate 3: Crawl4AI（JS レンダ/構造抽出）----
      const crawl = await this.d.crawlSemaphore(() =>
        this.d.crawl4ai.crawl(
          {
            url: job.url,
            render: job.renderHint ?? "auto",
            blockResources: ["image", "stylesheet", "font", "media"],
            timeoutMs: this.d.env.CRAWL_TIMEOUT_MS,
            respectRobots: true,
          },
          this.ctx(this.d.env.CRAWL_TIMEOUT_MS),
        ),
      );

      if (crawl.robotsBlocked) {
        await this.log(job, 3, "crawl4ai", t0, { robotsBlocked: true });
        return {
          job,
          gate: 3,
          method: "crawl4ai",
          outcome: "blocked",
          robotsBlocked: true,
        };
      }
      if (crawl.status === 200 && crawl.markdown) {
        if (!isPressBody) {
          await this.d.sourceRepo.updateFetchState(source.id, {
            staleAfter: new Date(Date.now() + policy.htmlTtlS * 1000),
          });
        }
        return this.store(
          job,
          source,
          crawl.markdown,
          "crawl4ai",
          3,
          200,
          t0,
          { byteSize: crawl.meta?.byteSize },
        );
      }

      // ---- Gate 4: マネージド API（opt-in の最終手段）----
      if (this.d.managedCrawl.enabled && job.allowManaged) {
        const m = await this.d.managedCrawl.crawl(
          job.url,
          this.ctx(this.d.env.CRAWL_TIMEOUT_MS),
        );
        await this.log(job, 4, "managed_api", t0, {
          costNote: `managed:${this.d.env.MANAGED_CRAWL_PROVIDER}`,
        });
        if (m.status === 200 && m.markdown) {
          return this.store(
            job,
            source,
            m.markdown,
            "managed_api",
            4,
            200,
            t0,
            { byteSize: m.meta?.byteSize },
          );
        }
      }

      await this.log(job, 4, "managed_api", t0, {});
      return this.errorResult(
        job,
        "managed_disabled",
        "anti-bot; managed API opt-in required",
        4,
      );
    } finally {
      release();
    }
  }

  // ===== 保存 + async embed =====
  private async store(
    job: FetchJob,
    source: Source,
    md: string,
    method: FetchMethod,
    gate: Gate,
    status: number,
    t0: number,
    extra: { byteSize?: number | undefined },
  ): Promise<FetchResult> {
    const hash = contentHash(md);
    const isPress = job.sourceType === "press_release";
    const base = {
      companyId: job.companyId,
      sourceId: source.id,
      sourceType: job.sourceType,
      url: job.url,
      canonicalUrl: job.canonicalUrl,
      contentMd: md,
      contentHash: hash,
      fetchMethod: method,
      httpStatus: status,
      ...(extra.byteSize !== undefined ? { byteSize: extra.byteSize } : {}),
      ...(job.press?.title !== undefined ? { title: job.press.title } : {}),
      ...(job.press?.guid !== undefined ? { guid: job.press.guid } : {}),
      ...(job.press?.publishedAt !== undefined
        ? { publishedAt: job.press.publishedAt }
        : {}),
    };

    // guid を持つプレスは guid で upsert、guid 無し(sitemap 由来)や HP は
    // (company, canonical_url, content_hash) の汎用 dedup upsert に流す。
    const usePressGuid = isPress && job.press?.guid !== undefined;
    const { id, inserted } = usePressGuid
      ? await this.d.scrapedRepo.upsertPress(base, true)
      : await this.d.scrapedRepo.upsert(base);

    await this.log(job, gate, method, t0, {
      httpStatus: status,
      bytes: Buffer.byteLength(md, "utf8"),
    });

    if (inserted) this.d.queue.enqueueEmbed(id);
    return {
      job,
      gate,
      method,
      outcome: inserted ? "stored" : "unchanged",
      contentId: id,
      httpStatus: status,
    };
  }

  private async storePressMeta(
    job: FetchJob,
    source: Source,
    e: FeedEntry,
  ): Promise<void> {
    const md = e.summaryMd ?? "";
    await this.d.scrapedRepo.upsertPress(
      {
        companyId: job.companyId,
        sourceId: source.id,
        sourceType: "press_release" satisfies SourceType,
        url: e.url,
        canonicalUrl: canonicalizeUrl(e.url),
        contentMd: md,
        contentHash: contentHash(md),
        fetchMethod: "rss",
        ...(e.title !== undefined ? { title: e.title } : {}),
        ...(e.guid !== undefined ? { guid: e.guid } : {}),
        ...(e.publishedAt !== undefined ? { publishedAt: e.publishedAt } : {}),
      },
      false,
    );
  }

  private childBodyJob(
    parent: FetchJob,
    source: Source,
    e: FeedEntry,
  ): FetchJob {
    const canonical = canonicalizeUrl(e.url);
    return {
      idempotencyKey: `${source.id}:${canonical}`,
      companyId: parent.companyId,
      sourceId: source.id,
      sourceType: "press_release",
      url: e.url,
      canonicalUrl: canonical,
      kind: source.kind,
      needBody: true,
      ...(parent.allowManaged !== undefined
        ? { allowManaged: parent.allowManaged }
        : {}),
      renderHint: "auto",
      press: {
        ...(e.guid !== undefined ? { guid: e.guid } : {}),
        ...(e.publishedAt !== undefined ? { publishedAt: e.publishedAt } : {}),
        ...(e.title !== undefined ? { title: e.title } : {}),
      },
    };
  }

  private ctx(timeoutMs: number): AdapterContext {
    return { userAgent: this.d.env.USER_AGENT, timeoutMs };
  }

  private async log(
    job: FetchJob,
    gate: Gate | null,
    method: FetchMethod,
    t0: number,
    extra: {
      httpStatus?: number;
      bytes?: number;
      cacheHit?: boolean;
      robotsBlocked?: boolean;
      costNote?: string;
    },
  ): Promise<void> {
    await this.d.fetchLogRepo.record({
      sourceId: job.sourceId,
      companyId: job.companyId,
      gate,
      method,
      durationMs: Date.now() - t0,
      ...extra,
    });
  }

  private errorResult(
    job: FetchJob,
    code: string,
    message: string,
    gate: Gate = 0,
  ): FetchResult {
    return {
      job,
      gate,
      method: "cache_hit",
      outcome: "error",
      error: { code, message },
    };
  }
}
