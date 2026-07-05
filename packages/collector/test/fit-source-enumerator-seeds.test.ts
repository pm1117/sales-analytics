import { describe, expect, it, vi } from "vitest";
import type { Company, Env, Source } from "@sa/shared";
import { SourceEnumerator } from "../src/orchestrator/source-enumerator";

/** SourceEnumerator の seedUrls 対応（詳細設計 §B-1。既存動作は seed なしで不変）。 */

const company: Company = {
  id: "c-1",
  name: "example",
  domain: "example.co.jp",
  aliases: [],
};

const hpSource: Source = {
  id: "s-1",
  companyId: "c-1",
  kind: "corporate_hp",
  url: "https://example.co.jp/",
  canonicalUrl: "https://example.co.jp/",
  robotsAllowed: true,
  enabled: true,
};

function makeEnumerator(existing: Source[]) {
  const insert = vi.fn(async (input: Record<string, unknown>) => ({
    ...hpSource,
    id: `s-${Math.floor(insert.mock.calls.length + 1)}`,
    kind: input["kind"],
    url: input["url"],
    canonicalUrl: input["canonicalUrl"],
  }));
  const sourceRepo = {
    listByCompany: vi.fn().mockResolvedValue(existing),
    insert,
  };
  const robots = {
    isAllowed: vi.fn().mockResolvedValue({ allowed: true, crawlDelayMs: 2000 }),
  };
  const enumerator = new SourceEnumerator(
    { USER_AGENT: "TestBot/0.1", LIGHT_HTTP_TIMEOUT_MS: 1 } as unknown as Env,
    sourceRepo as never,
    robots as never,
  );
  return { enumerator, insert };
}

describe("SourceEnumerator.ensureSources + seedUrls", () => {
  it("既存ソースがあっても seed（careers / jobs_media）を追加登録する", async () => {
    const { enumerator, insert } = makeEnumerator([hpSource]);

    const sources = await enumerator.ensureSources(company, [
      { kind: "careers", url: "https://example.co.jp/recruit" },
      { kind: "jobs_media", url: "https://www.green-japan.com/company/x" },
    ]);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls.map((c) => c[0])).toMatchObject([
      { kind: "careers", url: "https://example.co.jp/recruit" },
      { kind: "jobs_media", url: "https://www.green-japan.com/company/x" },
    ]);
    expect(sources).toHaveLength(3);
  });

  it("既存 canonical と重複する seed は登録しない（正規化差も同一視）", async () => {
    const { enumerator, insert } = makeEnumerator([hpSource]);

    const sources = await enumerator.ensureSources(company, [
      { kind: "careers", url: "http://www.example.co.jp/?utm_source=x" }, // 正規化すると既存 HP と同一
    ]);

    expect(insert).not.toHaveBeenCalled();
    expect(sources).toHaveLength(1);
  });

  it("seed なし・既存ありは従来どおり既存をそのまま返す（bootstrap しない）", async () => {
    const { enumerator, insert } = makeEnumerator([hpSource]);
    const sources = await enumerator.ensureSources(company);
    expect(sources).toEqual([hpSource]);
    expect(insert).not.toHaveBeenCalled();
  });
});
