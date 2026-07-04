# データ収集 & キャッシュ基盤 — 詳細設計（Detailed Design）

- ステータス: ドラフト v1.0（`docs/collection-cache-design.md` v0.2 の実装レベル具体化）
- 作成日: 2026-07-04
- 前提: `docs/collection-cache-design.md`（基本設計）/ `docs/product-concept.md`（コンセプト）を確定要件源とする。本書はコードを書き始められる粒度まで落とす。
- 対象読者: 実装エンジニア。TS strict / Node ESM / pnpm、Python(FastAPI)、PostgreSQL+pgvector。

本書の SQL / TypeScript / Python はそのまま雛形として使える粒度で記述する。ロック済み決定（オンデマンド中心+蓄積キャッシュ、収集時 LLM 禁止、Gate0..4、vector(1536) 固定+アダプタ、`CONCURRENT_CRAWL_LIMIT`、著作権法30条の4、単一 `scraped_contents`、p-limit→pg-boss→BullMQ 経路）をそのまま反映する。

---

## 1. モジュール / ファイル構成

### 1.1 pnpm workspace ルート

```
sales-analytics/
├─ pnpm-workspace.yaml            # packages/*, services/* (Python は非 workspace)
├─ package.json                   # root scripts (typecheck/lint/build), engines
├─ tsconfig.base.json             # strict, ESM, moduleResolution: NodeNext
├─ .env.example                   # §1.3 の全 env を列挙（実 .env は git 管理外）
├─ docker-compose.yml             # postgres(pgvector), crawler, (dev) app
├─ packages/
│  ├─ collector/                  # TS 本体: 収集・キャッシュ・決定木
│  └─ shared/                     # 型・zod スキーマ・env ローダの共有
└─ services/
   └─ crawler/                    # Python: FastAPI + Crawl4AI（別プロセス/別コンテナ）
```

### 1.2 各モジュールと一行責務

#### `packages/shared/src/`（TS 横断・依存無しの純データ層）

| ファイル | 責務 |
|---|---|
| `env.ts` | `.env` を zod で検証し型付き `Env` を単一エクスポート（起動時 fail-fast）|
| `types/domain.ts` | `Company` `Source` `ScrapedContent` `SourceType` `SourceKind` の TS 型 |
| `types/fetch.ts` | `FetchJob` `FetchResult` `FetchMethod` `Gate` 列挙 |
| `types/crawler-contract.ts` | crawler HTTP 契約の request/response 型（§5 と一致）|
| `schemas/crawler.ts` | 上記契約の zod スキーマ（TS/実行時両方で検証）|
| `logger.ts` | pino ロガー生成（構造化ログ、fetch_log とは別の運用ログ）|

#### `packages/collector/src/`（TS 本体）

| ファイル | 責務 |
|---|---|
| `index.ts` | Fastify 起動・ルート登録・DI 組み立て・graceful shutdown |
| `server/routes/dossier.ts` | `POST /dossiers` カルテ要求エンドポイント（§6 の入口）|
| `server/routes/health.ts` | `GET /healthz`（DB / crawler 到達性チェック）|
| `orchestrator/dossier-orchestrator.ts` | カルテ要求の end-to-end 統括（company 解決→source 列挙→gate→Claude）|
| `orchestrator/fetch-planner.ts` | **決定木の中枢**。Gate0..Gate4 を実装（§4）|
| `orchestrator/freshness-judge.ts` | TTL / stale_after 判定（Gate0）|
| `orchestrator/source-enumerator.ts` | company の `sources` を列挙し取得計画に落とす |
| `adapters/source-adapter.ts` | `SourceAdapter` インターフェース定義（§3）|
| `adapters/rss.ts` | RSS/Atom 取得+パース（Gate1）|
| `adapters/sitemap.ts` | sitemap.xml 取得+パース（Gate1）|
| `adapters/conditional-get.ts` | ETag/Last-Modified 条件付き GET（Gate2）|
| `adapters/crawl4ai.ts` | Python crawler を叩く HTTP クライアント（Gate3）|
| `adapters/managed-crawl.ts` | Firecrawl 等マネージド API（Gate4, 既定 OFF, opt-in）|
| `queue/queue.ts` | `Queue` インターフェース + `enqueueFetch(job)`（差し替え点）|
| `queue/in-process-queue.ts` | p-limit 実装（MVP）。inflight dedup 内蔵 |
| `embedding/embedding-provider.ts` | `EmbeddingProvider` アダプタ interface（§3/§8）|
| `embedding/providers/voyage.ts` | Voyage 実装 |
| `embedding/providers/openai.ts` | OpenAI 実装（1536→そのまま / 他次元は projection）|
| `embedding/provider-factory.ts` | `EMBEDDING_PROVIDER` で実装選択 |
| `embedding/chunker.ts` | Markdown H2/H3 チャンカ（~800-1000 tok, ~100 overlap）|
| `embedding/embed-pipeline.ts` | store 時 async embed + chunk hash スキップ |
| `storage/db.ts` | pg Pool 生成・トランザクションヘルパ |
| `storage/schema.sql` | §2 の DDL 完全版（migration 0001）|
| `storage/migrations/` | 追加マイグレーション（node-pg-migrate 等）|
| `storage/repositories/company-repo.ts` | companies CRUD + domain 解決 |
| `storage/repositories/source-repo.ts` | sources CRUD + ETag/stale 更新 |
| `storage/repositories/scraped-content-repo.ts` | scraped_contents upsert（dedup 込み）|
| `storage/repositories/embedding-repo.ts` | embeddings upsert + HNSW 検索 |
| `storage/repositories/fetch-log-repo.ts` | fetch_log 追記（監査/コスト/法務）|
| `storage/repositories/policy-repo.ts` | source_freshness_policy 読み出し（キャッシュ）|
| `compliance/robots.ts` | robots.txt 取得・キャッシュ・allow 判定 |
| `compliance/rate-limiter.ts` | ドメイン単位トークンバケット（Crawl-delay 反映）|
| `compliance/url-canonical.ts` | URL 正規化 + content_hash 計算（§4）|
| `cron/freshness-poller.ts` | node-cron 軽量鮮度巡回（§7）|
| `claude/dossier-generator.ts` | Claude API 呼び出し（構造化+カルテ生成, 出典付き）|
| `claude/prompt.ts` | カルテ生成プロンプト組み立て（RAG コンテキスト整形）|

#### `services/crawler/`（Python）

