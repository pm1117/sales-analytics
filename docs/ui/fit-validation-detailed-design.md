# Fit 判定 PoC 詳細設計書

- ステータス: ドラフト v0.1
- 作成日: 2026-07-05
- 前提文書:
  - `docs/ui/fit-validation-design.md`（基本設計 v0.1 — 以下「基本 §n」）
  - `docs/ui/fit-validation-requirements.md`（要件 v0.1 — 以下「要件 §n」）
  - `docs/ui/fit-validation-signals.md`（シグナル定義 v0.2）
- 本書のバージョン定数: `SIGNALS_VERSION = "v0.2"` / `PROMPT_VERSION = "v1"`
- 粒度: 実装者がそのままコードを書ける粒度。**実際のソースコードは書かない**（型定義・疑似シグネチャまで）

---

## A. 型・契約

### A-1. `@sa/shared` に置く型（`packages/shared/src/types/fit.ts`）

既存 `types/domain.ts` / `types/fetch.ts` と同じ流儀（interface + string literal union）。collector と web の両方から import するため shared に置く。

```ts
// ---- 基本 enum ----
export type NeedLevel = "high" | "medium" | "low" | "unknown";
export type SignalStrength = "strong" | "weak" | "counter";
export type SignalId =
  | "1-1" | "1-2" | "1-3" | "1-4" | "1-5"   // 求人
  | "2-1"                                    // 口コミ
  | "3-1" | "3-2"                            // 経営
  | "4-1" | "4-2"                            // 競合・提携（逆指標）
  | "5-1" | "5-2" | "5-3" | "5-4";           // 補助
export type AssessmentStatus = "running" | "succeeded" | "failed";
export type AssessmentStage = "collect" | "extract" | "judge" | "done";
export type EvidenceSource = "extracted" | "manual" | "careers_probe";
export type MismatchReason =
  | "collection_gap"      // 収集漏れ
  | "extraction_error"    // 抽出ミス
  | "rule_issue"          // 集約ルールの問題
  | "private_info";       // 人間側の根拠が非公開情報（要件 §8-3）
export type CounterSeverity = "fatal" | "major" | "minor";  // §C-3 の判定で使用

// ---- 判定結果の構成要素 ----
export interface Evidence {
  url: string;             // 収集済み canonical URL / 手動確認 URL に限る（§C-5）
  quoteSummary: string;    // 要約のみ。逐語転載禁止（法務）
  checkedAt: string;       // ISO8601。extracted はコードが実行日を付与（LLM に書かせない）
  source: EvidenceSource;
}
export interface SignalResult {
  id: SignalId;
  detected: boolean;
  strength: SignalStrength;         // カタログ（§C-1）から引く。LLM 出力を信用しない
  evidence: Evidence[];             // detected=true なら 1 件以上（0 件なら detected=false に落とす）
  insufficientHistory: boolean;     // 1-1/1-2 の時系列不足（要件 F2）
}
export interface CareersCheck {
  checkedUrls: string[];            // 404 含む確認済み URL 全件（シグナル 1-5 の根拠）
  foundUrl: string | null;
}
export interface AssessmentCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;               // collect 開始〜persist 完了（S5）
}
export interface HumanReview {
  needLevel: NeedLevel;
  mismatchReason: MismatchReason | null;   // AI 判定と一致なら null
  reviewedAt: string;
}

// ---- 入力 ----
export interface SeedUrl { kind: "careers" | "jobs_media"; url: string; }
export interface ManualInput {
  signalId: SignalId;
  url: string;
  quoteSummary: string;
  checkedAt: string;      // 人間が確認した日（YYYY-MM-DD 可）
}
export interface AssessmentInput {
  companyNameOrUrl: string;
  seedUrls?: SeedUrl[];
  manualInputs?: ManualInput[];
  allowManaged?: boolean;           // 既存 Gate4 opt-in と同じ
}

// ---- 集約ルート型 ----
export interface FitAssessment {
  id: string;
  status: AssessmentStatus;
  stage: AssessmentStage;
  company: { id: string; name: string; domain: string };
  input: AssessmentInput;           // 再実行の再現用（DB input カラムの写し）
  signalsVersion: string;           // "v0.2"
  promptVersion: string;            // "v1"
  judgedAt: string | null;
  needLevel: NeedLevel | null;
  signals: SignalResult[];          // カタログ全 14 件ぶん必ず存在（detected=false 含む）
  counterSignals: SignalId[];       // signals から導出（detected && strength=counter）
  missingData: SignalId[];          // 取得不可・履歴不足
  careersCheck: CareersCheck | null;
  rationale: string | null;
  humanReview: HumanReview | null;
  cost: AssessmentCost | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
```

### A-2. シグナルカタログ型（`packages/shared/src/fit/signal-catalog.ts`）

カタログは**データ**（コードでなく定数配列）。judge・プロンプト生成・web の表示名がすべてここを参照する（定義の一元化 — 要件 §4-3 のバージョン管理単位）。

```ts
export interface SignalDef {
  id: SignalId;
  name: string;                     // 例: "同一エンジニア職種の長期募集（6ヶ月以上）"
  category: "jobs" | "reviews" | "management" | "competitor" | "auxiliary";
  strength: SignalStrength;
  counterSeverity?: CounterSeverity;   // strength=counter のみ（§C-3）
  detector: "llm" | "manual" | "probe+llm";  // §C-1 の検出主体
  detectionHint: string;            // LLM への判定基準文（§C-2 で全文定義）
  requiresHistory: boolean;         // true: 1-1, 1-2（時系列が要る）
}
export const SIGNALS_VERSION = "v0.2";
export const SIGNAL_CATALOG: readonly SignalDef[];   // 全 14 件（§C-1 の表と 1:1）
```

### A-3. zod スキーマ（`packages/shared/src/schemas/fit.ts`）

既存 `schemas/crawler.ts` と同居。API バリデーション（routes）と LLM 出力検証（extractor）の両方で使う。

| スキーマ名 | 対象 | 要点 |
|---|---|---|
| `AssessmentInputSchema` | POST /assessments body | `companyNameOrUrl: string.min(1)`、`seedUrls` は URL 形式 + kind enum、`manualInputs.signalId` は SignalId enum。上限: seedUrls ≤ 10、manualInputs ≤ 20 |
| `HumanReviewSchema` | PATCH body | `needLevel` enum、`mismatchReason` enum nullable |
| `ExtractorOutputSchema` | LLM tool 出力 | §A-6 の JSON スキーマと同型。**14 シグナル全件の存在**と ID 重複なしを `superRefine` で検証 |

