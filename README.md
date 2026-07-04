# sales-analytics

BtoB 営業向けリサーチカルテ生成ツールの、**データ収集 & キャッシュ基盤**の実装。
設計は `docs/` を参照:

- `docs/product-concept.md` — プロダクトコンセプト
- `docs/collection-cache-design.md` — 基本設計
- `docs/collection-cache-detailed-design.md` — 詳細設計

方針: **オンデマンド中心 + 蓄積キャッシュ**。収集時は LLM を回さず生 Markdown を蓄積し、
構造化・カルテ生成はカルテ要求時に Claude API で実行。コスト最小化のため取得は
Gate0(キャッシュ)→Gate1(RSS/sitemap)→Gate2(条件付きGET)→Gate3(Crawl4AI)→Gate4(公式優先/opt-in) の
決定木で「安い手段で足りたら降りない」。

## 構成

```
packages/collector   # TS 本体（決定木・キャッシュ・DB・Claude 生成）
packages/shared      # 型・zod スキーマ・env ローダ
services/crawler     # Python(FastAPI + Crawl4AI) 取得器（URL→Markdown）
```

## セットアップ

```bash
pnpm install
cp .env.example .env        # 必要なキーを埋める（ANTHROPIC_API_KEY, VOYAGE_API_KEY 等）
pnpm typecheck              # 型チェック
pnpm test                   # 純ロジックのユニットテスト
```

### DB（Postgres + pgvector）

```bash
docker compose up -d db     # pgvector 同梱イメージ。schema.sql が初期化時に適用される
# 手動適用する場合:
psql "$DATABASE_URL" -f packages/collector/src/storage/schema.sql
```

### Crawler サービス

```bash
docker compose up -d crawler      # もしくは services/crawler/README.md 参照でローカル起動
curl localhost:8000/healthz
```

### 本体起動

```bash
pnpm start:collector        # Fastify: POST /dossiers, GET /healthz
```

### カルテ生成（例）

```bash
curl -X POST localhost:3000/dossiers \
  -H 'content-type: application/json' \
  -d '{"companyNameOrUrl":"https://example.co.jp","selfProduct":"..."}'
```

## 検証済み / 未検証

- ✅ TS 全体型チェック（strict）・純ロジックのユニットテスト
- ✅ Crawler サービス起動 + `/healthz` + `render:"static"` の `/crawl`（example.com）
- ✅ スキーマ適用・dedup / プレス guid upsert（meta=DO NOTHING / body=DO UPDATE）・部分ユニーク制約（ローカル pg15 で検証）
- ⏳ pgvector 拡張・HNSW インデックスの実行（要 docker もしくは pgvector 導入）
- ⏳ end-to-end（Postgres + Crawl4AI + ANTHROPIC/VOYAGE キー）でのカルテ生成
