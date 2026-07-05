import { describe, expect, it, vi } from "vitest";
import {
  CAREERS_PROBE_PATHS,
  CareersProbe,
  type CareersProbeDeps,
} from "../src/fit/careers-probe";

function makeDeps(overrides: Partial<CareersProbeDeps> = {}) {
  const release = vi.fn();
  const deps = {
    conditionalGet: { fetch: vi.fn().mockResolvedValue({ status: 404 }) },
    robots: {
      isAllowed: vi.fn().mockResolvedValue({ allowed: true, crawlDelayMs: 0 }),
    },
    rateLimiter: { acquire: vi.fn().mockResolvedValue(release) },
    userAgent: "TestBot/0.1",
    timeoutMs: 1_000,
    ...overrides,
  } satisfies CareersProbeDeps & Record<string, unknown>;
  return { deps, release };
}

const ok = { status: 200, bodyMd: "# 採用情報\nエンジニア募集" };

describe("CareersProbe（詳細設計 §C-4-1）", () => {
  it("手順 1: HP リンクに採用候補があれば既定パスを打たない", async () => {
    const { deps } = makeDeps();
    deps.conditionalGet.fetch.mockResolvedValueOnce(ok);
    const hpMd = "[会社概要](/about) [採用情報](/recruit-info) [外部](https://other.jp/jobs)";

    const result = await new CareersProbe(deps).probe("example.co.jp", hpMd);

    expect(result.foundUrl).toBe("https://example.co.jp/recruit-info");
    // 同一ドメインの採用候補 1 件のみ（/about は不一致、other.jp は別ドメイン）
    expect(deps.conditionalGet.fetch).toHaveBeenCalledTimes(1);
    expect(deps.conditionalGet.fetch.mock.calls[0]![0]).toBe(
      "https://example.co.jp/recruit-info",
    );
  });

  it("手順 2: HP リンク候補なしなら既定パスを定義順にプローブし、最初の 200 で止まる", async () => {
    const { deps } = makeDeps();
    deps.conditionalGet.fetch
      .mockResolvedValueOnce({ status: 404 }) // /recruit
      .mockResolvedValueOnce({ status: 404 }) // /recruit/
      .mockResolvedValueOnce(ok); // /careers

    const result = await new CareersProbe(deps).probe("example.co.jp", null);

    expect(result.foundUrl).toBe("https://example.co.jp/careers");
    expect(deps.conditionalGet.fetch).toHaveBeenCalledTimes(3);
    expect(
      deps.conditionalGet.fetch.mock.calls.map((c: unknown[]) => c[0]),
    ).toEqual([
      "https://example.co.jp/recruit",
      "https://example.co.jp/recruit/",
      "https://example.co.jp/careers",
    ]);
    expect(result.checkedUrls).toHaveLength(3);
  });

  it("手順 2: robots ブロックのパスはフェッチせず checkedUrls に注記付きで記録", async () => {
    const { deps } = makeDeps();
    deps.robots.isAllowed
      .mockResolvedValueOnce({ allowed: false }) // /recruit
      .mockResolvedValue({ allowed: true, crawlDelayMs: 0 });
    deps.conditionalGet.fetch.mockResolvedValueOnce(ok); // /recruit/

    const result = await new CareersProbe(deps).probe("example.co.jp", null);

    expect(result.checkedUrls[0]).toBe(
      "https://example.co.jp/recruit (robots-blocked)",
    );
    expect(result.foundUrl).toBe("https://example.co.jp/recruit/");
    // ブロックされたパスへはフェッチしていない
    expect(
      deps.conditionalGet.fetch.mock.calls.map((c: unknown[]) => c[0]),
    ).not.toContain("https://example.co.jp/recruit");
  });

  it("手順 4: 全滅なら foundUrl=null・checkedUrls に全パス記録（1-5 の根拠）", async () => {
    const { deps, release } = makeDeps();

    const result = await new CareersProbe(deps).probe("example.co.jp", null);

    expect(result.foundUrl).toBeNull();
    expect(result.checkedUrls).toHaveLength(CAREERS_PROBE_PATHS.length);
    expect(release).toHaveBeenCalledTimes(CAREERS_PROBE_PATHS.length); // レートリミッタ解放漏れなし
  });

  it("ネットワークエラーも「確認した」として記録し次の候補へ進む", async () => {
    const { deps } = makeDeps();
    deps.conditionalGet.fetch
      .mockRejectedValueOnce(new Error("timeout")) // /recruit
      .mockResolvedValueOnce(ok); // /recruit/

    const result = await new CareersProbe(deps).probe("example.co.jp", null);

    expect(result.checkedUrls).toContain("https://example.co.jp/recruit");
    expect(result.foundUrl).toBe("https://example.co.jp/recruit/");
  });
});