### A-4. API 契約（OpenAPI 風）

共通: `Content-Type: application/json`。認証なし（localhost PoC）。エラー形式は既存 /dossiers と同じ `{ error: string, message: string }`。

#### `POST /assessments` — 判定開始

| | |
|---|---|
| Request body | `AssessmentInput`（§A-1） |
| `202` | `{ "assessmentId": "<uuid>", "status": "running" }` — 即返し。実行は in-process fire-and-forget |
| `400 invalid_request` | zod 失敗。`message` に zod issues 要約 |
| `409 domain_required` | 既存 `DomainRequiredError` と同じ（企業名からドメイン解決不可 → URL を要求） |
| `409 already_running` | 同一 company_id で `status='running'` の行が既にある場合（多重実行防止。PoC は 1 社 1 実行） |

#### `GET /assessments/:id` — 1 件取得（ポーリング先）

| | |
|---|---|
| `200` | `FitAssessment`（§A-1）をそのまま JSON 化。running 中は `needLevel: null`・`signals: []`。**failed も 200**（`status:"failed"` + `error`）— ポーリングを壊さないため |
| `404 not_found` | id 不明 |

#### `GET /assessments` — 一覧

| | |
|---|---|
| `200` | `{ "items": AssessmentListItem[] }`。企業ごと最新 1 件（SQL: `DISTINCT ON (company_id) ... ORDER BY company_id, created_at DESC`）を `created_at` 降順で |

```ts
export interface AssessmentListItem {   // @sa/shared types/fit.ts に含める
  id: string;
  company: { name: string; domain: string };
  status: AssessmentStatus;
  stage: AssessmentStage;
  needLevel: NeedLevel | null;
  humanNeedLevel: NeedLevel | null;
  createdAt: string;
}
```

#### `PATCH /assessments/:id/human-review` — 人間判定の記録

| | |
|---|---|
| Request body | `{ "needLevel": NeedLevel, "mismatchReason": MismatchReason \| null }` |
| `200` | 更新後の `FitAssessment` |
| `404` / `400` | 上と同様 |
| `409 not_finished` | `status !== 'succeeded'` の行への記録は拒否 |

### A-5. DB ↔ 型のマッピング

テーブル定義は基本 §5-2 の DDL を正とする。JSONB カラムへの格納規約:

| カラム | 中身 |
|---|---|
| `signals` | `SignalResult[]`（14 件全件、camelCase のまま） |
| `missing_data` | `SignalId[]` |
| `careers_check` | `CareersCheck` |
| `input` | `AssessmentInput` |

`counterSignals` はカラムに持たず、リポジトリの read 時に `signals` から導出して型に詰める。

### A-6. LLM structured output の JSON スキーマ（tool 定義）

`fit-prompt.ts` に定数として持つ。`tools: [RECORD_SIGNALS_TOOL]` + `tool_choice: { type: "tool", name: "record_signals" }` で強制。

```jsonc
{
  "name": "record_signals",
  "description": "収集済みコンテンツから検出した Fit 判定シグナルを全件記録する",
  "input_schema": {
    "type": "object",
    "required": ["signals"],
    "properties": {
      "signals": {
        "type": "array",
        "minItems": 14, "maxItems": 14,     // カタログ全件を必ず 1 回ずつ（判定漏れ防止）
        "items": {
          "type": "object",
          "required": ["signalId", "detected", "evidence", "insufficientHistory"],
          "properties": {
            "signalId": { "type": "string",
              "enum": ["1-1","1-2","1-3","1-4","1-5","2-1","3-1","3-2","4-1","4-2","5-1","5-2","5-3","5-4"] },
            "detected": { "type": "boolean" },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["url", "quoteSummary"],
                "properties": {
                  "url": { "type": "string", "description": "引用可能URLリスト内のURLのみ" },
                  "quoteSummary": { "type": "string", "maxLength": 300,
                    "description": "根拠の要約。原文の逐語転載は禁止" }
                }
              }
            },
            "insufficientHistory": { "type": "boolean",
              "description": "時系列情報（掲載開始日・過去求人票）が無く判定不能の場合 true。1-1/1-2 以外は常に false" }
          }
        }
      }
    }
  }
}
```

LLM 出力に `strength` / `checkedAt` / `source` は**含めない**（カタログとコードが付与する。LLM に判定・日付を書かせない）。

---

## B. モジュール構成

### B-1. `packages/collector` への追加ファイル

