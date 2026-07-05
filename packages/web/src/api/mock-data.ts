import { SIGNAL_CATALOG } from "@sa/shared/fit/signal-catalog";
import type {
  AssessmentListItem,
  FitAssessment,
  NeedLevel,
  SignalId,
  SignalResult,
} from "@sa/shared/types/fit";

/**
 * UI デモ用の完全架空データ（RFC 2606 の .example のみ。実在企業・URL は使わない）。
 */

/** デモ用 assessment ID（一覧・詳細の両方で共通）。 */
export const MOCK_IDS = {
  high: "demo-high",
  medium: "demo-medium",
  lowCompetitor: "demo-low-competitor",
  lowNone: "demo-low-none",
  unknown: "demo-unknown",
  running: "demo-running",
  failed: "demo-failed",
} as const;

/** 架空企業（ドメインはすべて .example）。 */
const CO = {
  high: { id: "mock-high", name: "株式会社ハイアパルス", domain: "hirepulse.example" },
  medium: { id: "mock-medium", name: "株式会社チームブリッジ", domain: "teambridge.example" },
  lowCompetitor: { id: "mock-competitor", name: "株式会社マッチガード", domain: "matchguard.example" },
  lowNone: { id: "mock-quiet", name: "株式会社ネビュラソフト", domain: "nebula-soft.example" },
  unknown: { id: "mock-unknown", name: "株式会社シードステージ", domain: "seed-stage.example" },
  running: { id: "mock-running", name: "株式会社アクメ", domain: "acme-corp.example" },
  failed: { id: "mock-failed", name: "株式会社フェイルド", domain: "failed-corp.example" },
} as const;

function url(domain: string, path: string): string {
  return `https://${domain}${path}`;
}

function makeSignals(
  domain: string,
  detected: Partial<
    Record<
      SignalId,
      { quoteSummary: string; path: string; insufficientHistory?: boolean }
    >
  >,
): SignalResult[] {
  return SIGNAL_CATALOG.map((def) => {
    const hit = detected[def.id];
    return {
      id: def.id,
      detected: hit !== undefined,
      strength: def.strength,
      evidence: hit
        ? [
            {
              url: url(domain, hit.path),
              quoteSummary: hit.quoteSummary,
              checkedAt: "2026-07-05",
              source: "extracted" as const,
            },
          ]
        : [],
      insufficientHistory: hit?.insufficientHistory ?? false,
    };
  });
}

function counterIds(signals: SignalResult[]): SignalId[] {
  return signals.filter((s) => s.detected && s.strength === "counter").map((s) => s.id);
}

function careersCheck(
  domain: string,
  foundPath: string | null,
): NonNullable<FitAssessment["careersCheck"]> {
  const paths = ["/recruit", "/careers"];
  return {
    checkedUrls: paths.map((p) => url(domain, p)),
    foundUrl: foundPath ? url(domain, foundPath) : null,
  };
}

function succeeded(
  id: string,
  company: { id: string; name: string; domain: string },
  opts: {
    needLevel: NeedLevel;
    signals: SignalResult[];
    rationale: string;
    missingData: SignalId[];
    careersCheck: FitAssessment["careersCheck"];
    createdAt: string;
    judgedAt: string;
    humanReview?: FitAssessment["humanReview"];
  },
): FitAssessment {
  return {
    id,
    status: "succeeded",
    stage: "done",
    company,
    input: { companyNameOrUrl: url(company.domain, "/") },
    signalsVersion: "v0.2",
    promptVersion: "v1",
    judgedAt: opts.judgedAt,
    needLevel: opts.needLevel,
    signals: opts.signals,
    counterSignals: counterIds(opts.signals),
    missingData: opts.missingData,
    careersCheck: opts.careersCheck,
    rationale: opts.rationale,
    humanReview: opts.humanReview ?? null,
    cost: {
      model: "claude-opus-4-8",
      inputTokens: 38_000 + opts.signals.filter((s) => s.detected).length * 800,
      outputTokens: 1_100,
      durationMs: 172_000,
    },
    error: null,
    createdAt: opts.createdAt,
    finishedAt: opts.judgedAt,
  };
}

const highSignals = makeSignals(CO.high.domain, {
  "1-1": {
    path: "/jobs/backend",
    quoteSummary:
      "バックエンドエンジニア募集が 2025-12 から継続掲載（8 ヶ月以上）。更新日も定期的。",
  },
  "3-1": {
    path: "/news/product-launch",
    quoteSummary: "新規 B2B SaaS「タレントレンズ」の正式リリースをプレスリリースで告知。",
  },
});