| ファイル | 責務 |
|---|---|
| `main.py` | FastAPI アプリ・ルート（`POST /crawl`, `GET /healthz`）|
| `crawler.py` | Crawl4AI ラッパ（render モード、resource block、md 抽出）|
| `resource_block.py` | Playwright `page.route` で image/css/font/media を abort |
| `robots.py` | `respect_robots` 二重チェック（多層防御）|
| `schemas.py` | pydantic request/response（§5 と一致）|
| `settings.py` | env（timeout 既定、UA、同時実行）|
| `pyproject.toml` / `requirements.txt` | crawl4ai, fastapi, uvicorn, playwright |
| `Dockerfile` | Playwright 依存込みイメージ |

### 1.3 `.env` 変数一覧（`.env.example`）

```dotenv
# --- DB ---
DATABASE_URL=postgres://app:app@localhost:5432/sales_analytics
DB_POOL_MAX=10

# --- Crawler service ---
CRAWLER_BASE_URL=http://localhost:8000
CONCURRENT_CRAWL_LIMIT=4          # Playwright 同時プロセス上限（4GB VPS 安全域）。§4/§6/§9
CRAWL_TIMEOUT_MS=30000            # 1 クロールのハード上限
CRAWL_CONNECT_TIMEOUT_MS=5000
LIGHT_HTTP_TIMEOUT_MS=10000       # RSS/sitemap/conditional-GET の軽量 HTTP timeout
FETCH_MAX_RETRIES=2               # crawler 呼び出しのリトライ回数
FETCH_RETRY_BASE_MS=500           # 指数バックオフ基数

# --- Compliance ---
USER_AGENT="SalesAnalyticsBot/0.1 (+https://example.com/bot; contact: bot@example.com)"
CONTACT_EMAIL=bot@example.com
ROBOTS_CACHE_TTL_SEC=86400        # robots.txt キャッシュ TTL
DEFAULT_CRAWL_DELAY_MS=2000       # robots に Crawl-delay 無い場合の自主レート
DOMAIN_MAX_CONCURRENCY=1          # 同一ドメイン同時接続上限

# --- Embedding ---
EMBEDDING_PROVIDER=voyage         # voyage | openai （アダプタ選択）
EMBEDDING_MODEL=voyage-3          # プロバイダ内モデル
EMBEDDING_DIM=1536                # スキーマ固定次元（不一致は truncation/projection）
VOYAGE_API_KEY=
OPENAI_API_KEY=
EMBED_BATCH_SIZE=64
EMBED_CONCURRENCY=2

# --- Managed crawl fallback (Gate4) ---
MANAGED_CRAWL_ENABLED=false       # 既定 OFF。opt-in の最終手段。超過分従量はユーザー負担
MANAGED_CRAWL_PROVIDER=firecrawl
FIRECRAWL_API_KEY=

# --- Claude (カルテ生成時のみ) ---
ANTHROPIC_API_KEY=
DOSSIER_MODEL=claude-opus-4-8
DOSSIER_MAX_CONTEXT_TOKENS=180000

# --- Freshness cron ---
FRESHNESS_POLL_CRON="0 */6 * * *" # 6h ごと（§7）。ソース別間隔は policy テーブルで上書き
FRESHNESS_POLL_ENABLED=true
```

Python 側 `services/crawler/settings.py` は `CRAWLER_PORT`, `CRAWL_TIMEOUT_MS`, `USER_AGENT`, `CRAWLER_MAX_CONCURRENCY`（= app 側 `CONCURRENT_CRAWL_LIMIT` と揃える）を読む。

---

## 2. DDL 完全版

`storage/schema.sql`（migration `0001_init.sql`）。PostgreSQL 15+ / pgvector 0.7+ 前提。

