import { describe, expect, it, vi } from "vitest";
import type {
  Company,
  RawSignal,
  ScrapedContent,
  Source,
  SourceType,
} from "@sa/shared";
import { SIGNAL_CATALOG } from "@sa/shared";
import { FitOrchestrator } from "../src/fit/fit-orchestrator";

/** §F-3: 全依存モックで stage 遷移・失敗記録・1-5 上書きを確認する。 */

const company: Company = {
  id: "c-1",
  name: "example",
  domain: "example.co.jp",
  aliases: [],
};

function source(kind: Source["kind"], url: string): Source {
  return {
    id: `s-${kind}`,
    companyId: company.id,
    kind,
    url,
    canonicalUrl: url,
    robotsAllowed: true,
    enabled: true,
  };
}

function content(sourceType: SourceType, url: string): ScrapedContent {
  return {
    id: `sc-${url}`,
    companyId: company.id,
    sourceId: "s-x",
    sourceType,
    url,
    canonicalUrl: url,
    contentMd: `dummy content for ${url}`,
    contentHash: Buffer.alloc(32),
    fetchedAt: new Date("2026-07-05T00:00:00Z"),
    fetchMethod: "conditional_get",
  };
}

function rawSignals(): RawSignal[] {
  return SIGNAL_CATALOG.map((def) => ({
    signalId: def.id,
    detected: false,
    evidence: [],
    insufficientHistory: false,
  }));
}

function makeDeps() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fitRepo = {
    updateStage: vi.fn().mockResolvedValue(undefined),
    finishSuccess: vi.fn().mockResolvedValue(undefined),
    finishFailure: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    logger: logger as never,
    companyRepo: {
      findByDomain: vi.fn().mockResolvedValue(company),
      findByNameOrAlias: vi.fn(),
      upsertByDomain: vi.fn(),
    } as never,
    contentRepo: {
      latestByCompany: vi.fn(
        async (_id: string, types: SourceType[]): Promise<ScrapedContent[]> => {
          const t = types[0];
          if (t === "job_posting")
            return [content("job_posting", "https://media.example.com/job/1")];
          if (t === "press_release")
            return [content("press_release", "https://example.co.jp/news/1")];
          if (t === "corporate_hp")
            return [content("corporate_hp", "https://example.co.jp/")];
          return [];
        },
      ),
    } as never,
    fitRepo: fitRepo as never,
    queue: {
      enqueueFetch: vi
        .fn()
        .mockResolvedValue({ gate: 2, method: "conditional_get", outcome: "stored" }),
    } as never,
    enumerator: {
      ensureSources: vi
        .fn()
        .mockResolvedValue([
          source("corporate_hp", "https://example.co.jp/"),
          source("press_feed", "https://example.co.jp/news-sitemap.xml"),
        ]),
    } as never,
    careersProbe: {
      probe: vi.fn().mockResolvedValue({
        checkedUrls: ["https://example.co.jp/recruit (robots-blocked)", "https://example.co.jp/careers"],
        foundUrl: null,
      }),
    },
    extractor: {
      extract: vi.fn().mockResolvedValue({
        signals: rawSignals(),
        usage: { inputTokens: 100, outputTokens: 50 },
        droppedSnippetUrls: [],
      }),
    },
    model: "claude-opus-4-8",
  };
  return { deps, fitRepo, logger };
}

const input = { companyNameOrUrl: "https://example.co.jp" };

