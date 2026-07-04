-- migration 0001_init.sql
-- データ収集 & キャッシュ基盤 スキーマ。PostgreSQL 15+ / pgvector 0.7+ 前提。
-- 詳細設計 docs/collection-cache-detailed-design.md §2 に対応。

-- ========== 拡張 ==========
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector（embeddings 用）
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ========== 列挙型 ==========
-- 保存本体のポリモーフィック種別。additive-only（将来 x_post|note_article を ADD VALUE するだけ）
DO $$ BEGIN
  CREATE TYPE source_type AS ENUM ('corporate_hp', 'press_release');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 収集口の種別（sources 側）。取得戦略・鮮度をこの kind 単位で切り替える
DO $$ BEGIN
  CREATE TYPE source_kind AS ENUM ('corporate_hp', 'careers', 'press_feed', 'news_feed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 実際に本文を取得した手段（監査・コスト分析用）
DO $$ BEGIN
  CREATE TYPE fetch_method AS ENUM (
    'cache_hit',        -- Gate0
    'rss', 'sitemap',   -- Gate1
    'conditional_get',  -- Gate2 (200)
    'not_modified',     -- Gate2 (304)
    'crawl4ai',         -- Gate3
    'managed_api'       -- Gate4
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ========== companies ==========
-- domain を canonical キーにする（誤ドメインは全収集を汚染するため一意制約で守る）
CREATE TABLE IF NOT EXISTS companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  domain       text NOT NULL,                 -- 正規化済みホスト（例: example.co.jp）
  aliases      text[] NOT NULL DEFAULT '{}',
  corp_number  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_domain_key UNIQUE (domain)
);
COMMENT ON COLUMN companies.domain IS 'canonical 収集キー。small-caps 正規化・www 除去済み';

-- ========== sources ==========
CREATE TABLE IF NOT EXISTS sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           source_kind NOT NULL,
  url            text NOT NULL,
  canonical_url  text NOT NULL,
  feed_kind      text,                        -- 'rss' | 'atom' | 'sitemap' | null(=HTML)
  etag           text,
  last_modified  text,
  robots_allowed boolean NOT NULL DEFAULT true,
  crawl_delay_ms integer,
  last_polled_at timestamptz,
  stale_after    timestamptz,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_company_canonical_key UNIQUE (company_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS sources_company_idx ON sources (company_id);
CREATE INDEX IF NOT EXISTS sources_poll_idx ON sources (kind, last_polled_at) WHERE enabled;

-- ========== scraped_contents（ポリモーフィック本体・単一テーブル）==========
CREATE TABLE IF NOT EXISTS scraped_contents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_type   source_type NOT NULL,
  url           text NOT NULL,
  canonical_url text NOT NULL,
  title         text,
  content_md    text NOT NULL,                -- 生 Markdown（収集時 LLM 構造化しない）
  content_hash  bytea NOT NULL,               -- 正規化テキストの SHA-256（32 bytes）
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  fetch_method  fetch_method NOT NULL,
  http_status   integer,
  byte_size     integer,
  guid          text,                         -- press_release のみ
  published_at  timestamptz,                  -- press_release のみ
  supersedes    uuid REFERENCES scraped_contents(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scraped_contents_dedup_key UNIQUE (company_id, canonical_url, content_hash)
);
-- プレスの guid 一意化は「press_release のときだけ」効く部分ユニークインデックス
CREATE UNIQUE INDEX IF NOT EXISTS scraped_contents_press_guid_uidx
  ON scraped_contents (company_id, guid)
  WHERE source_type = 'press_release' AND guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS scraped_contents_company_type_idx
  ON scraped_contents (company_id, source_type, fetched_at DESC);
COMMENT ON COLUMN scraped_contents.content_md IS
  '生 Markdown を蓄積。著作権法30条の4（情報解析目的の複製）を根拠に保持';

-- ========== fetch_log（監査 / コスト計測 / 法務エビデンス）==========
CREATE TABLE IF NOT EXISTS fetch_log (
  id             bigserial PRIMARY KEY,
  source_id      uuid REFERENCES sources(id) ON DELETE SET NULL,
  company_id     uuid REFERENCES companies(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  gate           smallint,
  method         fetch_method NOT NULL,
  http_status    integer,
  bytes          integer,
  duration_ms    integer,
  cache_hit      boolean NOT NULL DEFAULT false,
  robots_blocked boolean NOT NULL DEFAULT false,
  cost_note      text,
  legal_basis    text NOT NULL DEFAULT 'jp_copyright_art30_4',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fetch_log_company_time_idx ON fetch_log (company_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS fetch_log_method_idx ON fetch_log (method, requested_at DESC);

-- ========== embeddings（隔離テーブル・移送しやすく）==========
-- vector(1536) 固定。プロバイダはアダプタで差し替え可、DB インデックス再構築不要
CREATE TABLE IF NOT EXISTS embeddings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id   uuid NOT NULL REFERENCES scraped_contents(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  chunk_text   text NOT NULL,
  content_hash bytea NOT NULL,                -- チャンク単位 SHA-256（未変更は再 embed 回避）
  source_url   text NOT NULL,
  embedding    vector(1536) NOT NULL,
  model        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embeddings_content_chunk_key UNIQUE (content_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS embeddings_company_idx ON embeddings (company_id);
CREATE INDEX IF NOT EXISTS embeddings_chunk_hash_idx ON embeddings (content_hash);

-- ========== source_freshness_policy（鮮度ポリシー設定テーブル）==========
CREATE TABLE IF NOT EXISTS source_freshness_policy (
  source_kind          source_kind PRIMARY KEY,
  feed_poll_interval_s integer NOT NULL,
  body_ttl_s           integer,
  html_ttl_s           integer NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO source_freshness_policy
  (source_kind, feed_poll_interval_s, body_ttl_s, html_ttl_s) VALUES
  ('corporate_hp', 0,      NULL, 2592000),  -- HTML 30d
  ('careers',      0,      NULL, 604800),   -- HTML 7d
  ('press_feed',   21600,  NULL, 86400),    -- 巡回 6h / 本文無期限 / 一覧 24h
  ('news_feed',    43200,  NULL, 86400)     -- 巡回 12h
ON CONFLICT (source_kind) DO NOTHING;