```sql
-- ========== 拡張 ==========
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector（embeddings 用）
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ========== 列挙型 ==========
-- 保存本体のポリモーフィック種別。additive-only（将来 x_post|note_article を ADD VALUE するだけ）
CREATE TYPE source_type AS ENUM ('corporate_hp', 'press_release');

-- 収集口の種別（sources 側）。取得戦略・鮮度をこの kind 単位で切り替える
CREATE TYPE source_kind AS ENUM ('corporate_hp', 'careers', 'press_feed', 'news_feed');

-- 実際に本文を取得した手段（監査・コスト分析用）
CREATE TYPE fetch_method AS ENUM (
  'cache_hit',        -- Gate0
  'rss', 'sitemap',   -- Gate1
  'conditional_get',  -- Gate2 (200)
  'not_modified',     -- Gate2 (304)
  'crawl4ai',         -- Gate3
  'managed_api'       -- Gate4
);

-- ========== companies ==========
-- domain を canonical キーにする（誤ドメインは全収集を汚染するため一意制約で守る）
CREATE TABLE companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  domain       text NOT NULL,                 -- 正規化済みホスト（例: example.co.jp）
  aliases      text[] NOT NULL DEFAULT '{}',  -- 表記ゆれ・旧社名
  corp_number  text,                          -- 法人番号（任意, 13桁）
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_domain_key UNIQUE (domain)
);
COMMENT ON COLUMN companies.domain IS 'canonical 収集キー。small-caps 正規化・www 除去済み';

-- ========== sources ==========
-- 企業ごとの収集口。ETag 等の条件付き GET 状態と robots 情報を保持
CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           source_kind NOT NULL,
  url            text NOT NULL,                -- 登録時 URL（生）
  canonical_url  text NOT NULL,               -- 正規化 URL（一意キー）
  feed_kind      text,                        -- 'rss' | 'atom' | 'sitemap' | null(=HTML)
  etag           text,                        -- 条件付き GET 用
  last_modified  text,                        -- 条件付き GET 用（HTTP-date 文字列）
  robots_allowed boolean NOT NULL DEFAULT true,
  crawl_delay_ms integer,                     -- robots 由来 / null は既定値
  last_polled_at timestamptz,                 -- 最終巡回（Gate1/Gate2 の実行時刻）
  stale_after    timestamptz,                 -- これ以降は鮮度切れ（Gate0 判定に使用）
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_company_canonical_key UNIQUE (company_id, canonical_url)
);
CREATE INDEX sources_company_idx ON sources (company_id);
CREATE INDEX sources_poll_idx ON sources (kind, last_polled_at) WHERE enabled;

-- ========== scraped_contents（ポリモーフィック本体・単一テーブル）==========
-- HP もプレスも 1 テーブルに source_type で格納。プレス固有列(guid, published_at)は nullable
CREATE TABLE scraped_contents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_type   source_type NOT NULL,
  url           text NOT NULL,
  canonical_url text NOT NULL,
  title         text,
  content_md    text NOT NULL,                -- 生 Markdown（収集時 LLM 構造化しない）
  content_hash  bytea NOT NULL,              -- 正規化テキストの SHA-256（32 bytes）
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  fetch_method  fetch_method NOT NULL,
  http_status   integer,
  byte_size     integer,
  -- プレス固有（source_type='press_release' 時のみ充填）
  guid          text,                         -- RSS guid / 記事一意 ID
  published_at  timestamptz,
  -- 更新系列（新版が旧版を supersede）
  supersedes    uuid REFERENCES scraped_contents(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 同一 URL・同一内容の再保存を防ぐ（content_hash 込み dedup）
  CONSTRAINT scraped_contents_dedup_key UNIQUE (company_id, canonical_url, content_hash)
);
-- プレスの guid 一意化は「press_release のときだけ」効く部分ユニークインデックス
CREATE UNIQUE INDEX scraped_contents_press_guid_uidx
  ON scraped_contents (company_id, guid)
  WHERE source_type = 'press_release' AND guid IS NOT NULL;
CREATE INDEX scraped_contents_company_type_idx
  ON scraped_contents (company_id, source_type, fetched_at DESC);
COMMENT ON COLUMN scraped_contents.content_md IS
  '生 Markdown を蓄積。著作権法30条の4（情報解析目的の複製）を根拠に保持';

-- ========== fetch_log（監査 / コスト計測 / 法務エビデンス）==========
CREATE TABLE fetch_log (
  id            bigserial PRIMARY KEY,
  source_id     uuid REFERENCES sources(id) ON DELETE SET NULL,
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  gate          smallint,                     -- 0..4（どのゲートで解決したか）
  method        fetch_method NOT NULL,
  http_status   integer,
  bytes         integer,
  duration_ms   integer,
  cache_hit     boolean NOT NULL DEFAULT false,
  robots_blocked boolean NOT NULL DEFAULT false,
  cost_note     text,                         -- 'managed_api:firecrawl $0.003' 等
  legal_basis   text NOT NULL DEFAULT 'jp_copyright_art30_4', -- 法務エビデンス（§10）
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fetch_log_company_time_idx ON fetch_log (company_id, requested_at DESC);
CREATE INDEX fetch_log_method_idx ON fetch_log (method, requested_at DESC);

-- ========== embeddings（隔離テーブル・移送しやすく）==========
-- vector(1536) 固定。プロバイダはアダプタで差し替え可、DB インデックス再構築不要
CREATE TABLE embeddings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id   uuid NOT NULL REFERENCES scraped_contents(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  chunk_text   text NOT NULL,
  content_hash bytea NOT NULL,               -- チャンク単位 SHA-256（未変更は再 embed 回避）
  source_url   text NOT NULL,                -- 出典追跡（カルテの引用元）
  embedding    vector(1536) NOT NULL,        -- 固定次元
  model        text NOT NULL,                -- 'voyage-3' 等（監査・再現性）
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embeddings_content_chunk_key UNIQUE (content_id, chunk_index)
);
-- HNSW cosine インデックス（数十万 chunk まで実用）
CREATE INDEX embeddings_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX embeddings_company_idx ON embeddings (company_id);
CREATE INDEX embeddings_chunk_hash_idx ON embeddings (content_hash);

-- ========== source_freshness_policy（鮮度ポリシー設定テーブル）==========
-- コードにハードコードせず source_kind 別にチューニング可能にする
CREATE TABLE source_freshness_policy (
  source_kind          source_kind PRIMARY KEY,
  feed_poll_interval_s integer NOT NULL,   -- フィード巡回間隔（Gate1）
  body_ttl_s           integer,           -- 本文 TTL（null=無期限, プレス本文は不変）
  html_ttl_s           integer NOT NULL,  -- HP ページ TTL（Gate0/Gate2 判定）
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- 初期値（基本設計 §3 の目安: 会社概要~30d, 採用~7d, フィード 6-24h）
INSERT INTO source_freshness_policy
  (source_kind, feed_poll_interval_s, body_ttl_s, html_ttl_s) VALUES
  ('corporate_hp', 0,      NULL, 2592000),  -- HTML 30d
  ('careers',      0,      NULL, 604800),   -- HTML 7d
  ('press_feed',   21600,  NULL, 86400),    -- 巡回 6h / 本文無期限 / 一覧 24h
  ('news_feed',    43200,  NULL, 86400);    -- 巡回 12h
```

補足:
- `content_hash` は `bytea`（32 byte）。JS 側は `Buffer`。文字列比較より安定。
- 将来 `source_type` 追加は `ALTER TYPE source_type ADD VALUE 'x_post';`（additive-only、既存壊さない）。
- HNSW の `m`/`ef_construction` は初期値。検索時は `SET hnsw.ef_search = 40;` をセッションで調整。

---

## 3. TypeScript 型定義 & 主要インターフェース

`packages/shared/src/types/*` と `packages/collector/src/**`。すべて `strict` + `exactOptionalPropertyTypes` 前提。シグネチャ中心。

```typescript
// types/domain.ts
export type SourceType = 'corporate_hp' | 'press_release'; // additive-only
export type SourceKind = 'corporate_hp' | 'careers' | 'press_feed' | 'news_feed';
export type FetchMethod =
  | 'cache_hit' | 'rss' | 'sitemap'
  | 'conditional_get' | 'not_modified' | 'crawl4ai' | 'managed_api';

export interface Company {
  id: string;
  name: string;
  domain: string;               // canonical host
  aliases: string[];
  corpNumber?: string;
}

export interface Source {
  id: string;
  companyId: string;
  kind: SourceKind;
  url: string;
  canonicalUrl: string;
  feedKind?: 'rss' | 'atom' | 'sitemap';
  etag?: string;
  lastModified?: string;
  robotsAllowed: boolean;
  crawlDelayMs?: number;
  lastPolledAt?: Date;
  staleAfter?: Date;
  enabled: boolean;
}

export interface ScrapedContent {
  id: string;
  companyId: string;
  sourceId: string;
  sourceType: SourceType;
  url: string;
  canonicalUrl: string;
  title?: string;
  contentMd: string;
  contentHash: Buffer;          // SHA-256, 32 bytes
  fetchedAt: Date;
  fetchMethod: FetchMethod;
  httpStatus?: number;
  byteSize?: number;
  guid?: string;                // press_release のみ
  publishedAt?: Date;           // press_release のみ
  supersedes?: string;
}
```