describe("FitOrchestrator.run（詳細設計 §C-6）", () => {
  it("正常系: stage が collect→extract→judge と更新され finishSuccess で完了する", async () => {
    const { deps, fitRepo } = makeDeps();
    await new FitOrchestrator(deps as never).run("a-1", input);

    expect(fitRepo.updateStage.mock.calls.map((c) => c[1])).toEqual([
      "extract",
      "judge",
    ]);
    expect(fitRepo.finishSuccess).toHaveBeenCalledTimes(1);
    expect(fitRepo.finishFailure).not.toHaveBeenCalled();
    const [, result] = fitRepo.finishSuccess.mock.calls[0]!;
    expect(result.cost).toMatchObject({
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("extract で throw しても run は throw せず、stage=extract で finishFailure を記録する", async () => {
    const { deps, fitRepo } = makeDeps();
    deps.extractor.extract = vi.fn().mockRejectedValue(new Error("api down"));

    await expect(
      new FitOrchestrator(deps as never).run("a-2", input),
    ).resolves.toBeUndefined();

    expect(fitRepo.finishFailure).toHaveBeenCalledWith("a-2", "extract", "api down");
    expect(fitRepo.finishSuccess).not.toHaveBeenCalled();
  });

  it("1-5 プローブ上書き: 採用ページ不在なら 1-5 が counter として detected になり判定は low", async () => {
    const { deps, fitRepo } = makeDeps();
    await new FitOrchestrator(deps as never).run("a-3", input);

    const [, result] = fitRepo.finishSuccess.mock.calls[0]!;
    const s15 = result.signals.find(
      (s: { id: string }) => s.id === "1-5",
    );
    expect(s15.detected).toBe(true);
    expect(s15.strength).toBe("counter");
    expect(s15.evidence[0]).toMatchObject({
      source: "careers_probe",
      url: "https://example.co.jp/recruit", // 注記 "(robots-blocked)" は剥がされる
    });
    // 収集最低要件は満たしている（careers 確認済み + job 1 + press 1）ので unknown ではなく low
    expect(result.needLevel).toBe("low");
    expect(result.rationale).toContain("リファラル採用疑い");
    expect(result.careersCheck.foundUrl).toBeNull();
  });

  it("careers ソースが seed 済みならプローブしない（§C-4-1 手順 5）", async () => {
    const { deps, fitRepo } = makeDeps();
    (deps.enumerator as { ensureSources: ReturnType<typeof vi.fn> }).ensureSources =
      vi
        .fn()
        .mockResolvedValue([
          source("corporate_hp", "https://example.co.jp/"),
          source("careers", "https://example.co.jp/recruit"),
        ]);

    await new FitOrchestrator(deps as never).run("a-4", {
      ...input,
      seedUrls: [{ kind: "careers" as const, url: "https://example.co.jp/recruit" }],
    });

    expect(deps.careersProbe.probe).not.toHaveBeenCalled();
    const [, result] = fitRepo.finishSuccess.mock.calls[0]!;
    expect(result.careersCheck).toEqual({
      checkedUrls: ["https://example.co.jp/recruit"],
      foundUrl: "https://example.co.jp/recruit",
    });
  });

  it("manualInputs の求人シグナルは jobsInfoCount に数える（§6-3-2 自動 or 手動）", async () => {
    const { deps, fitRepo } = makeDeps();
    // job_posting 収集ゼロにする
    (deps.contentRepo as { latestByCompany: ReturnType<typeof vi.fn> }).latestByCompany =
      vi.fn(async (_id: string, types: SourceType[]) =>
        types[0] === "press_release"
          ? [content("press_release", "https://example.co.jp/news/1")]
          : types[0] === "corporate_hp"
            ? [content("corporate_hp", "https://example.co.jp/")]
            : [],
      );
    deps.careersProbe.probe = vi.fn().mockResolvedValue({
      checkedUrls: ["https://example.co.jp/careers"],
      foundUrl: "https://example.co.jp/careers",
    });

    await new FitOrchestrator(deps as never).run("a-5", {
      ...input,
      manualInputs: [
        {
          signalId: "1-1" as const,
          url: "https://www.wantedly.com/companies/x",
          quoteSummary: "8 ヶ月掲載を確認",
          checkedAt: "2026-07-05",
        },
      ],
    });

    const [, result] = fitRepo.finishSuccess.mock.calls[0]!;
    // 手動入力が jobsInfo に数えられ unknown にならない。1-1 検出 + 逆指標なし → high
    expect(result.needLevel).toBe("high");
  });
});
