import type {
  Company,
  Env,
  FetchJob,
  Logger,
  Source,
  SourceType,
} from "@sa/shared";
import { canonicalizeUrl, domainOf } from "../compliance/url-canonical";
import type { CompanyRepo } from "../storage/repositories/company-repo";
import type { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import type { Queue } from "../queue/queue";
import type { SourceEnumerator } from "./source-enumerator";
import type { DossierGenerator, Dossier } from "../claude/dossier-generator";
import type { ContextSnippet } from "../claude/prompt";

export interface DossierRequest {
  companyNameOrUrl: string;
  allowManaged?: boolean;
  selfProduct?: string;
}

/** company 未確定（名前入力でドメインが解決できない）。ルート側で 409 にする。 */
export class DomainRequiredError extends Error {
  readonly companyName: string;
  constructor(companyName: string) {
    super(`domain required for company "${companyName}"`);
    this.name = "DomainRequiredError";
    this.companyName = companyName;
  }
}

function kindToSourceType(kind: Source["kind"]): SourceType {
  return kind === "press_feed" || kind === "news_feed"
    ? "press_release"
    : "corporate_hp";
}

/** カルテ要求の end-to-end 統括（詳細設計 §6）。 */
export class DossierOrchestrator {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly companyRepo: CompanyRepo,
    private readonly scrapedRepo: ScrapedContentRepo,
    private readonly enumerator: SourceEnumerator,
    private readonly queue: Queue,
    private readonly generator: DossierGenerator,
  ) {}

  async run(req: DossierRequest): Promise<Dossier> {
    const company = await this.resolveCompany(req.companyNameOrUrl);
    const sources = await this.enumerator.ensureSources(company);

    // 各ソースを取得（部分失敗を許容）
    const jobs = sources.map((s) => this.sourceToJob(company, s, req.allowManaged));
    const results = await Promise.allSettled(
      jobs.map((j) => this.queue.enqueueFetch(j)),
    );

    const gaps: string[] = [];
    results.forEach((r, i) => {
      const src = sources[i];
      if (!src) return;
      if (r.status === "rejected") {
        gaps.push(`${src.kind} (${src.url}): 取得失敗`);
      } else if (r.value.outcome === "blocked") {
        gaps.push(`${src.kind} (${src.url}): robots により未取得`);
      } else if (r.value.outcome === "error") {
        gaps.push(`${src.kind} (${src.url}): ${r.value.error?.code ?? "error"}`);
      }
    });

    const snippets = await this.buildContext(company);
    if (snippets.length === 0) {
      throw new Error("no content collected for company");
    }

    const dossier = await this.generator.generate({
      company,
      snippets,
      ...(req.selfProduct !== undefined ? { selfProduct: req.selfProduct } : {}),
      gaps,
    });
    this.logger.info(
      { company: company.domain, snippets: snippets.length, gaps: gaps.length },
      "dossier generated",
    );
    return dossier;
  }

  private async resolveCompany(input: string): Promise<Company> {
    const looksUrl = /^https?:\/\//i.test(input) || input.includes(".");
    if (looksUrl) {
      const url = input.startsWith("http") ? input : `https://${input}`;
      const domain = domainOf(url);
      const existing = await this.companyRepo.findByDomain(domain);
      if (existing) return existing;
      return this.companyRepo.upsertByDomain({ name: domain, domain });
    }
    const byName = await this.companyRepo.findByNameOrAlias(input);
    if (byName) return byName;
    // 誤ドメインは全収集を汚染するため自動推測しない
    throw new DomainRequiredError(input);
  }

  private sourceToJob(
    company: Company,
    source: Source,
    allowManaged?: boolean,
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
      ...(allowManaged !== undefined ? { allowManaged } : {}),
      renderHint: "auto",
    };
  }

  /** 収集済みの生 Markdown からコンテキスト抜粋を組み立てる（トークン予算内に収める）。 */
  private async buildContext(company: Company): Promise<ContextSnippet[]> {
    const hp = await this.scrapedRepo.latestByCompany(
      company.id,
      ["corporate_hp"],
      3,
    );
    const press = await this.scrapedRepo.latestByCompany(
      company.id,
      ["press_release"],
      5,
    );

    const budgetChars = this.env.DOSSIER_MAX_CONTEXT_TOKENS * 3;
    const snippets: ContextSnippet[] = [];
    let used = 0;
    for (const c of [...hp, ...press]) {
      if (c.contentMd.trim().length === 0) continue;
      const text = c.contentMd.slice(0, 8000);
      if (used + text.length > budgetChars) break;
      used += text.length;
      snippets.push({ sourceUrl: c.canonicalUrl, text });
    }
    return snippets;
  }
}

/** URL 入力を canonical 化するユーティリティ（ルート層から再利用）。 */
export function canonicalInput(input: string): string {
  return canonicalizeUrl(input.startsWith("http") ? input : `https://${input}`);
}