```typescript
// types/fetch.ts
export type Gate = 0 | 1 | 2 | 3 | 4;

/** 冪等キー = (sourceId, canonicalUrl)。inflight dedup の合流キーにもなる */
export interface FetchJob {
  idempotencyKey: string;       // `${sourceId}:${canonicalUrl}`
  companyId: string;
  sourceId: string;
  sourceType: SourceType;
  url: string;
  canonicalUrl: string;
  kind: SourceKind;
  /** 本文が必要か。false ならフィード巡回（見出し/URL のみ）。§7 */
  needBody: boolean;
  /** Gate4 マネージド API を許可するか（既定 false, opt-in）*/
  allowManaged?: boolean;
  renderHint?: 'auto' | 'static' | 'js';
}

export interface FetchResult {
  job: FetchJob;
  gate: Gate;                   // どのゲートで解決したか
  method: FetchMethod;
  outcome: 'stored' | 'not_modified' | 'unchanged' | 'blocked' | 'skipped' | 'error';
  contentId?: string;          // scraped_contents.id（保存時）
  httpStatus?: number;
  byteSize?: number;
  robotsBlocked?: boolean;
  error?: { code: string; message: string };
}
```

```typescript
// adapters/source-adapter.ts
export interface AdapterContext {
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Gate1: フィード内の新着エントリ（本文は取らない） */
export interface FeedEntry {
  guid?: string;
  url: string;
  title?: string;
  publishedAt?: Date;
  summaryMd?: string;          // RSS summary で足りる場合の本文代替
}

export interface ConditionalGetResult {
  status: 200 | 304 | number;
  etag?: string;
  lastModified?: string;
  bodyMd?: string;             // 200 のとき（静的で軽い場合はここで完結）
  byteSize?: number;
}

/** 各 Gate のアダプタ契約 */
export interface RssAdapter {
  fetchFeed(feedUrl: string, ctx: AdapterContext): Promise<FeedEntry[]>;
}
export interface SitemapAdapter {
  fetchSitemap(sitemapUrl: string, ctx: AdapterContext): Promise<FeedEntry[]>;
}
export interface ConditionalGetAdapter {
  fetch(
    url: string,
    prev: { etag?: string; lastModified?: string },
    ctx: AdapterContext,
  ): Promise<ConditionalGetResult>;
}
export interface Crawl4aiAdapter {
  crawl(req: CrawlRequest, ctx: AdapterContext): Promise<CrawlResponse>; // §5 型
}
export interface ManagedCrawlAdapter {
  enabled: boolean;
  crawl(url: string, ctx: AdapterContext): Promise<CrawlResponse>;
}
```

```typescript
// embedding/embedding-provider.ts
/** アダプタ: プロバイダを差し替えても DB は vector(1536) 固定のまま */
export interface EmbeddingProvider {
  readonly model: string;
  readonly nativeDim: number;  // 例: voyage-3=1024, openai-3-large=3072
  /** 返却は常に 1536 次元に正規化（truncation/projection 適用済み）*/
  embed(texts: string[]): Promise<Float32Array[]>; // each length === 1536
}
```

```typescript
// queue/queue.ts
/** 差し替え点: in-process(p-limit) → pg-boss → BullMQ。呼び出し側はこの型のみ依存 */
export interface Queue {
  /** 冪等キーで inflight を合流。同一ジョブの二重フェッチを防ぐ */
  enqueueFetch(job: FetchJob): Promise<FetchResult>;
  /** 待機中/実行中の件数（バックプレッシャ観測用）*/
  size(): { pending: number; active: number };
  shutdown(): Promise<void>;
}
```

```typescript
// storage/repositories（主要シグネチャのみ）
export interface ScrapedContentRepo {
  /** dedup: (company, canonical_url, content_hash) 既存なら unchanged で返す */
  upsert(c: Omit<ScrapedContent, 'id'>): Promise<{ id: string; inserted: boolean }>;
  latestByCompany(companyId: string, types: SourceType[], limit: number): Promise<ScrapedContent[]>;
}
export interface EmbeddingRepo {
  existingHashes(contentId: string): Promise<Set<string>>; // 再 embed スキップ判定
  upsertChunks(rows: EmbeddingRow[]): Promise<void>;
  search(companyId: string, queryVec: Float32Array, k: number): Promise<EmbeddingHit[]>;
}
export interface PolicyRepo {
  get(kind: SourceKind): Promise<FreshnessPolicy>; // メモリキャッシュ
}
```

---

## 4. 取得決定木の詳細アルゴリズム（Fetch Planner）

`orchestrator/fetch-planner.ts`。入力 `FetchJob`、出力 `FetchResult`。**上ほど安い手段。足りたら降りない**。

### 4.1 URL 正規化（`compliance/url-canonical.ts`）

```
canonicalize(rawUrl):
  1. URL パース（不正なら error）
  2. scheme を小文字化。http→https に寄せる（ホスト実在確認は行わない）
  3. host を小文字化。先頭 "www." を除去
  4. デフォルトポート(80/443)を除去
  5. path 末尾スラッシュを統一（"/" 単体以外は末尾 "/" を除去）
  6. query から utm_*, gclid, fbclid, ref, ref_src を除去し、残りをキー昇順ソート
  7. fragment(#...) を除去
  8. 正規化文字列を返す → sources.canonical_url / scraped_contents.canonical_url
```

### 4.2 content_hash（保存 dedup 用）

```
contentHash(markdown):
  1. Markdown を正規化テキスト化: CRLF→LF、連続空白の畳み込み、
     行頭末尾 trim、末尾改行除去（軽微な差分でハッシュが変わらないように）
  2. SHA-256(utf8) → 32byte Buffer を返す
```

### 4.3 Planner 本体（Gate0..Gate4）