| ファイル | 責務 / 公開インターフェース（疑似シグネチャ） |
|---|---|
| `src/fit/fit-orchestrator.ts` | パイプライン制御。`class FitOrchestrator { constructor(deps: { companyRepo, sourceRepo, contentRepo, fitRepo, queue, enumerator, careersProbe, extractor, judge, logger }); run(assessmentId: string, input: AssessmentInput): Promise<void> }` — §C-6 のフローを直列実行。**throw しない**（全例外を catch して `fitRepo.finishFailure`） |
| `src/fit/signal-extractor.ts` | LLM 抽出。`class SignalExtractor { constructor(client: Anthropic, opts: { model, maxContextTokens }); extract(input: ExtractionInput): Promise<ExtractionResult> }`。`ExtractionInput = { company: {name, domain}, snippets: ContentSnippet[], allowedUrls: string[], today: string }`（today は呼び出し側供給 — プロンプトを決定的にし snapshot 可能にする）、`ContentSnippet = { url, sourceKind, fetchedAt, markdown }`、`ExtractionResult = { signals: RawSignal[], usage: {inputTokens, outputTokens}, droppedSnippetUrls: string[] }`（droppedSnippetUrls = 予算超過で落としたソース。evidence の URL 突合と破棄件数は §C-5 手順 1 の `filterEvidence` の責務）。zod 失敗時 1 回だけリトライ（エラー内容を追記して再送）→ 失敗なら throw ※PR3 実装反映（2026-07-05） |
| `src/fit/fit-prompt.ts` | プロンプト組み立て。`PROMPT_VERSION = "v1"`、`RECORD_SIGNALS_TOOL`（§A-6）、`buildFitSystemPrompt(catalog: SignalDef[]): string`、`buildFitUserMessage(input: ExtractionInput): string`（§C-2 のテンプレート） |
| `src/fit/evidence-filter.ts` | 捏造ガード（純関数・単体テスト対象）。`filterEvidence(raw: RawSignal[], allowedUrls: Set<string>, checkedAt: string): { signals: SignalResult[], droppedCount: number }` — URL 逸脱 evidence 破棄 → evidence 0 件のシグナルを detected=false に落とす → strength/source/checkedAt を付与 |
| `src/fit/merge-manual.ts` | `mergeManualInputs(signals: SignalResult[], manual: ManualInput[]): SignalResult[]` — manualInput を該当シグナルの evidence（source="manual"）として追加し detected=true にする。純関数 |
| `src/fit/need-judge.ts` | 決定的判定（純関数）。`judge(input: JudgeInput): JudgeResult`。§C-3 の決定表を実装。`JudgeInput = { signals: SignalResult[], collection: CollectionStatus }`、`CollectionStatus = { careersChecked: boolean, jobsInfoCount: number, prNewsCount: number }`、`JudgeResult = { needLevel, rationale, missingData: SignalId[] }` |
| `src/fit/careers-probe.ts` | 採用ページ発見。`class CareersProbe { constructor(deps: { conditionalGet: HttpConditionalGetAdapter, robots: RobotsGuard, rateLimiter: RateLimiter }); probe(domain: string, hpMarkdown: string | null): Promise<CareersCheck> }` — §C-4-1 の手順 |
| `src/storage/repositories/fit-assessment-repo.ts` | `class FitAssessmentRepo { insert(companyId, input): Promise<string>; updateStage(id, stage); finishSuccess(id, result: {...}); finishFailure(id, stage, error); get(id): Promise<FitAssessment \| null>; list(): Promise<AssessmentListItem[]>; setHumanReview(id, review); hasRunning(companyId): Promise<boolean>; markInterrupted(): Promise<number> }`。他リポジトリと同じ `Db` ラッパー流儀 |
| `src/storage/migrations/0002_fit.sql` | 基本 §5-2 の DDL + enum 拡張（§5-3）。冒頭コメントに既存ボリュームへの手動適用手順（`docker compose exec db psql -U app -d sales_analytics -f /docker-entrypoint-initdb.d/0002_fit.sql`） |
| `src/server/routes/assessment.ts` | §A-4 の 4 エンドポイント。既存 `dossier.ts` と同じ流儀（zod parse → orchestrator/repo 呼び出し → エラーマッピング）。POST は `fitRepo.insert` → `void fitOrchestrator.run(id, input)`（await しない）→ 202 |
| `src/scripts/assess-poc.ts` | CLI。`tsx assess-poc.ts <company-url> [--out poc-output]` = フル実行 + `fit-judgement.{json,md}` 出力。`--offline <dir>` = §E-1 のモック入力モード |
| `src/index.ts`（改修） | DI 配線追加（fitRepo → careersProbe → extractor → judge → FitOrchestrator → routes 登録）。起動時に `fitRepo.markInterrupted()`（基本 §9 リスク 5）。`@fastify/cors` は追加しない（Vite proxy で解決） |
| `src/orchestrator/source-enumerator.ts`（改修） | `ensureSources(company)` に第 2 引数 `seedUrls?: SeedUrl[]` を追加（省略時は現行動作 — /dossiers に影響なし）。seed は robots 判定を通して `sources` に upsert（kind = seed.kind） |

削除・リネームする既存ファイルはない。

### B-2. `packages/shared` への追加

| ファイル | 内容 |
|---|---|
| `src/types/fit.ts` | §A-1 の型全部 + `AssessmentListItem` |
| `src/fit/signal-catalog.ts` | `SignalDef` / `SIGNAL_CATALOG` / `SIGNALS_VERSION`（§A-2, §C-1） |
| `src/schemas/fit.ts` | §A-3 の zod スキーマ |
| `src/env.ts`（改修） | 追加: `FIT_MODEL`（default = `DOSSIER_MODEL` と同値）、`FIT_MAX_CONTEXT_TOKENS`（default = `DOSSIER_MAX_CONTEXT_TOKENS`） |

### B-3. `packages/web`（新規）のディレクトリ構成

```
packages/web/
├── package.json          # react, react-dom, react-router-dom, @tanstack/react-query
│                         # devDeps: vite, @vitejs/plugin-react, typescript
├── tsconfig.json         # ../../tsconfig.base.json を extends（strict）
├── vite.config.ts        # server.proxy: { "/assessments": "http://localhost:3000" }
├── index.html
└── src/
    ├── main.tsx          # QueryClientProvider + RouterProvider
    ├── App.tsx           # ルート定義（§D-1）
    ├── api/
    │   └── client.ts     # fetch ラッパー: getAssessments / getAssessment / createAssessment / saveHumanReview
    │                     # 型は @sa/shared からの import のみ（web 独自の API 型を作らない）
    ├── hooks/
    │   ├── useAssessments.ts   # 一覧 + running 行があれば 5s ポーリング（§D-3）
    │   └── useAssessment.ts    # 詳細 + status==='running' の間だけ 5s ポーリング
    ├── pages/
    │   ├── AssessmentListPage.tsx
    │   └── AssessmentDetailPage.tsx
    └── components/
        ├── CompanyInput.tsx      # URL + 詳細オプション（seedUrls / manualInputs 行）
        ├── AssessmentTable.tsx   # 一覧テーブル
        ├── NeedLevelBadge.tsx    # high/medium/low/unknown の色分けバッジ
        ├── RunningProgress.tsx   # stage ステッパー + 経過時間（§D-4）
        ├── FitResult.tsx         # 判定サマリー（バッジ + rationale + careersCheck + cost）
        ├── SignalCard.tsx        # シグナル 1 件（名称/強度/evidence リンク/欠損表示）
        ├── HumanReviewForm.tsx   # 人間判定の記録（ブラインド注意書き付き）
        └── OutreachDraft.tsx     # 【スタブ】問い合わせ文面 — 次フェーズ（§D-2 注記）
```

ルート `package.json` に `dev:web`（`vite dev` ）スクリプトを追加。pnpm workspace は `packages/*` で既にカバーされる。

---

## C. Fit 判定ロジック

