-- migration 0002_fit.sql
-- Fit 判定 PoC スキーマ。基本設計 docs/ui/fit-validation-design.md §5-2/§5-3、
-- 詳細設計 docs/ui/fit-validation-detailed-design.md §A-5 に対応。
--
-- 適用方法:
--   - 新規環境: docker compose up の init スクリプトとして自動適用（0001 の後に実行）
--   - 既存ボリューム: init は初回のみのため手動適用が必要:
--       docker compose exec db psql -U app -d sales_analytics \
--         -f /docker-entrypoint-initdb.d/0002_fit.sql

-- ========== 既存 enum の拡張（additive-only）==========
-- 注意: ADD VALUE は同一トランザクション内で新値を使えないため、トップレベルで実行する
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'jobs_media';   -- 求人媒体（Wantedly/Green 等、自動収集可のもの）
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'careers_page'; -- 自社採用ページ本文
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'job_posting';  -- 求人媒体の求人票

-- ========== 列挙型 ==========
DO $$ BEGIN
  CREATE TYPE need_level AS ENUM ('high', 'medium', 'low', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assessment_status AS ENUM ('running', 'succeeded', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ========== fit_assessments ==========
-- 1 実行 = 1 行。同一企業の再実行は新規行（履歴 — signalsVersion 別の一致率比較に使う）。
-- signals は JSONB で正規化しない（シグナル定義の改訂でスキーマ変更しないため）。
CREATE TABLE IF NOT EXISTS fit_assessments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  status            assessment_status NOT NULL DEFAULT 'running',
  stage             text NOT NULL DEFAULT 'collect',   -- collect | extract | judge | done
  need_level        need_level,                        -- succeeded 時のみ
  signals           jsonb,             -- SignalResult[]（全 14 件・camelCase のまま）
  missing_data      jsonb,             -- SignalId[]（取得不可・履歴不足）
  careers_check     jsonb,             -- CareersCheck { checkedUrls[], foundUrl } — シグナル 1-5 の根拠
  rationale         text,
  input             jsonb NOT NULL,    -- AssessmentInput の写し（再実行の再現用）
  signals_version   text NOT NULL,     -- fit-validation-signals.md のバージョン（要件 §4-3）
  prompt_version    text NOT NULL,
  model             text,
  input_tokens      integer,
  output_tokens     integer,
  duration_ms       integer,           -- S5 コスト実測（要件 §2-2）
  error             text,
  -- 人間評価（要件 §8 突き合わせ）
  human_need_level  need_level,
  mismatch_reason   text,              -- collection_gap | extraction_error | rule_issue | private_info
  human_reviewed_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS fit_assessments_company_time_idx
  ON fit_assessments (company_id, created_at DESC);

-- ========== 鮮度ポリシー ==========
INSERT INTO source_freshness_policy
  (source_kind, feed_poll_interval_s, body_ttl_s, html_ttl_s) VALUES
  ('jobs_media', 0, NULL, 604800)   -- poll なし / HTML 7d（careers と同等）
ON CONFLICT (source_kind) DO NOTHING;