```
plan(job): FetchResult
  source = sourceRepo.get(job.sourceId)
  policy = policyRepo.get(job.kind)
  t0 = now()

  # ---- 前提: robots + レート（§10）----
  if not robots.isAllowed(job.canonicalUrl, USER_AGENT):
      log(gate=null, robots_blocked); return { outcome:'blocked', robotsBlocked:true }
  await rateLimiter.acquire(host(job.canonicalUrl))   # token-bucket, Crawl-delay 反映

  # ================= Gate 0: キャッシュ命中 & 鮮度 =================
  latest = scrapedRepo.latestForSource(source.id)     # 最新版 1 件
  if latest and freshnessJudge.isFresh(source, latest, policy):
      log(gate=0, method='cache_hit', cache_hit=true)
      return { gate:0, method:'cache_hit', outcome:'skipped', contentId: latest.id }
  # isFresh: press本文=無期限true / HP= now < (fetched_at + html_ttl) かつ source.stale_after 未超過

  # フィード種別なら本文取得の前に新着だけ取る
  # ================= Gate 1: RSS/Atom/sitemap =================
  if source.feedKind in ('rss','atom','sitemap'):
      entries = source.feedKind=='sitemap'
                  ? sitemap.fetchSitemap(source.url, ctx)
                  : rss.fetchFeed(source.url, ctx)     # 軽量 HTTP 数KB
      source.lastPolledAt = now(); source.staleAfter = now()+policy.feed_poll_interval
      newEntries = entries where guid ∉ existing scraped guids (company scope)
      upsert 新着メタ（guid,url,title,published_at, summaryMd を content_md 代替）  # §7
      if not job.needBody:
          log(gate=1, method='rss', bytes=feedBytes)
          return { gate:1, method:'rss', outcome:'stored' }   # 本文は遅延
      # 本文が必要な新着だけを個別 URL として Gate2/3 に降ろす（再帰的に plan）
      results = [ plan(childJob(entry)) for entry in newEntries requiring body ]
      return aggregate(results)

  # ================= Gate 2: 条件付き GET =================
  cg = conditionalGet.fetch(source.url,
                            { etag: source.etag, lastModified: source.lastModified }, ctx)
  if cg.status == 304:
      source.staleAfter = now() + policy.html_ttl        # 鮮度延長のみ、帯域0
      log(gate=2, method='not_modified', http_status=304)
      return { gate:2, method:'not_modified', outcome:'not_modified', contentId: latest?.id }

  if cg.status == 200 and cg.bodyMd and isStaticEnough(cg):
      # 静的で軽い（JS 依存の痕跡が無い）→ ここで完結、Crawl4AI に進まない
      source.etag = cg.etag; source.lastModified = cg.lastModified
      source.staleAfter = now() + policy.html_ttl
      return storeAndEmbed(job, cg.bodyMd, method='conditional_get', gate=2, status=200)

  # ================= Gate 3: Crawl4AI（JSレンダ/構造抽出必要）=================
  # 到達条件: 200 だが JS 依存で本文取れない / SPA / conditional-get が本文欠落
  slot = await crawlSemaphore.acquire()   # p-limit(CONCURRENT_CRAWL_LIMIT) §6/§9
  try:
      resp = crawl4ai.crawl({
        url: source.url, render: job.renderHint ?? 'auto',
        block_resources: ['image','stylesheet','font','media'],
        timeout_ms: CRAWL_TIMEOUT_MS, respect_robots: true }, ctx)
  finally: slot.release()
  if resp.robots_blocked:
      log(gate=3, robots_blocked); return { outcome:'blocked', robotsBlocked:true }
  if resp.status == 200 and resp.markdown:
      source.staleAfter = now() + policy.html_ttl
      return storeAndEmbed(job, resp.markdown, method='crawl4ai', gate=3, status=200)

  # ================= Gate 4: アンチボット強（PR TIMES 等）=================
  # 基本は Gate1 の公式 RSS/API で捕捉済み。ここに来るのは本文がどうしても要る例外
  if managedCrawl.enabled and job.allowManaged:     # opt-in, 既定 OFF
      resp = managedCrawl.crawl(source.url, ctx)     # 従量課金 → ユーザー負担
      log(gate=4, method='managed_api', cost_note=`managed:${provider}`)
      if resp.status==200 and resp.markdown:
          return storeAndEmbed(job, resp.markdown, method='managed_api', gate=4, status=200)
  # opt-in 無効 or 失敗 → 取得断念（部分失敗として上位に返す, §9）
  return { gate:4, method:'managed_api', outcome:'skipped',
           error:{code:'managed_disabled', message:'anti-bot, managed API opt-in required'} }
```

`storeAndEmbed`:
```
storeAndEmbed(job, md, method, gate, status):
  hash = contentHash(md)
  { id, inserted } = scrapedRepo.upsert({...job, content_md:md, content_hash:hash,
                                          fetch_method:method, http_status:status, ...})
  log(gate, method, bytes=len(md), http_status=status, duration_ms=now()-t0)
  if inserted: queue.enqueueEmbed(id)   # store 時 async embed（レイテンシから外す, §8）
  return { gate, method, outcome: inserted?'stored':'unchanged', contentId:id }
```

**エスカレーション条件（要点）**
- Gate2→Gate3: `200 && (bodyMd 欠落 || JS レンダ痕跡 <div id="__next"> 等 || content_md が極端に短い)`。
- Gate3→Gate4: `crawl4ai が 403/429/チャレンジ で本文取れず`、かつ `allowManaged=true && MANAGED_CRAWL_ENABLED=true`。それ以外は断念（コスト最優先）。
- press_feed は原則 Gate1 で完結。PR TIMES は公式 RSS で捕捉するため Gate4 に落ちない設計。

---

## 5. Crawler HTTP 契約（完全）

`services/crawler/`。TS 本体 → Python の契約は **URL(+ヒント) → Markdown** に限定（実装隠蔽）。

### 5.1 `POST /crawl`

Request (`application/json`):
```jsonc
{
  "url": "https://example.co.jp/news/2026/07",   // 必須
  "render": "auto",                               // "auto"|"static"|"js" 既定 auto
  "extraction_hint": "article",                   // 任意: 抽出セレクタヒント
  "block_resources": ["image","stylesheet","font","media"], // 既定 ON
  "timeout_ms": 30000,                            // 上限 CRAWL_TIMEOUT_MS
  "respect_robots": true                          // 多層防御。既定 true
}
```
Response 200 (`application/json`):
```jsonc
{
  "final_url": "https://example.co.jp/news/2026/07",
  "status": 200,                                  // 上流 HTTP ステータス
  "markdown": "# ...\n",                          // 抽出済み Markdown
  "meta": {
    "title": "ニュース | Example",
    "fetched_at": "2026-07-04T09:00:00Z",
    "byte_size": 18342,
    "rendered": true                              // JS レンダ実行したか
  },
  "robots_blocked": false,
  "error": null
}
```
robots ブロック時 (HTTP 200, ボディで表現):
```jsonc
{ "final_url":"...", "status":0, "markdown":"", "meta":{},
  "robots_blocked": true, "error": null }
```
エラー時の対応表:

| HTTP | error.code | 意味 | TS 側の扱い |
|---|---|---|---|
| 400 | `bad_request` | url 不正 / スキーマ違反 | リトライ不可、即失敗 |
| 422 | `validation_error` | pydantic 検証 | リトライ不可 |
| 200 | (body) `robots_blocked=true` | robots 不許可 | blocked、リトライ不可 |
| 504 | `timeout` | `timeout_ms` 超過 | リトライ対象（§9）|
| 502 | `upstream_error` | 上流 5xx/接続失敗 | リトライ対象 |
| 429 | `upstream_rate_limited` | 上流 429/チャレンジ | Gate4 エスカレ判定へ |
| 500 | `crawler_error` | Crawl4AI 内部例外 | リトライ 1 回 |

