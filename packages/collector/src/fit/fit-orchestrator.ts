import type {
  AssessmentInput,
  AssessmentStage,
  CareersCheck,
  Company,
  FetchJob,
  Logger,
  ScrapedContent,
  SeedUrl,
  SignalResult,
  Source,
  SourceKind,
  SourceType,
} from "@sa/shared";
import { PROMPT_VERSION } from "./fit-prompt";
import { domainOf } from "../compliance/url-canonical";
import type { Queue } from "../queue/queue";
import { DomainRequiredError } from "../orchestrator/dossier-orchestrator";
import type { SourceEnumerator } from "../orchestrator/source-enumerator";
import type { CompanyRepo } from "../storage/repositories/company-repo";
import type { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import type { FitAssessmentRepo } from "../storage/repositories/fit-assessment-repo";
import type { CareersProbe } from "./careers-probe";
import { filterEvidence } from "./evidence-filter";
import { mergeManualInputs } from "./merge-manual";
import { judge, type JudgeInput, type JudgeResult } from "./need-judge";
import type {
  ContentSnippet,
  ExtractionInput,
  ExtractionResult,
} from "./signal-extractor";

/**
 * Fit 判定パイプライン制御（詳細設計 §C-6）: collect → extract → judge → persist。
 * run() は throw しない（全例外を catch して fit_assessments へ failed 記録 — 呼び出し側は
 * fire-and-forget できる）。進捗は stage カラムの更新で表す。
 */

/** kind → scraped_contents.source_type（0002_fit.sql の拡張 enum を含む）。 */
export function kindToSourceType(kind: SourceKind): SourceType {
  switch (kind) {
    case "press_feed":
    case "news_feed":
      return "press_release";
    case "careers":
      return "careers_page";
    case "jobs_media":
      return "job_posting";
    default:
      return "corporate_hp";
  }
}

/** scraped_contents.source_type → プロンプト表示用の SourceKind。 */
export function sourceTypeToKind(sourceType: SourceType): SourceKind {
  switch (sourceType) {
    case "press_release":
      return "press_feed";
    case "careers_page":
      return "careers";
    case "job_posting":
      return "jobs_media";
    default:
      return "corporate_hp";
  }
}

/** checkedUrls の注記（"(robots-blocked)" 等）を落として素の URL にする。 */
export function stripAnnotation(checked: string): string {
  return checked.replace(/\s+\(.*\)$/, "");
}

/**
 * §C-5 手順 2: プローブで採用ページが見つからなかった場合、1-5（逆指標）をコード側で
 * detected に上書きする（LLM は「採用ページ不在」を判定できないため）。純関数。
 */
export function overrideCareersSignal(
  signals: SignalResult[],
  careersCheck: CareersCheck,
  today: string,
): SignalResult[] {
  if (careersCheck.foundUrl !== null) return signals;
  if (careersCheck.checkedUrls.length === 0) return signals;
  const firstChecked = stripAnnotation(careersCheck.checkedUrls[0]!);
  return signals.map((s) =>
    s.id === "1-5"
      ? {
          ...s,
          detected: true,
          evidence: [
            ...s.evidence,
            {
              url: firstChecked,
              quoteSummary: `採用ページを確認したが見つからなかった（確認 ${careersCheck.checkedUrls.length} URL — careersCheck 参照）`,
              checkedAt: today,
              source: "careers_probe" as const,
            },
          ],
        }
      : s,
  );
}

export interface SignalExtractorLike {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export interface FitOrchestratorDeps {
  logger: Logger;
  companyRepo: CompanyRepo;
  contentRepo: ScrapedContentRepo;
  fitRepo: FitAssessmentRepo;
  queue: Queue;
  enumerator: SourceEnumerator;
  careersProbe: Pick<CareersProbe, "probe">;
  extractor: SignalExtractorLike;
  /** テスト差し替え用に注入（既定は need-judge の judge）。 */
  judge?: (input: JudgeInput) => JudgeResult;
  /** cost 記録用（extractor に渡したモデル名と同じものを渡す）。 */
  model: string;
}

export class FitOrchestrator {
  private readonly judge: (input: JudgeInput) => JudgeResult;

  constructor(private readonly deps: FitOrchestratorDeps) {
    this.judge = deps.judge ?? judge;
  }

  /** 企業解決（既存 /dossiers と同じ規則 — ドメイン自動推測はしない）。route / CLI から使う。 */
  async resolveCompany(companyNameOrUrl: string): Promise<Company> {
    const input = companyNameOrUrl;
    const looksUrl = /^https?:\/\//i.test(input) || input.includes(".");
    if (looksUrl) {
      const url = input.startsWith("http") ? input : `https://${input}`;
      const domain = domainOf(url);
      const existing = await this.deps.companyRepo.findByDomain(domain);
      if (existing) return existing;
      return this.deps.companyRepo.upsertByDomain({ name: domain, domain });
    }
    const byName = await this.deps.companyRepo.findByNameOrAlias(input);
    if (byName) return byName;
    throw new DomainRequiredError(input);
  }

  /** §C-6 のフロー。throw しない。 */
  async run(assessmentId: string, input: AssessmentInput): Promise<void> {
    const t0 = Date.now();
    let stage: AssessmentStage = "collect";
    try {
      const company = await this.resolveCompany(input.companyNameOrUrl);

      // ---- collect（F1）----
      let sources = await this.deps.enumerator.ensureSources(
        company,
        input.seedUrls ?? [],
      );
      const careersCheck = await this.ensureCareers(company, sources);
      if (
        careersCheck.foundUrl &&
        !sources.some((s) => s.kind === "careers")
      ) {
        // §C-4-1 手順 3 の登録（orchestrator の責務）: 発見した採用ページを sources へ
        const seed: SeedUrl = { kind: "careers", url: careersCheck.foundUrl };
        sources = await this.deps.enumerator.ensureSources(company, [seed]);
      }

      const results = await Promise.allSettled(
        sources.map((s) =>
          this.deps.queue.enqueueFetch(this.sourceToJob(company, s, input)),
        ),
      );
      // silent skip 禁止（F1）: 失敗ソースをログに残す
      results.forEach((r, i) => {
        const src = sources[i];
        if (!src) return;
        if (r.status === "rejected") {
          this.deps.logger.warn(
            { source: src.url, reason: String(r.reason) },
            "fit collect: source fetch failed",
          );
        } else if (r.value.outcome === "blocked" || r.value.outcome === "error") {
          this.deps.logger.warn(
            { source: src.url, outcome: r.value.outcome },
            "fit collect: source not stored",
          );
        }
      });

      // ---- extract（F2）----
      stage = "extract";
      await this.deps.fitRepo.updateStage(assessmentId, "extract");

      const { snippets, jobsInfoCount, prNewsCount } =
        await this.buildSnippets(company);
      const today = new Date().toISOString().slice(0, 10);
      const allowedUrls = [
        ...snippets.map((s) => s.url),
        ...careersCheck.checkedUrls.map(stripAnnotation),
      ];

      const extraction = await this.deps.extractor.extract({
        company: { name: company.name, domain: company.domain },
        snippets,
        allowedUrls,
        today,
      });
      if (extraction.droppedSnippetUrls.length > 0) {
        this.deps.logger.warn(
          { dropped: extraction.droppedSnippetUrls },
          "fit extract: snippets dropped by token budget",
        );
      }

      // ---- judge（F3）----
      stage = "judge";
      await this.deps.fitRepo.updateStage(assessmentId, "judge");

      const filtered = filterEvidence(
        extraction.signals,
        new Set(allowedUrls),
        today,
      );
      if (filtered.droppedCount > 0) {
        // 頻発するならプロンプト改訂のシグナル（基本設計 §9 リスク 6）
        this.deps.logger.warn(
          { droppedEvidence: filtered.droppedCount },
          "fit extract: evidence dropped by URL guard",
        );
      }
      const withProbe = overrideCareersSignal(
        filtered.signals,
        careersCheck,
        today,
      );
      const signals = mergeManualInputs(withProbe, input.manualInputs ?? []);

      const manualJobsCount = (input.manualInputs ?? []).filter((m) =>
        m.signalId.startsWith("1-"),
      ).length;
      const result = this.judge({
        signals,
        collection: {
          careersChecked: careersCheck.checkedUrls.length > 0,
          jobsInfoCount: jobsInfoCount + manualJobsCount,
          prNewsCount,
        },
      });

      // ---- persist ----
      await this.deps.fitRepo.finishSuccess(assessmentId, {
        needLevel: result.needLevel,
        signals,
        missingData: result.missingData,
        careersCheck,
        rationale: result.rationale,
        cost: {
          model: this.deps.model,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
          durationMs: Date.now() - t0,
        },
      });
      this.deps.logger.info(
        { assessmentId, needLevel: result.needLevel },
        "fit assessment succeeded",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ assessmentId, stage, err }, "fit assessment failed");
      await this.deps.fitRepo
        .finishFailure(assessmentId, stage, message)
        .catch((e: unknown) =>
          this.deps.logger.error({ assessmentId, e }, "failed to record failure"),
        );
    }
  }

  /** careers ソースが無ければプローブ。seed / 既存があればスキップ（§C-4-1 手順 5）。 */
  private async ensureCareers(
    company: Company,
    sources: Source[],
  ): Promise<CareersCheck> {
    const existing = sources.filter((s) => s.kind === "careers");
    if (existing.length > 0) {
      return {
        checkedUrls: existing.map((s) => s.url),
        foundUrl: existing[0]!.url,
      };
    }
    const hp = await this.deps.contentRepo.latestByCompany(
      company.id,
      ["corporate_hp"],
      1,
    );
    return this.deps.careersProbe.probe(
      company.domain,
      hp[0]?.contentMd ?? null,
    );
  }

  /** §C-2 の組み立て順: careers 全件 → jobs_media 全件 → press 最新 5 → hp 最新 1。 */
  private async buildSnippets(company: Company): Promise<{
    snippets: ContentSnippet[];
    jobsInfoCount: number;
    prNewsCount: number;
  }> {
    const careers = await this.deps.contentRepo.latestByCompany(
      company.id,
      ["careers_page"],
      10,
    );
    const jobs = await this.deps.contentRepo.latestByCompany(
      company.id,
      ["job_posting"],
      10,
    );
    const press = await this.deps.contentRepo.latestByCompany(
      company.id,
      ["press_release"],
      5,
    );
    const hp = await this.deps.contentRepo.latestByCompany(
      company.id,
      ["corporate_hp"],
      1,
    );
    const toSnippet = (c: ScrapedContent): ContentSnippet => ({
      url: c.canonicalUrl,
      sourceKind: sourceTypeToKind(c.sourceType),
      fetchedAt: c.fetchedAt.toISOString(),
      markdown: c.contentMd,
    });
    return {
      snippets: [...careers, ...jobs, ...press, ...hp].map(toSnippet),
      jobsInfoCount: jobs.length,
      prNewsCount: press.length,
    };
  }

  private sourceToJob(
    company: Company,
    source: Source,
    input: AssessmentInput,
  ): FetchJob {
    return {
      idempotencyKey: `${source.id}:${source.canonicalUrl}`,
      companyId: company.id,
      sourceId: source.id,
      sourceType: kindToSourceType(source.kind),
      url: source.url,
      canonicalUrl: source.canonicalUrl,
      kind: source.kind,
      needBody: true,
      ...(input.allowManaged !== undefined
        ? { allowManaged: input.allowManaged }
        : {}),
      renderHint: "auto",
    };
  }
}

export { PROMPT_VERSION };