### C-1. シグナル定義表（signals v0.2 と 1:1）

`SIGNAL_CATALOG` の実体。**strength / counterSeverity はこの表が唯一の正**（LLM 出力の strength は使わない）。

| ID | 名称 | category | strength | counterSeverity | detector | 主な入力 | requiresHistory |
|---|---|---|---|---|---|---|---|
| 1-1 | 同一エンジニア職種の長期募集（6ヶ月以上） | jobs | strong | — | llm | jobs_media, careers | **true** |
| 1-2 | 募集条件の急な緩和（未経験可 等） | jobs | strong | — | llm | jobs_media, careers | **true** |
| 1-3 | 大手の大量募集 / 大手完全子会社で 2 名以上 | jobs | strong | — | llm | jobs_media, careers, press | false |
| 1-4 | エンジニア職種の複数同時募集 | jobs | strong | — | llm | careers, jobs_media | false |
| 1-5 | コーポレートサイトにエンジニア求人なし | jobs | counter | **major** | **probe+llm** | careers_probe + careers 本文 | false |
| 2-1 | エンジニア向けネガティブ口コミの増加 | reviews | strong | — | **manual** | manualInputs のみ（自動収集しない） | false |
| 3-1 | 新規 Web サービス・アプリのリリース | management | strong | — | llm | press, hp | false |
| 3-2 | 採用急拡大・組織拡大の明示 | management | strong | — | llm | press, careers | false |
| 4-1 | 同種サービス（ミスマッチ防止）の自社開発 | competitor | counter | **fatal** | llm | hp, press | false |
| 4-2 | 同種サービス提供企業との業務提携 | competitor | counter | **minor** | llm | press, hp | false |
| 5-1 | カルチャー・チームフィットの強調 | auxiliary | weak | — | llm | careers, jobs_media | false |
| 5-2 | 早期離職・ミスマッチへの自社言及 | auxiliary | weak | — | llm | press, careers | false |
| 5-3 | 採用ページ・採用ブランドの刷新 | auxiliary | weak | — | llm | press, careers | false |
| 5-4 | 難易度が高い技術職の募集 | auxiliary | weak | — | llm | careers, jobs_media | false |

補足:

- **1-5 の検出は 2 経路の OR**: (a) `CareersProbe` が採用ページを発見できなかった（コード検出。evidence = checkedUrls, source="careers_probe"）、(b) 採用ページはあるがエンジニア求人が無い（LLM 検出）。(a) の場合 LLM には 1-5 を「判定不能」として detected=false で返させ、コード側で上書きする
- **2-1 は LLM に判定させない**: プロンプト上「口コミ情報はコンテキストに含まれない。常に detected=false で返す」と明示。manualInputs 由来のみ（§C-5 のマージで detected 化）
- signals v0.2 の「high 寄りの middle」等の微妙な強弱（1-1 の人気企業パターン）は PoC では quoteSummary に記述させるにとどめ、集約はこの表の strength で行う（割り切り）

### C-2. プロンプトテンプレート（`fit-prompt.ts`）

#### system（`buildFitSystemPrompt`）

```text
あなたは B2B 営業のリサーチアナリストです。収集済みの公開 Web コンテンツだけを根拠に、
対象企業について以下の「シグナルカタログ」の各シグナルを検出します。

ルール:
1. 必ず record_signals ツールを 1 回呼び、カタログの全 14 シグナルをそれぞれ 1 エントリずつ返す。
2. evidence の url は、ユーザーメッセージ内の「引用可能 URL リスト」にある URL のみ使用する。
   リスト外の URL・記憶・推測に基づく evidence は禁止。
3. 根拠となる記述が見つからないシグナルは detected: false・evidence: [] で返す。
   迷った場合は必ず detected: false に倒す（偽陽性より偽陰性を選ぶ）。
4. quoteSummary は自分の言葉での要約に限る。原文の逐語転載・長文引用は禁止（最大300字）。
5. need_level（high/medium 等）の判定はしない。あなたの仕事は個々のシグナルの検出のみ。
6. 掲載開始日・過去の求人票との比較が必要なシグナル（1-1, 1-2）で、コンテキストに
   時系列情報が無い場合は detected: false かつ insufficientHistory: true で返す。
7. 口コミシグナル（2-1）の情報はコンテキストに含まれない。常に detected: false で返す。

## シグナルカタログ
{{SIGNAL_CATALOG}}
```

`{{SIGNAL_CATALOG}}` はカタログから機械生成。1 シグナルのレンダリング形式:

```text
### {{id}} {{name}}（{{strength を日本語: 強い/弱い/逆指標}}）
{{detectionHint}}
```

#### 各シグナルの `detectionHint`（プロンプト断片・全文）

| ID | detectionHint |
|---|---|
| 1-1 | 同じエンジニア職種の求人が 6 ヶ月以上掲載され続けている場合に検出。求人の掲載開始日・更新履歴・「募集開始から◯ヶ月」等の記述を根拠にする。掲載期間を示す情報が無ければ insufficientHistory: true。中途に人気の企業が常時オープンにしているだけの可能性がある場合は、その旨を quoteSummary に付記する |
| 1-2 | 「未経験可」「他業種歓迎」など、以前より応募条件を緩めた形跡がある場合に検出。変更前後の求人票または条件変更時期を示す記述が根拠として必要。現在の求人票 1 枚だけでは判定できない（insufficientHistory: true） |
| 1-3 | 大手企業による大量（目安 5 名以上）のエンジニア募集、または大手完全子会社での 2 名以上の同時募集を検出。会社規模はコンテキスト内の記述（従業員数・資本関係）から判断し、根拠を quoteSummary に含める |
| 1-4 | エンジニア職種（バックエンド・フロントエンド・SRE 等）が同時に複数募集されている場合に検出。職種名と件数を quoteSummary に列挙する |
| 1-5 | 自社コーポレートサイト・採用ページにエンジニア求人が見当たらない場合に検出。採用ページのコンテキストが与えられており、かつエンジニア募集の記載が無いことを確認できた場合のみ。採用ページ自体がコンテキストに無い場合は detected: false（システム側で別途判定する） |
| 2-1 | （検出しない — ルール 7 参照。常に detected: false） |
| 3-1 | 新規の Web サービス・アプリのリリースを告知するプレスリリース・ニュースを検出。リリース日と製品名を quoteSummary に含める。既存サービスの機能追加・アップデートは含めない |
| 3-2 | 「採用強化」「組織拡大」「◯名採用計画」等、採用・組織の急拡大を明示する記述を検出 |
| 4-1 | 対象企業自身が「エンジニアと企業のミスマッチ防止・適性見極め・エンジニア採用支援」に類するサービスを開発・提供している場合に検出（＝競合）。サービス紹介・プロダクト求人の JD が根拠 |
| 4-2 | ミスマッチ防止・適性検査・エンジニアマッチング系サービスとの業務提携・導入事例の告知を検出（＝対策済みの可能性）。提携先サービス名を quoteSummary に含める |
| 5-1 | 採用ページ・求人票で「カルチャーフィット」「価値観」「チームとの相性」を重視する記述を検出 |
| 5-2 | 早期離職・定着率・ミスマッチという課題への自社言及（ブログ・PR・採用ページ）を検出 |
| 5-3 | 採用サイトのリニューアル・採用ブランディング刷新の告知を検出 |
| 5-4 | 希少スキル・専門性の高い技術スタック（例: 特定領域の研究開発職、Findy 等ハイスキル媒体の利用）を要する募集を検出 |