const mediumSignals = makeSignals(CO.medium.domain, {
  "1-1": {
    path: "/jobs/backend",
    quoteSummary: "バックエンドエンジニア募集が 2025-11 から継続掲載（7 ヶ月以上）。",
  },
  "4-2": {
    path: "/news/partnership",
    quoteSummary:
      "適性検査 SaaS「フィットチェック」との業務提携・導入事例をプレスリリースで告知。",
  },
  "5-1": {
    path: "/recruit",
    quoteSummary: "採用ページで「カルチャーフィット」「価値観の一致」を重視する記述。",
  },
});

const lowCompetitorSignals = makeSignals(CO.lowCompetitor.domain, {
  "4-1": {
    path: "/service",
    quoteSummary:
      "自社開発の「エンジニア適性マッチング SaaS」を提供。ミスマッチ防止がコア事業。",
  },
  "1-3": {
    path: "/careers",
    quoteSummary: "エンジニア 5 名規模の募集も並行して掲載（逆指標が優先される想定）。",
  },
});

const unknownSignals = makeSignals(CO.unknown.domain, {
  "5-3": {
    path: "/about",
    quoteSummary: "採用ページ刷新の告知のみ確認（求人・PR は未取得）。",
  },
});

const mockAssessments: Record<string, FitAssessment> = {
  [MOCK_IDS.high]: succeeded(MOCK_IDS.high, CO.high, {
    needLevel: "high",
    signals: highSignals,
    rationale:
      "求人シグナル 1-1（同一エンジニア職種の長期募集（6ヶ月以上））を検出。逆指標なし。確度 UP: 3-1（新規 Web サービス・アプリのリリース）",
    missingData: ["1-2", "2-1"],
    careersCheck: careersCheck(CO.high.domain, "/recruit"),
    createdAt: "2026-07-05T09:00:00.000Z",
    judgedAt: "2026-07-05T09:04:00.000Z",
  }),

  [MOCK_IDS.medium]: succeeded(MOCK_IDS.medium, CO.medium, {
    needLevel: "medium",
    signals: mediumSignals,
    rationale:
      "求人シグナル 1-1（同一エンジニア職種の長期募集（6ヶ月以上））を検出したが、軽微な逆指標 4-2（同種サービス提供企業との業務提携）あり",
    missingData: ["1-2", "2-1"],
    careersCheck: careersCheck(CO.medium.domain, "/recruit"),
    createdAt: "2026-07-05T10:27:00.000Z",
    judgedAt: "2026-07-05T10:30:00.000Z",
  }),

  [MOCK_IDS.lowCompetitor]: succeeded(MOCK_IDS.lowCompetitor, CO.lowCompetitor, {
    needLevel: "low",
    signals: lowCompetitorSignals,
    rationale:
      "逆指標 4-1（同種サービス（エンジニア×企業ミスマッチ防止）の自社開発）を検出（競合）。問合せ対象外",
    missingData: ["2-1"],
    careersCheck: careersCheck(CO.lowCompetitor.domain, "/careers"),
    createdAt: "2026-07-05T08:00:00.000Z",
    judgedAt: "2026-07-05T08:03:00.000Z",
  }),

  [MOCK_IDS.lowNone]: succeeded(MOCK_IDS.lowNone, CO.lowNone, {
    needLevel: "low",
    signals: makeSignals(CO.lowNone.domain, {}),
    rationale: "判定材料となるシグナルなし（または弱い 1 件のみ）",
    missingData: [
      "1-1", "1-2", "1-3", "1-4", "1-5", "2-1", "3-1", "3-2",
      "4-1", "4-2", "5-1", "5-2", "5-3", "5-4",
    ],
    careersCheck: careersCheck(CO.lowNone.domain, "/recruit"),
    createdAt: "2026-07-04T18:00:00.000Z",
    judgedAt: "2026-07-04T18:02:00.000Z",
  }),

  [MOCK_IDS.unknown]: succeeded(MOCK_IDS.unknown, CO.unknown, {
    needLevel: "unknown",
    signals: unknownSignals,
    rationale: "収集最低要件未達（不足: 求人媒体の求人情報、PR / ニュース）",
    missingData: ["1-1", "1-2", "2-1"],
    careersCheck: careersCheck(CO.unknown.domain, null),
    createdAt: "2026-07-04T12:00:00.000Z",
    judgedAt: "2026-07-04T12:01:00.000Z",
  }),

  [MOCK_IDS.running]: {
    id: MOCK_IDS.running,
    status: "running",
    stage: "extract",
    company: CO.running,
    input: { companyNameOrUrl: url(CO.running.domain, "/") },
    signalsVersion: "v0.2",
    promptVersion: "v1",
    judgedAt: null,
    needLevel: null,
    signals: makeSignals(CO.running.domain, {}),
    counterSignals: [],
    missingData: [],
    careersCheck: null,
    rationale: null,
    humanReview: null,
    cost: null,
    error: null,
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    finishedAt: null,
  },

  [MOCK_IDS.failed]: {
    id: MOCK_IDS.failed,
    status: "failed",
    stage: "collect",
    company: CO.failed,
    input: { companyNameOrUrl: url(CO.failed.domain, "/") },
    signalsVersion: "v0.2",
    promptVersion: "v1",
    judgedAt: null,
    needLevel: null,
    signals: makeSignals(CO.failed.domain, {}),
    counterSignals: [],
    missingData: [],
    careersCheck: null,
    rationale: null,
    humanReview: null,
    cost: null,
    error: "crawler unreachable: connect ECONNREFUSED 127.0.0.1:8000",
    createdAt: "2026-07-04T15:00:00.000Z",
    finishedAt: "2026-07-04T15:02:00.000Z",
  },
};