error body 形:
```jsonc
{ "final_url": null, "status": 504, "markdown": "", "meta": null,
  "robots_blocked": false, "error": { "code": "timeout", "message": "exceeded 30000ms" } }
```

### 5.2 `GET /healthz`

Response 200: `{ "status": "ok", "playwright": "ready", "version": "0.1.0" }`
起動直後 Playwright 未初期化なら 503 `{ "status": "starting" }`。

### 5.3 timeout / retry ポリシー

- crawler 内: `timeout_ms`（既定 `CRAWL_TIMEOUT_MS=30000`）で Playwright `page.goto` にハード上限。connect 5s。
- crawler 自身はリトライしない（ステートレス取得器）。**リトライは TS 側 planner が担う**（§9）。
- 同時実行は TS 側 `CONCURRENT_CRAWL_LIMIT` で絞るのが一次防御。crawler 側も `CRAWLER_MAX_CONCURRENCY`（= 同値）で二次防御。

### 5.4 Playwright リソースブロック実装ノート（`resource_block.py`）

```python
# crawl4ai の BrowserConfig / page フックで route を張る
BLOCK = {"image", "stylesheet", "font", "media"}
async def install_block(page):
    async def _route(route):
        if route.request.resource_type in BLOCK:
            await route.abort()          # 画像/CSS/font/media は落とす → 帯域大幅減
        else:
            await route.continue_()
    await page.route("**/*", _route)
```
- 既定 ON（`block_resources` 既定値）。TS が明示的に空配列を渡した時のみ全取得。
- `render:"static"` の場合は Playwright を使わず httpx で素取得 → md 変換（軽量パス）。`"js"` は必ずレンダ。`"auto"` は静的取得を試み、本文が薄ければレンダにフォールバック。

---

## 6. オンデマンド・カルテ要求のシーケンス

`POST /dossiers { companyNameOrUrl, allowManaged?, selfProduct? }` → `dossier-orchestrator.ts`。

```
 1. 受信・検証: zod で入力検証。requestId 採番。
 2. company 解決（company-repo）:
      - URL 入力: canonicalize→domain 抽出→companies UPSERT（domain 一意）
      - 企業名入力: aliases/ name 一致検索。無ければ「要ドメイン確定」で 409 を返す
        （誤ドメインは全収集を汚染するため自動推測しない。残課題#6 の運用判断）
 3. source 列挙（source-enumerator）:
      - 既存 sources を取得。無ければ最小ソースを bootstrap:
          corporate_hp (=domain root), careers (/careers 等の推定 or sitemap 由来),
          press_feed (RSS/Atom 発見: /feed, /rss, <link rel=alternate>, sitemap)
      - robots.txt を取得・キャッシュ（§10）。各 source の robots_allowed/crawl_delay を確定
 4. 取得計画: 各 source を FetchJob 化。
      - press_feed: needBody=true（カルテには最近の動きが要る）。ただし直近 N 件のみ本文
      - corporate_hp/careers: needBody=true, renderHint='auto'
      - allowManaged はリクエスト値を各 job に伝播（Gate4 opt-in）
 5. ゲート実行（並行, ただし上限あり）:
      - queue.enqueueFetch(job) を Promise.allSettled で並行投入
      - Gate3(Crawl4AI) に到達する job は p-limit(CONCURRENT_CRAWL_LIMIT=4) で直列化
        → 4GB VPS でも Chromium 同時 4 プロセスに制限（§9）
      - inflight dedup: 同一 idempotencyKey は既存 Promise に合流（二重フェッチ回避）
 6. 部分失敗の許容: allSettled の結果を集約。blocked/skipped/error は
      その旨をカルテに注記（「PR TIMES 本文は未取得: 公式 RSS 要約で代替」等）
 7. RAG コンテキスト組み立て（claude/prompt.ts）:
      - 取得できた scraped_contents の生 Markdown を収集
      - 量が多い場合は embeddings.search(company, queryVec, k) で関連 chunk 抽出
        → DOSSIER_MAX_CONTEXT_TOKENS 以内に収める。各 chunk に source_url を必ず添付
 8. Claude API 構造化 + カルテ生成（dossier-generator）:
      - ここで初めて LLM 課金（収集時は回さない）
      - コンセプト §3 の 7 構成（事業サマリ/攻め筋/フック/キーパーソン/競合/文面案/出典）
      - selfProduct（自社プロダクト情報）× カルテで文面案をパーソナライズ
      - 出力は「全記述に出典 source_url を紐づける」制約（ハルシネーション対策）
 9. 永続化: 生成カルテ + 引用（citations: chunk→source_url）を保存。requestId で参照可能に
10. 応答: カルテ JSON（出典リンク付き）+ 未取得ソースの注記を返す
```

`CONCURRENT_CRAWL_LIMIT` が効くのは **ステップ5 の Gate3 到達分のみ**（軽量 HTTP=Gate1/2 は別枠で緩め、Playwright だけをメモリ観点で絞る）。

---

## 7. 軽量鮮度巡回ジョブ（node-cron）

`cron/freshness-poller.ts`。常時フルクロールを作らず、**フィードのメタだけ**を低頻度巡回。

```
schedule: FRESHNESS_POLL_CRON (既定 "0 */6 * * *" = 6h)。FRESHNESS_POLL_ENABLED で切替。

pollTick():
  1. 対象抽出: source_freshness_policy と sources を JOIN し
       kind in ('press_feed','news_feed')
       AND (last_polled_at IS NULL OR now() - last_polled_at >= feed_poll_interval_s)
       AND enabled AND robots_allowed
       を取得（in-process、pg-boss 移行時はここが producer になる）
  2. 各 feed source について FetchJob{ needBody:false } を enqueueFetch
       → planner は Gate1 に入り、フィードの軽量 HTTP のみ実行（本文 DL しない）
  3. 新着検知 & upsert（本文なし）:
       - フィード entries のうち guid が scraped_contents に未存在のものだけ
       - scraped_contents に source_type='press_release', content_md=summaryMd(or 空),
         guid, published_at, title, url を INSERT
         （部分ユニーク unique(company_id, guid) WHERE press_release で二重挿入防止）
       - fetch_method='rss', http_status=200 を記録。byte_size=フィード分のみ
  4. sources.last_polled_at=now(), stale_after=now()+feed_poll_interval を更新
  5. 本文は取らない → 重い本文取得は「次のカルテ要求」で needBody=true になった時に遅延実行
```

