import type { CareersCheck } from "@sa/shared";
import type {
  ConditionalGetAdapter,
  ConditionalGetResult,
} from "../adapters/source-adapter";
import type { RateLimiter } from "../compliance/rate-limiter";
import type { RobotsGuard } from "../compliance/robots";
import { canonicalizeUrl, domainOf } from "../compliance/url-canonical";

/**
 * 採用ページの自動プローブ（詳細設計 §C-4-1）。
 * 結果は成否問わず checkedUrls に全記録する — 「確認したが無かった」がシグナル 1-5 の根拠になる。
 * 見つけた URL の sources 登録・本文保存は orchestrator の責務（§C-6。本クラスは発見のみ）。
 * seedUrls(kind=careers) がある場合は orchestrator がプローブ自体をスキップする（§C-4-1 手順 5）。
 */

/** 既定プローブパス（§C-4-1 手順 2 の順序そのまま）。 */
export const CAREERS_PROBE_PATHS = [
  "/recruit",
  "/recruit/",
  "/careers",
  "/careers/",
  "/recruitment",
  "/jobs",
  "/saiyo",
] as const;

/** HP 内リンクの採用ページ候補判定（URL パスまたはアンカーテキスト — §C-4-1 手順 1）。 */
const CAREERS_LINK_PATTERN = /採用|recruit|career|jobs|saiyo|entry/i;

/** HP リンク候補の上限（過剰クロール防止。超過分は既定パス同様プローブしない）。 */
const MAX_LINK_CANDIDATES = 5;

export interface CareersProbeDeps {
  conditionalGet: ConditionalGetAdapter;
  robots: Pick<RobotsGuard, "isAllowed">;
  rateLimiter: Pick<RateLimiter, "acquire">;
  userAgent: string;
  timeoutMs: number;
}

export class CareersProbe {
  constructor(private readonly deps: CareersProbeDeps) {}

  async probe(
    domain: string,
    hpMarkdown: string | null,
  ): Promise<CareersCheck> {
    const base = `https://${domain}`;
    // 手順 1: HP の Markdown からリンク候補を抽出（ネットワークコスト 0）
    const candidates = hpMarkdown
      ? extractCareerLinks(base, domain, hpMarkdown)
      : [];
    // 手順 2: 候補が無ければ既定パス（候補があれば既定パスは打たない）
    const targets =
      candidates.length > 0
        ? candidates
        : CAREERS_PROBE_PATHS.map((p) => `${base}${p}`);

    const checkedUrls: string[] = [];
    for (const url of targets) {
      const decision = await this.deps.robots.isAllowed(url);
      if (!decision.allowed) {
        checkedUrls.push(`${url} (robots-blocked)`);
        continue;
      }

      const release = await this.deps.rateLimiter.acquire(
        url,
        decision.crawlDelayMs,
      );
      let result: ConditionalGetResult | undefined;
      try {
        result = await this.deps.conditionalGet.fetch(
          url,
          {},
          { userAgent: this.deps.userAgent, timeoutMs: this.deps.timeoutMs },
        );
      } catch {
        // ネットワークエラーも「確認した」として記録して次の候補へ
      } finally {
        release();
      }

      checkedUrls.push(url);
      // 手順 3: 200 かつ本文が取れた最初の URL を採用ページとする
      if (result?.status === 200 && result.bodyMd) {
        return { checkedUrls, foundUrl: url };
      }
    }

    // 手順 4: 全滅 — checkedUrls が「確認したが無かった」の根拠になる
    return { checkedUrls, foundUrl: null };
  }
}

function extractCareerLinks(
  base: string,
  domain: string,
  markdown: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of markdown.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const text = m[1] ?? "";
    const href = m[2] ?? "";

    let resolved: string;
    try {
      resolved = new URL(href, base).toString();
    } catch {
      continue;
    }
    try {
      if (domainOf(resolved) !== domain) continue; // 同一ドメインのみ
    } catch {
      continue;
    }
    const path = new URL(resolved).pathname;
    if (!CAREERS_LINK_PATTERN.test(text) && !CAREERS_LINK_PATTERN.test(path)) {
      continue;
    }

    let canonical: string;
    try {
      canonical = canonicalizeUrl(resolved);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    out.push(resolved);
    if (out.length >= MAX_LINK_CANDIDATES) break;
  }
  return out;
}