export const mockListItems: AssessmentListItem[] = [
  {
    id: MOCK_IDS.high,
    company: { name: CO.high.name, domain: CO.high.domain },
    status: "succeeded",
    stage: "done",
    needLevel: "high",
    humanNeedLevel: "high",
    createdAt: "2026-07-05T09:00:00.000Z",
  },
  {
    id: MOCK_IDS.medium,
    company: { name: CO.medium.name, domain: CO.medium.domain },
    status: "succeeded",
    stage: "done",
    needLevel: "medium",
    humanNeedLevel: null,
    createdAt: "2026-07-05T10:27:00.000Z",
  },
  {
    id: MOCK_IDS.lowCompetitor,
    company: { name: CO.lowCompetitor.name, domain: CO.lowCompetitor.domain },
    status: "succeeded",
    stage: "done",
    needLevel: "low",
    humanNeedLevel: "low",
    createdAt: "2026-07-05T08:00:00.000Z",
  },
  {
    id: MOCK_IDS.lowNone,
    company: { name: CO.lowNone.name, domain: CO.lowNone.domain },
    status: "succeeded",
    stage: "done",
    needLevel: "low",
    humanNeedLevel: null,
    createdAt: "2026-07-04T18:00:00.000Z",
  },
  {
    id: MOCK_IDS.unknown,
    company: { name: CO.unknown.name, domain: CO.unknown.domain },
    status: "succeeded",
    stage: "done",
    needLevel: "unknown",
    humanNeedLevel: null,
    createdAt: "2026-07-04T12:00:00.000Z",
  },
  {
    id: MOCK_IDS.running,
    company: { name: CO.running.name, domain: CO.running.domain },
    status: "running",
    stage: "extract",
    needLevel: null,
    humanNeedLevel: null,
    createdAt: mockAssessments[MOCK_IDS.running]!.createdAt,
  },
  {
    id: MOCK_IDS.failed,
    company: { name: CO.failed.name, domain: CO.failed.domain },
    status: "failed",
    stage: "collect",
    needLevel: null,
    humanNeedLevel: null,
    createdAt: "2026-07-04T15:00:00.000Z",
  },
];

export function getMockAssessment(id: string): FitAssessment | undefined {
  return mockAssessments[id];
}

/** POST 相当: 新規 running 行を先頭に追加して返す（メモリ上のみ）。 */
let extraItems: AssessmentListItem[] = [];

export function mockCreateAssessment(): { assessmentId: string; status: "running" } {
  const id = `demo-new-${Date.now()}`;
  const domain = "new-run.example";
  extraItems = [
    {
      id,
      company: { name: "株式会社デモ実行", domain },
      status: "running",
      stage: "collect",
      needLevel: null,
      humanNeedLevel: null,
      createdAt: new Date().toISOString(),
    },
    ...extraItems,
  ];
  mockAssessments[id] = {
    id,
    status: "running",
    stage: "collect",
    company: { id: "mock-new", name: "株式会社デモ実行", domain },
    input: { companyNameOrUrl: url(domain, "/") },
    signalsVersion: "v0.2",
    promptVersion: "v1",
    judgedAt: null,
    needLevel: null,
    signals: makeSignals(domain, {}),
    counterSignals: [],
    missingData: [],
    careersCheck: null,
    rationale: null,
    humanReview: null,
    cost: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  return { assessmentId: id, status: "running" };
}

export function getMockListItems(): AssessmentListItem[] {
  return [...extraItems, ...mockListItems];
}

export function mockSaveHumanReview(
  id: string,
  review: NonNullable<FitAssessment["humanReview"]>,
): FitAssessment {
  const a = mockAssessments[id];
  if (!a) throw new Error("not found");
  a.humanReview = review;
  const item = [...extraItems, ...mockListItems].find((i) => i.id === id);
  if (item) item.humanNeedLevel = review.needLevel;
  return { ...a };
}