- 遅延本文取得: カルテ要求時（§6 ステップ4）、guid はあるが `content_md` が要約/空の press レコードを検出したら、その URL を個別 job（needBody=true）として Gate2/3 に降ろし本文を upsert（`supersedes` で旧メタ版を更新系列に）。
- これにより「新着ありは即わかる／本文コストは実需まで遅延」を両立。

---

## 8. Embedding パイプライン詳細

`embedding/`。**収集時 LLM 禁止の例外**（生成より桁違いに安い）。store 時に非同期 embed。

### 8.1 チャンキング（`chunker.ts`）

```
chunk(markdownAst):
  1. Markdown を H2/H3 見出しでセクション分割（H1 は文書タイトル扱い、章境界にしない）
  2. 各セクションをトークン概算（~4 chars/token 近似 or tiktoken）
  3. 800〜1000 token を目標に貪欲パック:
       - セクションが 1000 を超えるなら段落境界で分割。ただし
         表(| ... |)・箇条書き(- / 1.)・コードブロックは途中で割らない（原子単位）
       - 直前 chunk 末尾から ~100 token を overlap として次 chunk 先頭に複製
  4. 各 chunk に source_url（元 scraped_contents.canonical_url）を付与 → 出典追跡
  5. 返却: [{ chunkIndex, text, sourceUrl }]
```

### 8.2 プロバイダ選択と次元固定

```
provider-factory: switch(EMBEDDING_PROVIDER)
  'voyage' → VoyageProvider(EMBEDDING_MODEL)   // nativeDim 例 1024
  'openai' → OpenAIProvider(EMBEDDING_MODEL)   // nativeDim 例 3072

normalizeTo1536(vec): Float32Array(length 1536)
  if nativeDim == 1536: return vec
  if nativeDim  > 1536: return vec.slice(0,1536); then L2 renormalize  // truncation
  if nativeDim  < 1536: 固定 seed のランダム射影行列 R(nativeDim→1536) を適用
       （行列は起動時に model+dim をキーにキャッシュ、再現性のため seed 固定）
  // どの経路でも DB は vector(1536) 固定 → HNSW インデックス再構築不要
```
> 注意: 射影/truncation は同一 provider 内で一貫させる。provider を切り替えた場合は
> 意味空間が変わるため、`embeddings.model` 単位で再検索精度を検証（既存ベクトルとの混在検索は避ける）。

### 8.3 store 時 async フローと再 embed スキップ

```
embed-pipeline.run(contentId):   # enqueueEmbed から非同期起動（カルテ生成レイテンシ外）
  content = scrapedRepo.get(contentId)
  chunks  = chunker.chunk(content.content_md)
  for c in chunks: c.hash = sha256(normalize(c.text))
  existing = embeddingRepo.existingHashes(contentId)      # 既存 chunk hash 集合
  toEmbed = [ c for c in chunks if c.hash ∉ existing ]    # 未変更 chunk は再 embed しない
  if toEmbed empty: return
  provider = factory()
  for batch in chunks(toEmbed, EMBED_BATCH_SIZE):         # EMBED_CONCURRENCY で並行制御
      vecs = provider.embed(batch.texts)                  // 各 length===1536 保証
      embeddingRepo.upsertChunks(rows(batch, vecs, model=provider.model))
  # 削除された chunk（旧 index が新 content に無い）は content_id 単位で作り直す方針:
  #   同一 content_id は最新 chunk 集合で置換（chunk_index の穴を残さない）
```

- 変更検知の 3 段: 取得回避(304/TTL)→保存回避(content_hash)→**再 embed 回避(chunk hash)**。
- `enqueueEmbed` は §3 の Queue と同じ抽象上に乗せ、pg-boss/BullMQ 移行時も呼び出し側不変。

---

## 9. エラー処理・冪等性・リトライ

### 9.1 冪等性 / inflight dedup
- ジョブ冪等キー = `${sourceId}:${canonicalUrl}`。
- `in-process-queue.ts` は `Map<key, Promise<FetchResult>>` を保持。実行中に同キーが来たら**既存 Promise を返す**（合流）＝ 二重フェッチ防止。完了後にエントリ削除。
- 保存の冪等: `scraped_contents` の `UNIQUE(company_id, canonical_url, content_hash)` により、同一内容の再取得は INSERT 競合 → `ON CONFLICT DO NOTHING`、`inserted=false` で `unchanged` を返す。

### 9.2 リトライ / バックオフ（planner が担当、crawler は無リトライ）

| 事象 | リトライ | 方針 |
|---|---|---|
| crawler `timeout`(504) / `upstream_error`(502) | 最大 `FETCH_MAX_RETRIES`(2) | 指数バックオフ `FETCH_RETRY_BASE_MS * 2^n` + jitter |
| `crawler_error`(500) | 1 回 | 再現なら error 確定 |
| `upstream_rate_limited`(429) | リトライしない | Gate4 エスカレ判定へ（opt-in 時のみ）|
| `bad_request`/`validation_error`(400/422) | しない | プログラムバグ、即失敗+ログ |
| robots_blocked | しない | `outcome:'blocked'`、fetch_log に記録 |
| 軽量 HTTP(Gate1/2) ネットワーク断 | 1 回 | 失敗時は該当 source を skip |

### 9.3 robots ブロック時
- Gate 実行前（§4 冒頭）と crawler 内（`respect_robots`）の二重チェック。どちらでブロックされても本文は保存せず、`fetch_log.robots_blocked=true` を記録。カルテには「robots により未取得」を注記。

### 9.4 マルチソース要求の部分失敗
- §6 ステップ5 は `Promise.allSettled`。1 ソースの blocked/error は全体を止めない。
- 集約ルール: 「最低 1 ソース取得成功」ならカルテ生成に進む。全滅時のみ 424 相当を返す。
- 各未取得ソースは理由コード（`robots_blocked` / `managed_disabled` / `timeout`）付きでレスポンスと fetch_log に残す。

---

## 10. コンプライアンス実装

### 10.1 robots.txt（`compliance/robots.ts`）
```
isAllowed(url, ua):
  host = origin(url)
  robots = cache.get(host)  // TTL = ROBOTS_CACHE_TTL_SEC(86400)
  if miss: robots = fetch(`${host}/robots.txt`, LIGHT_HTTP_TIMEOUT_MS); cache.set
  rule = parse(robots).matchGroup(ua) ?? matchGroup('*')
  crawlDelayMs = rule.crawlDelay*1000 ?? DEFAULT_CRAWL_DELAY_MS
  return { allowed: rule.isAllowed(path(url)), crawlDelayMs }
```
- 取得不能/404 は「許可」とみなす（一般慣行）が、5xx は保守的に許可扱い＋ログ。
- 結果は `sources.robots_allowed` / `crawl_delay_ms` に保存し再利用。