#### user（`buildFitUserMessage`）

```text
対象企業: {{company.name}}（{{company.domain}}）
本日の日付: {{today}}

## 引用可能 URL リスト
{{allowedUrls を 1 行 1 URL で列挙}}

## 収集済みコンテンツ
[1] {{snippet.url}}（種別: {{sourceKind}} / 取得日: {{fetchedAt}}）
{{markdown（8,000 字でスライス）}}

[2] ...
```

コンテキスト組み立て順（トークン予算 `FIT_MAX_CONTEXT_TOKENS * 3` 文字、既存 `buildContext` と同方式）: **careers 全件 → jobs_media 全件 → press 最新 5 件 → corporate_hp 最新 1 件**。予算超過時は後方（hp 側）から落とし、落としたソースをログに残す。

### C-3. need_level 集約ルール（`need-judge.ts` の決定表）

要件 §4-2 の表を完全実装する。要件表が定義していない組み合わせは以下の太字の**設計判断**で埋めた。入力は evidence 検証済み（出典なしシグナルは既に detected=false）の `SignalResult[]`。

事前計算:

```
counters      = detected && strength=counter
fatalOrMajor  = counters のうち severity ∈ {fatal, major}   // 4-1, 1-5
minorCounters = counters のうち severity = minor              // 4-2
strongJobs    = detected && strength=strong && category=jobs           // 1-1〜1-4
strongOther   = detected && strength=strong && category∈{reviews,management}  // 2-1, 3-1, 3-2
weak          = detected && strength=weak                              // 5-1〜5-4
minimumMet    = collection.careersChecked && collection.jobsInfoCount≥1 && collection.prNewsCount≥1
```

判定（**上から順に評価し、最初に該当した行で確定**）:

| # | 条件 | needLevel | rationale テンプレート | 根拠 |
|---|---|---|---|---|
| 1 | `!minimumMet` | **unknown** | 「収集最低要件未達（不足: {careers確認/求人情報/PR} ）」 | 要件 §6-3 |
| 2 | `fatalOrMajor ≥ 1` | **low** | 「逆指標 {id: 名称} を検出。問合せ対象外」（4-1 は「競合」、1-5 は「リファラル採用疑い」を明記） | signals 1-5 / 4-1。**counter があれば high 禁止 = S2 のハード制約** |
| 3 | `minorCounters ≥ 1 && strongJobs ≥ 1` | **medium** | 「求人シグナル {ids} を検出したが、軽微な逆指標 {4-2} あり」 | 要件 §4-2 medium 前段 |
| 4 | `minorCounters ≥ 1`（strongJobs 0） | **low** | 「逆指標 {4-2} あり。強い求人シグナルなし」 | 要件 §4-2 low |
| 5 | `strongJobs ≥ 1` | **high** | 「求人シグナル {ids: 名称} を検出。逆指標なし」（strongOther があれば「確度 UP: {ids}」を付記） | 要件 §4-2 high |
| 6 | `weak ≥ 2` | **medium** | 「弱いシグナル {ids} が 2 件以上。逆指標なし」（strongOther があれば付記） | 要件 §4-2 medium 後段 |
| 7 | それ以外 | **low** | strongOther 検出時: 「{ids} を検出したが求人シグナルなし → 問い合わせ対象外」/ 検出なし時: 「判定材料となるシグナルなし（または弱い 1 件のみ）」 | **設計判断（2026-07-05 確定）**: 「求人シグナルなしで 3-1 だけの企業にフォームを送るか？」→ 送らない。strongOther（2-1/3-1/3-2）単独は **low**。high の確度 UP 材料（行 5）としてのみ効かせる |

行 6 が行 7 より先なのは意図的: strongOther + 弱い 2 件以上（逆指標 0）は要件 §4-2 どおり medium とする（strongOther の存在が weak≥2 判定を妨げない）。

- `missingData` = `insufficientHistory=true` のシグナル + detector=manual で manualInput が無いシグナル（= 2-1）+ 収集失敗ソースに紐づくシグナル
- rationale は上表のテンプレートをコードで組み立てる（LLM に書かせない — 再現性）
- **順序が仕様**: 行 2 が行 5 より先 = 「逆指標 ≥1 なら strong があっても high にしない」

### C-4. 収集データ不足時の fallback

#### C-4-1. CareersProbe の手順

1. 収集済み corporate_hp の Markdown からリンクを抽出し、URL パスまたはアンカーテキストが `採用|recruit|career|jobs|saiyo|entry` にマッチする同一ドメイン URL を候補にする（ネットワークコスト 0）
2. 候補が無ければ既定パスを順にプローブ: `/recruit`, `/recruit/`, `/careers`, `/careers/`, `/recruitment`, `/jobs`, `/saiyo`（各リクエストは `RobotsGuard` → `RateLimiter` → 既存 Gate2 conditional GET。robots 不許可のパスはスキップし checkedUrls に `(robots-blocked)` 注記で記録）
3. HTTP 200 かつ本文が取れた最初の URL を `foundUrl` とし、`sources` に kind=careers で登録 → 本文を scraped_contents へ
4. 全滅なら `foundUrl: null`。**checkedUrls は成否問わず全件記録**（1-5 の「確認したが無かった」根拠 — 要件 §6-1）
5. リクエストに `seedUrls(kind=careers)` があればプローブ全体をスキップしてそれを使う

