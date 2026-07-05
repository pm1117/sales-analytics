import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { FitAssessment } from "@sa/shared";
import { DomainRequiredError } from "../src/orchestrator/dossier-orchestrator";
import {
  registerAssessmentRoutes,
  type AssessmentRouteDeps,
} from "../src/server/routes/assessment";

/** §F-3: fastify inject + FitOrchestrator/リポジトリのスタブで API 契約（§A-4）を固定する。 */

const company = { id: "c-1", name: "example", domain: "example.co.jp" };

function assessment(overrides: Partial<FitAssessment> = {}): FitAssessment {
  return {
    id: "a-1",
    status: "running",
    stage: "collect",
    company,
    input: { companyNameOrUrl: "https://example.co.jp" },
    signalsVersion: "v0.2",
    promptVersion: "v1",
    judgedAt: null,
    needLevel: null,
    signals: [],
    counterSignals: [],
    missingData: [],
    careersCheck: null,
    rationale: null,
    humanReview: null,
    cost: null,
    error: null,
    createdAt: "2026-07-05T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeApp(depOverrides: {
  orchestrator?: Partial<AssessmentRouteDeps["orchestrator"]>;
  fitRepo?: Partial<AssessmentRouteDeps["fitRepo"]>;
} = {}) {
  const orchestrator = {
    resolveCompany: vi.fn().mockResolvedValue(company),
    run: vi.fn().mockResolvedValue(undefined),
    ...depOverrides.orchestrator,
  };
  const fitRepo = {
    insert: vi.fn().mockResolvedValue("a-1"),
    get: vi.fn().mockResolvedValue(assessment()),
    list: vi.fn().mockResolvedValue([]),
    setHumanReview: vi.fn().mockResolvedValue(undefined),
    hasRunning: vi.fn().mockResolvedValue(false),
    ...depOverrides.fitRepo,
  };
  const app = Fastify();
  registerAssessmentRoutes(app, {
    orchestrator: orchestrator as never,
    fitRepo: fitRepo as never,
  });
  return { app, orchestrator, fitRepo };
}

describe("POST /assessments", () => {
  it("202 + assessmentId を即返し、run は fire-and-forget", async () => {
    const { app, orchestrator, fitRepo } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/assessments",
      payload: { companyNameOrUrl: "https://example.co.jp" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ assessmentId: "a-1", status: "running" });
    expect(fitRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c-1",
        signalsVersion: "v0.2",
        promptVersion: "v1",
      }),
    );
    expect(orchestrator.run).toHaveBeenCalledWith("a-1", {
      companyNameOrUrl: "https://example.co.jp",
    });
  });

  it("zod 失敗は 400 invalid_request", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/assessments",
      payload: { companyNameOrUrl: "", seedUrls: [{ kind: "bad", url: "x" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("ドメイン解決不可は 409 domain_required（既存 /dossiers と同形）", async () => {
    const { app } = makeApp({
      orchestrator: {
        resolveCompany: vi.fn().mockRejectedValue(new DomainRequiredError("社名")),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/assessments",
      payload: { companyNameOrUrl: "社名" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "domain_required", companyName: "社名" });
  });

  it("同一企業の running があれば 409 already_running（insert しない）", async () => {
    const { app, fitRepo } = makeApp({
      fitRepo: { hasRunning: vi.fn().mockResolvedValue(true) },
    });
    const res = await app.inject({
      method: "POST",
      url: "/assessments",
      payload: { companyNameOrUrl: "https://example.co.jp" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_running");
    expect(fitRepo.insert).not.toHaveBeenCalled();
  });
});

describe("GET /assessments/:id（ポーリング）", () => {
  it("running → succeeded の遷移をそのまま返す。failed も 200", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(assessment())
      .mockResolvedValueOnce(
        assessment({ status: "succeeded", stage: "done", needLevel: "high" }),
      )
      .mockResolvedValueOnce(
        assessment({ status: "failed", stage: "extract", error: "api down" }),
      );
    const { app } = makeApp({ fitRepo: { get } });

    const r1 = await app.inject({ method: "GET", url: "/assessments/a-1" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ status: "running", stage: "collect" });

    const r2 = await app.inject({ method: "GET", url: "/assessments/a-1" });
    expect(r2.json()).toMatchObject({ status: "succeeded", needLevel: "high" });

    const r3 = await app.inject({ method: "GET", url: "/assessments/a-1" });
    expect(r3.statusCode).toBe(200); // failed でも HTTP エラーにしない（§A-4）
    expect(r3.json()).toMatchObject({ status: "failed", error: "api down" });
  });

  it("id 不明は 404", async () => {
    const { app } = makeApp({ fitRepo: { get: vi.fn().mockResolvedValue(null) } });
    const res = await app.inject({ method: "GET", url: "/assessments/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /assessments", () => {
  it("items で一覧を返す", async () => {
    const items = [
      {
        id: "a-1",
        company: { name: "example", domain: "example.co.jp" },
        status: "succeeded",
        stage: "done",
        needLevel: "high",
        humanNeedLevel: null,
        createdAt: "2026-07-05T00:00:00Z",
      },
    ];
    const { app } = makeApp({ fitRepo: { list: vi.fn().mockResolvedValue(items) } });
    const res = await app.inject({ method: "GET", url: "/assessments" });
    expect(res.json()).toEqual({ items });
  });
});

describe("PATCH /assessments/:id/human-review", () => {
  it("succeeded の行には記録できる", async () => {
    const succeeded = assessment({ status: "succeeded", stage: "done", needLevel: "high" });
    const { app, fitRepo } = makeApp({
      fitRepo: { get: vi.fn().mockResolvedValue(succeeded) },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/assessments/a-1/human-review",
      payload: { needLevel: "high", mismatchReason: null },
    });
    expect(res.statusCode).toBe(200);
    expect(fitRepo.setHumanReview).toHaveBeenCalledWith("a-1", {
      needLevel: "high",
      mismatchReason: null,
    });
  });

  it("running への記録は 409 not_finished", async () => {
    const { app, fitRepo } = makeApp(); // 既定の get は running を返す
    const res = await app.inject({
      method: "PATCH",
      url: "/assessments/a-1/human-review",
      payload: { needLevel: "low", mismatchReason: "collection_gap" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_finished");
    expect(fitRepo.setHumanReview).not.toHaveBeenCalled();
  });

  it("不正 body は 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/assessments/a-1/human-review",
      payload: { needLevel: "very-high" },
    });
    expect(res.statusCode).toBe(400);
  });
});