### 10.2 ドメイン単位トークンバケット（`rate-limiter.ts`）
```
acquire(host):
  bucket = buckets.get(host) or new TokenBucket(
             rate = 1 token / crawlDelayMs, burst = 1)
  await bucket.take()                      // 空なら待機 = Crawl-delay を尊重
  // 同時接続は DOMAIN_MAX_CONCURRENCY(既定1) で別途セマフォ
```

### 10.3 User-Agent / 連絡先
- 全 HTTP（軽量 & crawler）に `USER_AGENT`（連絡先 URL + `CONTACT_EMAIL` 明示）を送る。Python crawler も同 UA。

### 10.4 監査（`fetch_log`）
- 全取得（cache_hit 含む）を 1 行記録: gate, method, http_status, bytes, duration_ms, cache_hit, robots_blocked, cost_note, `legal_basis='jp_copyright_art30_4'`。法務レビュー用エビデンス。

### 10.5 著作権法30条の4 の根拠明記位置
- DB: `scraped_contents.content_md` の COMMENT、`fetch_log.legal_basis` 既定値（上記 DDL に反映）。
- コード: `storage/repositories/scraped-content-repo.ts` の upsert 冒頭 doc コメントに根拠と「公開ビジネス情報限定・出典表示・robots 尊重」を明記。
- 設定: `packages/shared/src/compliance-policy.ts`（定数）に法務ポリシー要約を集約し、fetch_log 記録時に参照。

---

## 11. 段階スケール時の差し替え点

**呼び出し側コードを変えない**よう、変更を以下の interface 実装差し替えに局所化する。

| 差し替え | 変わる箇所（実装のみ） | 変わらない箇所（契約） |
|---|---|---|
| p-limit → pg-boss | `queue/in-process-queue.ts` → `queue/pgboss-queue.ts`。§7 の poller が producer、別 worker が consumer に。 | `Queue.enqueueFetch(job)` / `FetchJob` / `FetchResult` 型、planner 呼び出し |
| pg-boss → BullMQ + Redis | `queue/bullmq-queue.ts` + Redis 接続、専用 worker プロセス | 同上 `Queue` interface |
| 埋め込み provider 交換 | `embedding/providers/*` + `EMBEDDING_PROVIDER` | `EmbeddingProvider.embed→1536`、`embeddings` テーブル、HNSW index（**再構築不要**）|
| pgvector → 専用 VectorDB(Qdrant 等) | `storage/repositories/embedding-repo.ts` 実装のみ移送 | `EmbeddingRepo.search/upsertChunks` シグネチャ、chunk hash ロジック |
| crawler 単体 → 複製/自動スケール | `CRAWLER_BASE_URL` を LB 経由に。`adapters/crawl4ai.ts` は URL 差し替えのみ | `POST /crawl` 契約（§5）|
| DB 単一 → read replica/分割 | `storage/db.ts` の Pool 構成（read/write 分離） | Repository interface 群 |

差し替えは「1 ファイル置換 + factory の分岐追加 + env」で完結する設計を維持する（過剰な前倒し実装はしない）。

---

## 12. 実装タスク分解（順序付きチェックリスト・各 PR サイズ）

1. **[scaffold]** `/scaffold` で TS 基盤（pnpm workspace, tsconfig.base, strict/ESM）。`packages/shared`・`packages/collector` 雛形、root scripts。→ typecheck 通過。
2. **[shared 型 & env]** `types/*`, `schemas/crawler.ts`(zod), `env.ts`(zod fail-fast), `.env.example`(§1.3 全変数)。
3. **[schema]** `storage/schema.sql`（§2 DDL 完全版）+ migration ランナー + `docker-compose` の pgvector。`db.ts` Pool。→ マイグレーション適用確認。
4. **[repos]** company/source/scraped-content/embedding/fetch-log/policy の Repository 実装（upsert の ON CONFLICT dedup 含む）。→ 単体テスト（testcontainers）。
5. **[crawler service]** `services/crawler`（FastAPI + Crawl4AI）。`POST /crawl`・`GET /healthz`（§5 契約）、`resource_block.py`、`respect_robots`。Dockerfile。→ curl 疎通。
6. **[compliance]** `url-canonical.ts`(+content_hash), `robots.ts`(取得/キャッシュ), `rate-limiter.ts`(token-bucket)。→ 正規化/robots 単体テスト。
7. **[adapters]** `rss.ts` `sitemap.ts` `conditional-get.ts`（Gate1/2）、`crawl4ai.ts`（Gate3 クライアント）、`managed-crawl.ts`（Gate4, 既定 OFF）。SourceAdapter 契約準拠。
8. **[queue]** `Queue` interface + `in-process-queue.ts`（p-limit + inflight dedup）。`CONCURRENT_CRAWL_LIMIT` セマフォ。
9. **[planner]** `fetch-planner.ts`（Gate0..Gate4, §4）+ `freshness-judge.ts` + `source-enumerator.ts`。→ Gate 分岐の単体/結合テスト（304/content_hash スキップ確認）。
10. **[embedding]** `chunker.ts`, `embedding-provider.ts` + voyage/openai 実装 + factory（1536 正規化）, `embed-pipeline.ts`（async + chunk hash スキップ）。→ 未変更 chunk が再 embed されないこと確認。
11. **[freshness cron]** `freshness-poller.ts`（node-cron, §7）。新着 guid upsert（本文なし）、遅延本文取得の連携。
12. **[claude/dossier]** `prompt.ts`（RAG コンテキスト整形+出典必須）, `dossier-generator.ts`（Claude API, 7 構成生成）, `server/routes/dossier.ts`（§6 シーケンス, Promise.allSettled 部分失敗許容）, `health.ts`, `index.ts`(DI/起動)。→ 実在 1 社で end-to-end 確認。

各ステップは前段の型/契約にのみ依存し、独立 PR として型チェック緑を維持できる順序にしてある。

---

## 検証観点（実装着手時に必ず確認）

- 1 社オンデマンド収集 → `scraped_contents`/`embeddings`/`fetch_log` に想定どおり投入。
- 再取得で 304 / content_hash / chunk hash による各段スキップが効く（fetch_log の method で観測）。
- `CONCURRENT_CRAWL_LIMIT=4` で Gate3 同時 Chromium が 4 に制限され、4GB VPS で OOM しない。
- robots 不許可ドメインで crawler が呼ばれず blocked 記録される。
- `MANAGED_CRAWL_ENABLED=false` の既定で Gate4 が発火しない（opt-in 必須）。