#### C-4-2. fallback 一覧

| 欠損 | 挙動 |
|---|---|
| careers プローブ全滅（foundUrl: null） | `careersChecked=true`（確認は完了）。1-5 を detected=true（counter, evidence=checkedUrls, source="careers_probe"）→ 判定は low。rationale に「サイト構造が特殊な可能性あり。careers URL を seedUrls で指定して再実行を推奨」を付記 |
| jobs_media が 0 件（seed なし・manual なし） | `jobsInfoCount=0` → **unknown**（要件 §6-3-2）。missingData に 1-1〜1-4。UI は「求人媒体 URL を追加して再実行」を案内 |
| PR/ニュースフィード発見失敗 or 0 件 | `prNewsCount=0` → **unknown**（要件 §6-3-3） |
| 1-1/1-2 の時系列なし | `insufficientHistory=true` → detected=false 扱い + missingData（要件 F2。誤検出より欠損） |
| 口コミ manualInput なし | 2-1 は missingData 入り。判定は他シグナルのみで続行（unknown にはしない — §6-3 の最低要件に口コミは含まれない） |
| 個別ソースの fetch 失敗（robots/エラー） | 失敗を per-source で記録し続行（silent skip 禁止 — 要件 F1）。失敗が §6-3 に関わる場合のみ unknown へ |
| Claude API エラー（リトライ後も失敗） | `status='failed'`, stage='extract', error にメッセージ。UI から再実行（新規行） |

### C-5. extract 後処理の順序（FitOrchestrator 内、すべて純関数）

1. `filterEvidence(raw, allowedUrls, today)` — URL 逸脱 evidence 破棄（破棄件数をログ + `droppedCount`）→ evidence 0 件を detected=false 化 → strength/source/checkedAt 付与
2. 1-5 のプローブ結果上書き（§C-1 補足: foundUrl が null なら detected=true / counter）
3. `mergeManualInputs(signals, input.manualInputs)` — source="manual" の evidence を追加、detected=true 化。**manualInputs の URL は allowedUrls 制約の対象外**（人間確認済みのため）
4. `judge({ signals, collection })` — §C-3

`allowedUrls` = 今回コンテキストに入れた snippet の URL + careersCheck.checkedUrls（正規化は既存 `canonicalizeUrl`）。

### C-6. FitOrchestrator.run のフロー（正常系 / 異常系）

```
run(assessmentId, input):
  t0 = 開始時刻
  try:
    # -- collect --
    company  = resolveCompany(input.companyNameOrUrl)        # 既存。DomainRequired はルート側で 409 済み
    sources  = enumerator.ensureSources(company, input.seedUrls)
    careersCheck = (careers source が無ければ) careersProbe.probe(domain, hpMarkdown)
    results  = Promise.allSettled(sources.map(s => queue.enqueueFetch(jobFor(s))))
    fitRepo.updateStage(id, "extract")
    # -- extract --
    snippets = contentRepo から §C-2 の順で取得・スライス
    raw      = extractor.extract({ company, snippets, allowedUrls })
    fitRepo.updateStage(id, "judge")
    # -- judge（§C-5 の 1→4） --
    result   = judge(...)
    # -- persist --
    fitRepo.finishSuccess(id, { needLevel, signals, missingData, careersCheck,
                                rationale, cost: {model, tokens, durationMs: now-t0} })
  catch (e):
    fitRepo.finishFailure(id, 現在の stage, e.message)        # throw しない
```

---

## D. UI 詳細（packages/web）

### D-1. ルーティング

| パス | ページ | 内容 |
|---|---|---|
| `/` | `AssessmentListPage` | CompanyInput + AssessmentTable（基本 §6 画面 1） |
| `/assessments/:id` | `AssessmentDetailPage` | RunningProgress（running 時）/ FitResult + SignalCard 群 + HumanReviewForm + OutreachDraft（succeeded 時）/ エラー + 再実行（failed 時） |

react-router の 2 ルートのみ。404 は `/` へリダイレクト。

### D-2. コンポーネント仕様

| コンポーネント | props（疑似） | 責務・挙動 |
|---|---|---|
| `CompanyInput` | `{ onSubmitted(id) }` | URL 入力 + 「詳細オプション」折りたたみ（seedUrls 行追加 UI: kind select + URL、manualInputs 行追加 UI: signalId select（カタログから名称表示）+ URL + 要約 + 確認日）。送信で `createAssessment` mutation → 成功時 `onSubmitted(assessmentId)` → 一覧を invalidate。409 already_running はフォーム下にメッセージ表示 |
| `AssessmentTable` | `{ items: AssessmentListItem[] }` | 基本 §6 画面 1 の表。行クリックで `/assessments/:id`。running 行は stage を日本語表示（収集中/抽出中/判定中） |
| `NeedLevelBadge` | `{ level: NeedLevel \| null }` | high=緑 / medium=黄 / low=灰 / unknown=紫 / null(実行中)=「―」。**色 + ラベル文字**の両方（色だけに頼らない） |
| `RunningProgress` | `{ assessment }` | stage ステッパー「収集 → 抽出 → 判定」+ `createdAt` からの経過時間 + 注意文「収集はサイト負荷配慮のため 1 アクセス 10〜20 秒間隔で行います。数分かかります」（§D-4） |
| `FitResult` | `{ assessment }` | バッジ + rationale + careersCheck（foundUrl または「確認 {n} URL・採用ページなし」を展開表示）+ missingData + cost（分・トークン・モデル） |
| `SignalCard` | `{ def: SignalDef, result: SignalResult }` | カタログ名称 + 強度チップ（強い/弱い/逆指標）+ evidence リンク（`target="_blank"`、source=manual は「手動」チップ、checkedAt 表示）+ insufficientHistory 時は「時系列情報が不足（判定対象外）」。表示順: counter → strong(detected) → weak(detected) → 未検出（折りたたみ） |
| `HumanReviewForm` | `{ assessment }` | needLevel ラジオ + mismatchReason セレクト（4 分類 + 「一致（なし）」）+ 保存。冒頭に注意書き「⚠ 正解づけはシステム判定を見る前に済ませること（要件 §8 ブラインド原則）。この画面は記録専用」。保存済みなら現在値を表示して編集可 |
| `OutreachDraft` | `{ assessment }` | **スタブ（意図的に表示する — 2026-07-05 確定）**。「問い合わせ文面の生成は次フェーズ（要件 §3-2 で本 PoC は非スコープ）」と表示する無効化カードを詳細ページ末尾に置く。PoC 評価者にプロダクトの将来像（判定 → 文面生成 → フォーム営業）を見せる目的。生成ロジックは実装しない |

### D-3. 状態管理 — TanStack Query（2026-07-05 確定）

基本設計の初版では「fetch + setInterval」としていたが、ポーリング・キャッシュ無効化・mutation の要件に `@tanstack/react-query` がそのまま合い、素朴な実装よりバグが減るトレードオフを受け入れて**採用に確定**した（基本 §8 も更新済み）。

| hook / mutation | key | 実装要点 |
|---|---|---|
| `useAssessments()` | `["assessments"]` | `refetchInterval: (q) => q.state.data?.items.some(i => i.status === "running") ? 5000 : false` |
| `useAssessment(id)` | `["assessment", id]` | `refetchInterval: (q) => q.state.data?.status === "running" ? 5000 : false` — 完了で自動停止 |
| `createAssessment` | mutation | 成功時 `invalidateQueries(["assessments"])` |
| `saveHumanReview` | mutation | 成功時 `invalidateQueries(["assessment", id])` と `["assessments"]` |

ポーリング間隔は 5 秒固定（1 社数分のジョブに対して十分。サーバー負荷は無視できる）。グローバル store・context は作らない。

### D-4. ローディング中 UX（収集 + 判定は数分かかる想定）

- POST 直後に**即座に一覧へ running 行が現れる**（202 → invalidate）。ユーザーは待たずに次の企業を投入できる（ただし同一企業は 409）
- 詳細ページの running 表示は `RunningProgress`: ①stage ステッパー（現在段を強調）②経過時間（`createdAt` 起点、1 秒更新はせず再レンダー時のみで可）③時間がかかる理由の説明文（収集マナー由来であること）
- プログレスバー（% 表示）は**作らない** — 総所要時間が事前に見積もれないため、不正確なバーより stage 表示が誠実
- failed 時: `error` 全文 + どの stage で失敗したか + 「同じ入力で再実行」ボタン（`input` カラムの写しをそのまま POST → 新規 assessment）
- ブラウザを閉じても実行は継続する旨を running 画面に一文添える（in-process 実行。ただしサーバー再起動では失われる — 基本 §9 リスク 5）

---

## E. 評価用

### E-1. `poc-output/<sample-domain>/` をモック入力に使う手順（オフラインモード）

extract → judge を収集なし・DB なしで回すモード。プロンプト調整と judge 動作確認のイテレーションを高速化する（LLM 呼び出しのみ課金）。

```
# 前提: ANTHROPIC_API_KEY のみ必要（DB・crawler・docker 不要）
pnpm tsx packages/collector/src/scripts/assess-poc.ts --offline poc-output/<sample-domain>
```

動作仕様:

1. `<dir>/contents/*.md` を読み、各ファイル先頭の HTML コメントメタデータ（`source_type` / `url` / `fetched_at` 等 — `collect-poc.ts` が書き出す既存形式）をパースして `ContentSnippet[]` を作る
2. `<dir>/summary.json` から company（name / domain）を読む
3. `allowedUrls` = contents 内の URL 全件。careersCheck はダミー（`--careers-found <url>` / `--careers-none` フラグで注入可、省略時は「未確認」= minimumMet が偽）
4. `SignalExtractor.extract` → §C-5 の後処理 → `judge` を実行し、`<dir>/fit-judgement.json` と `fit-judgement.md` を書き出す（DB には書かない）
5. 標準出力に needLevel / 検出シグナル / evidence 破棄件数（droppedCount）・予算超過で落としたソース / トークン数を要約表示

**サンプルドメインの期待結果**: careers・求人媒体コンテンツが無いため `needLevel: "unknown"`（収集最低要件未達）。これ自体が判定行 1（§C-3）の動作確認になる。3-1（新サービスリリース）がプレスリリースから検出されるかがプロンプトの初回確認ポイント。

### E-2. 10 社評価シート（`docs/ui/fit-validation-results.csv` テンプレート）

要件 §8-4 の記録先。1 行 = 1 社（再評価時は行追加し assessment_id で区別）。

```csv
company_name,domain,human_need_level,human_labeled_at,ai_need_level,match,mismatch_reason,assessment_id,signals_version,prompt_version,duration_ms,input_tokens,output_tokens,notes
サンプル株式会社,example.co.jp,high,2026-07-08,high,TRUE,,a1b2c3d4-...,v0.2,v1,213000,41200,1800,1-1をWantedly掲載日から検出
```

| 列 | 記入者 / 規則 |
|---|---|
| `human_need_level`, `human_labeled_at` | 人間。**システム実行前に**記入（ブラインド — 要件 §8-2） |
| `ai_need_level`, `assessment_id`, `signals_version`, `prompt_version`, `duration_ms`, `*_tokens` | 判定完了後に UI / fit-judgement.json から転記 |
| `match` | `human = ai` なら TRUE。**ai が unknown の行は空欄**（S1 の分母から除外 — 要件 §2-2） |
| `mismatch_reason` | 不一致時のみ `collection_gap / extraction_error / rule_issue / private_info` |

集計（シート末尾 or 手計算）: **S1** = TRUE 数 ÷ (10 − unknown 数) ≥ 0.7、**S2** = human が low(逆指標) で ai が high の行 = 0、**S4** = unknown ≤ 3。S3 は fit-judgement.json の機械チェック（high/medium の全検出シグナルに evidence ≥ 1 — assess-poc.ts が出力時に検証してログを出す）。

---

## F. テスト方針

既存流儀に合わせ vitest。**LLM を実呼び出しするテストは CI に入れない**（オフラインモード §E-1 で手動確認）。

### F-1. ユニットテスト（決定的ロジック — 最優先）

| 対象 | ファイル | ケース |
|---|---|---|
| `need-judge` | `fit/need-judge.test.ts` | §C-3 の決定表**全 7 行** + 境界: ①strongJobs=1, counter=0 → high ②4-2 のみ → low ③strongJobs=1 + 4-2 → medium ④4-1 + strongJobs=3 → **low**（S2: counter 優先）⑤1-5 + weak×2 → low ⑥weak×2 → medium / weak×1 → low ⑦minimumMet=false + strongJobs=1 → **unknown**（行 1 が最優先）⑧2-1 や 3-1 の単独検出 → **low**（求人シグナルなし — 行 7）⑨3-1 + weak×2 → **medium**（strongOther は weak≥2 判定を妨げない — 行 6 が先）⑩insufficientHistory は detected 扱いしない ⑪rationale に検出 ID が含まれる |
| `evidence-filter` | `fit/evidence-filter.test.ts` | ①allowedUrls 外の evidence 破棄 + droppedCount ②全 evidence 破棄 → detected=false ③strength はカタログ値で上書き ④checkedAt 付与 ⑤URL 正規化差（末尾スラッシュ・utm）を同一視 |
| `merge-manual` | `fit/merge-manual.test.ts` | ①2-1 に manual evidence 追加 → detected=true ②既に detected のシグナルへは evidence 追記のみ ③allowedUrls 制約を受けない |
| `careers-probe` | `fit/careers-probe.test.ts` | adapter/robots/rateLimiter をモック。①HP リンク発見で既定パスを打たない ②既定パス順序 ③robots ブロックのスキップ + checkedUrls 注記 ④全滅 → foundUrl null + checkedUrls 全記録 |

### F-2. プロンプトの snapshot テスト

| 対象 | 内容 |
|---|---|
| `fit-prompt.test.ts` | 固定 fixture（サンプルドメインの contents から作った小さな `ExtractionInput`）で `buildFitSystemPrompt` / `buildFitUserMessage` の出力文字列を `toMatchSnapshot()`。**目的: 意図しないプロンプト変化の検知**。snapshot 更新を伴う PR では `PROMPT_VERSION` の bump を必須とする（レビュー規約として README に明記）。カタログ 14 件が全件レンダリングされること・引用可能 URL リストが入ることを個別 assert |

### F-3. 結合テスト（LLM・ネットワークはモック）

| 対象 | 内容 |
|---|---|
| `signal-extractor.test.ts` | Anthropic client をモック。①正常 tool_use → zod 通過 ②スキーマ不整合 → 1 回リトライ → 成功 ③リトライも失敗 → throw ④usage がコストに転記される |
| `server/routes/assessment.test.ts` | fastify `inject` + FitOrchestrator スタブ。①POST → 202 + DB 行 ②zod 400 ③重複 running → 409 ④GET ポーリング遷移（running → succeeded）⑤PATCH human-review（succeeded のみ 200、running は 409） |
| `fit-orchestrator.test.ts` | 全依存モック。①正常系で stage が collect→extract→judge→done と更新 ②extract で throw → status=failed + stage=extract ③1-5 プローブ上書き（§C-5-2）の統合確認 |

### F-4. やらないこと

- `packages/web` の自動テスト（PoC は手動確認。10 社評価 §E-2 が実質の E2E）
- LLM 実呼び出しの回帰テスト（出典捏造防止の検証はファーストスコープ外 — 要件 §11 の決定どおり）
- 既存 collector のテスト追加（無変更部分。`SourceEnumerator` の seedUrls 追加分のみ既存テストに 1 ケース足す）

---

## 実装チェックリスト（基本 §10 の粒度を本書のファイルに対応付け）

1. [ ] shared: `types/fit.ts` / `fit/signal-catalog.ts` / `schemas/fit.ts` / env 追加（§A, §B-2）
2. [ ] `0002_fit.sql` + docker-compose の init mount 追加（§B-1）
3. [ ] `need-judge.ts` + テスト（§C-3, §F-1）← 最初に固定
4. [ ] `evidence-filter.ts` / `merge-manual.ts` + テスト（§C-5, §F-1）
5. [ ] `fit-prompt.ts` + snapshot テスト（§C-2, §F-2）
6. [ ] `signal-extractor.ts` + モックテスト（§B-1, §F-3）
7. [ ] `careers-probe.ts` + `SourceEnumerator` seedUrls 対応 + テスト（§C-4-1）
8. [ ] `fit-assessment-repo.ts` / `fit-orchestrator.ts`（§C-6）
9. [ ] `scripts/assess-poc.ts`（--offline 含む）→ **ここでサンプルドメインのオフライン確認（§E-1）**
10. [ ] `server/routes/assessment.ts` + index.ts 配線 + markInterrupted（§A-4, §B-1）
11. [ ] `packages/web` 一式（§B-3, §D）
12. [ ] 10 社評価（§E-2 → `docs/ui/fit-validation-results.md` / `.csv`）


## プロンプト

```
@docs/ui/fit-validation-design.md と @docs/ui/fit-validation-requirements.md を前提に、
docs/ui/fit-validation-detailed-design.md を作成してください。
実装者がそのままコードを書ける粒度まで落としてください。

## 含めること
### A. 型・契約
- FitAssessment, Signal, Evidence, NeedLevel 等の TypeScript 型
- API request/response（OpenAPI 風の Markdown で可）
- LLM structured output の JSON スキーマ
### B. モジュール構成
- packages/collector への追加ファイル一覧（例: fit-scorer.ts, fit-prompt.ts）
- packages/web（新規）のディレクトリ構成
- @sa/shared に置く型
### C. Fit 判定ロジック
- シグナル定義表（requirements の判断材料と1:1対応）
- 各シグナルのプロンプト断片（system / user テンプレート）
- need_level の集約ルール（例: 強シグナル2つ以上 → high）
- 収集データ不足時の fallback
### D. UI 詳細
- ルート: /, /assessments/:id 等
- コンポーネント: CompanyInput, FitResult, SignalCard, OutreachDraft
- 状態管理（TanStack Query 等）
- ローディング中 UX（収集+判定は数分かかる想定）
### E. 評価用
- poc-output/<sample-domain>/ をモック入力に使う手順
- 10社評価シート（CSV テンプレ: 企業名, 人間判定, AI判定, メモ）
### F. テスト方針
- プロンプト出力の snapshot テスト
- 集約ロジックのユニットテスト

## 書かないこと
- 実際のソースコード（型定義の疑似コードまでは OK）
```