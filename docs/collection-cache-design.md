# データ収集 & キャッシュ基盤 — 基本設計（+主要モジュール要点）

- ステータス: ドラフト v0.2（未決事項の決定を反映 / 詳細設計は `collection-cache-detailed-design.md`）
- 作成日: 2026-07-04
- 関連: `docs/product-concept.md`（プロダクトコンセプト）。本書はその §5/§6 を掘り下げた収集・蓄積層の設計。

## Context（なぜこの設計を行うか）

BtoB 営業向けに「リサーチカルテ」を自動生成するプロダクト（`docs/product-concept.md` v0.1）の、
**データ収集・蓄積サブシステム**の基本設計。カルテ生成の入力となる「企業 HP 情報（静的/低頻度）」
と「プレスリリース（動的/高頻度）」を収集し、生の Markdown/text のまま DB とベクトル DB に
**キャッシュ蓄積**する層を設計する。

コンセプト doc は「オンデマンド生成のみ・データ基盤は後回し」だったが、本設計では
**オンデマンド生成を主としつつ、取得結果を蓄積キャッシュする層を足す**方針（ユーザー確認済み）。
常時フル日次クロールは作らない。**最優先はコスト最小化**。

確定した前提（ユーザー確認済み）:
- スコープ = **オンデマンド中心 + 蓄積キャッシュ**（重い全社フルクロールは作らない）
- 難サイト（PR TIMES 等）= **公式 RSS/API 優先**、スクレイピングは極力回避
- 対象企業数 = **未定** → 段階スケール可能な構成にする
- 深度 = **基本設計中心 + 主要モジュールの要点**（全ファイル/全行の列挙は不要）
- 収集時は LLM で構造化しない。生 Markdown/text を蓄積し、**構造化・カルテ生成はカルテ要求時にオンデマンド**で Claude API 実行

技術方針（`CLAUDE.md`/コンセプト §6 で確定）: 本体 = TypeScript strict / Node ESM / pnpm、
Crawler = **Crawl4AI（Python/Playwright）を別マイクロサービス**化し HTTP 経由で本体から呼ぶ、
分析/生成 = Claude API（全記述に出典）。

---

## 1. 全体アーキテクチャ

責務分割の原則:
- **TS 本体** = オーケストレーション / 状態 / キャッシュ / 意思決定（何を・取る必要があるか）
- **Python crawler** = ステートレスな取得器（URL → Markdown。判断を持たない）
- **収集時に LLM を回さない**。生 Markdown を蓄積し、構造化/生成はカルテ要求時のみ。

### MVP 最小構成（~100 社: インフラ1台・データストア1つ）

```
              ┌──────────────────────────────────────────────┐
 ユーザー ──▶│ TS Main App (Node ESM, Fastify)               │
 (カルテ要求)│   API層 ─▶ Dossier Orchestrator               │
              │            ├ Cache/Freshness Judge            │
              │            ├ Fetch Planner（決定木/コストゲート）│
              │            ├ Source Adapters                  │
              │            │    ├ RSS/Atom parser（軽量HTTP） │
              │            │    ├ sitemap.xml parser          │
              │            │    └ Conditional-GET (ETag)      │
              │            └ Claude API（構造化/カルテ生成）   │◀ オンデマンドのみ
              └──────┬──────────────────────┬────────────────┘
                     │ HTTP（重いHTMLのみ）  │
                     ▼                       ▼
        ┌───────────────────┐   ┌──────────────────────────┐
        │ Python Crawler Svc│   │ Postgres（単一データストア）│
        │ FastAPI + Crawl4AI│──▶│  - リレーショナル tables   │
        │ Playwright        │   │  - pgvector（embeddings）  │
        │ block img/css/font│   └──────────────────────────┘
        └───────────────────┘
  App / Crawler / Postgres を同一 VPS に同居。キュー無し（p-limit セマフォ）。
  同時クロール数は `CONCURRENT_CRAWL_LIMIT`(.env, 既定4) で上限固定 → 小メモリの安価 VPS でも安全。
  軽量鮮度巡回のみ node-cron (in-process)。
```

### 段階スケール経路（差分のみ）

| 層 | ~100 社 (MVP) | ~1,000 社 | ~10,000 社+ |
|---|---|---|---|
| ジョブ実行 | in-process + `p-limit` | **pg-boss**（Postgres 上キュー、追加インフラ0） | BullMQ + Redis、専用 worker |
| Crawler | 1 プロセス同居 | 2〜3 複製、キュー経由 | 自動スケール worker 群 |
| DB | 単一 Postgres | read replica / パーティション | 収集系・分析系分離 |
| Vector | pgvector 同居 | pgvector 専用インスタンス | Qdrant 等へ該当テーブルのみ移送 |
| 鮮度巡回 | node-cron | 専用 scheduler | 分散 cron + 優先度キュー |

**MVP で先に入れる4点だけ**（各段階の移行を局所差分に留めるため）:
① キュー抽象化 `enqueueFetch(job)`、② embedding を隔離テーブルに分離（`vector(1536)` 固定 + アダプタ）、③ ソース鮮度ポリシーを設定テーブル化、④ **同時クロール数上限 `CONCURRENT_CRAWL_LIMIT`(.env, 既定4)** で Playwright のメモリ暴走を防止（Chromium は 1 プロセス 500MB〜1GB）。それ以外は過剰設計しない。

---

## 2. データ収集フロー（決定木 = コストゲート）

「より安い手段で足りるなら重い手段に進まない」。上ほど安い。

```
FETCH 要求
 ├─[Gate 0] キャッシュ命中 & 鮮度OK? ─ YES ▶ DBの生Markdownを返す（取得コスト0）
 ├─[Gate 1] RSS/Atom/sitemap あり?   ─ YES ▶ 軽量HTTP(数KB) → 新規guid/URLだけ抽出、本文必要分のみGate3へ
 ├─[Gate 2] 条件付きGET (ETag/Last-Modified) ▶ 304なら本文DL回避・鮮度延長のみ（帯域0）／200なら本文へ
 │            静的で軽ければ 素のHTTP+パースで完結
 ├─[Gate 3] JSレンダ/構造抽出が必要 ▶ Python Crawler(Crawl4AI) 画像/CSS/font/media block
 └─[Gate 4] アンチボット強(PR TIMES等) ▶ 公式RSS/API優先（Gate1で捕捉が基本）
              本文が要る時だけ最小限フェッチ／マネージドAPI(Firecrawl等)は opt-in の最終手段（超過分は従量課金でユーザー負担, §9）
```

### 2 つのフロー
- **(A) オンデマンド・カルテ要求（同期寄り）**: company 解決 → 必要ソース列挙 → 各ソースを Gate0→…→Gate3 で取得（多くは Gate0 で完結）→ 生 Markdown をコンテキストに **Claude API で構造化+カルテ生成（ここで初めて LLM 課金）** → 生成物+出典を保存。
- **(B) 軽量鮮度巡回（バックグラウンド, node-cron）**: 登録企業のプレス系フィード(RSS/sitemap)だけを低頻度巡回。新規 guid を検知したら**本文は取らず「新着あり/見出し+URL」だけ**蓄積。重い本文取得は次のカルテ要求時まで遅延 → 常時フルクロールを回避しつつ鮮度確保。

---

## 3. HP 収集 vs プレスリリース収集（取得戦略は分離 / 保存は単一 `scraped_contents` に統合）

| 観点 | 企業 HP（静的・低頻度） | プレスリリース（動的・高頻度） |
|---|---|---|
| 一次手段 | Conditional-GET → 必要時のみ Crawl4AI | **RSS/Atom → sitemap** 最優先、本文は差分のみ |
| Crawl4AI | JS レンダ必要時のみ | 極力回避（RSS summary で足りることが多い） |
| 保存単位 | ページ単位 Markdown | リリース 1 件 = 1 レコード（guid 主キー） |
| TTL/鮮度 | 長い（会社概要 ~30d、採用 ~7d） | フィード巡回 6〜24h、本文は取得後不変=無期限 |

鮮度ポリシーはコードでなく `source_type → {feed_poll_interval, body_ttl, html_ttl}` の**設定テーブル**で保持し、社数増でチューニング可能に。

> **保存構造は分けない**: HP もプレスも単一の `scraped_contents` テーブルに `source_type`(enum) で格納するポリモーフィック設計（§4）。取得戦略・鮮度だけを type 別に変える。将来 `x_post`/`note_article` を enum 追加するだけで拡張できる（SNS/ニュースは現時点スコープ外）。

---

## 4. ストレージ設計（要点）

**なぜ MVP は pgvector 同居か**: データストアを1つにするのが運用/バックアップ/整合で最安。生ドキュメント保存と embedding 保存を 1 トランザクションで原子的に扱える。社数未定で専用 VectorDB は早すぎる最適化。pgvector(HNSW) は数十万 chunk まで実用。移行時は embedding 隔離テーブルだけ移送すればよい。

スキーマ骨子（PostgreSQL + pgvector）:
- `companies(id, name, domain unique, aliases[], corp_number, ...)` — **domain を canonical キー**に
- `sources(id, company_id, kind, url, canonical_url, etag, last_modified, feed_kind, robots_allowed, crawl_delay, last_polled_at, stale_after, unique(company_id, canonical_url))` — `kind` = 収集口の種別 `corporate_hp|careers|press_feed|news_feed`。ETag 等の条件付き GET 状態を保持
- **`scraped_contents`（ポリモーフィック本体・単一テーブル）** `(id, company_id, source_id, source_type, url, canonical_url, title, content_md, content_hash, fetched_at, fetch_method, http_status, byte_size, guid null, published_at null, supersedes null)` — `source_type` enum = **`corporate_hp | press_release`**（将来 `x_post|note_article` を追加）。プレス固有列(`guid`,`published_at`)は nullable で press_release 時のみ充填。重複排除は `unique(company_id, canonical_url, content_hash)` + `unique(company_id, guid) WHERE source_type='press_release'`（部分ユニーク）
- `fetch_log(id, source_id, requested_at, method, http_status, bytes, duration_ms, cache_hit, cost_note)` — 監査/コスト計測/法務エビデンス
- `embeddings(id, content_id→scraped_contents, company_id, chunk_index, chunk_text, content_hash, embedding vector(1536), model, unique(content_id, chunk_index))` + `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`

**embedding は「収集時 LLM 禁止」の例外として許容**（生成より桁違いに安い）。推奨 = **store 時に非同期 embed**（カルテ生成のレイテンシから外す）。ただし **chunk 単位 content_hash で未変更 chunk は再 embed しない**。分割 = Markdown の見出し境界（H2/H3）ベース、~800〜1000 tokens 目標・~100 token オーバーラップ、表/箇条書きは割らない。各 chunk に source_url を保持（出典追跡）。

> ✅ 埋め込み次元は **`vector(1536)` に固定**（標準的な高精度サイズ）。埋め込み API は **アダプタパターン**で Voyage / OpenAI を差し替え可能にし、後からの**インデックス再構築を回避**する。1536 に揃わないモデルは採用時に truncation / 射影で吸収する（§9-2）。

---

## 5. 変更検知 / dedup / 冪等性

原則: **「取得を避ける(304/TTL)」→「保存を避ける(content_hash)」→「再embedを避ける(chunk hash)」** の3段でコスト削減。

- **URL 正規化**: scheme 小文字化、末尾スラッシュ統一、`utm_*` 除去、www 正規化、フラグメント除去 → `canonical_url` を一意キー。
- **content_hash**: 正規化テキストの SHA-256。前回一致なら保存も embed もスキップ。
- **RSS guid + pubDate**: `scraped_contents` に `unique(company_id, guid) WHERE source_type='press_release'`（部分ユニーク）で upsert。guid 無しは `canonical_url` フォールバック。
- **ETag/Last-Modified**: `sources` に保持し条件付き GET。304 は取得コスト0で鮮度延長のみ。
- **chunk hash**: 一部変更時に変わった chunk だけ再 embed。
- **冪等ジョブ**: job キー = `(source_id, canonical_url)`。inflight 合流で重複フェッチ防止。

---

## 6. サービス間インターフェース & コンプライアンス（要点）

TS → Python Crawler の HTTP 契約は **URL(+抽出ヒント) → Markdown** に限定（実装隠蔽）:
```
POST /crawl { url, render:"auto|static|js", extraction_hint?, block_resources:["image","stylesheet","font","media"], timeout_ms, respect_robots:true }
      → { final_url, status, markdown, meta:{title,fetched_at,byte_size,rendered}, robots_blocked?, error? }
GET  /healthz
```
帯域削減: Playwright `page.route` で image/stylesheet/font/media を block（crawler 既定 ON、TS が明示解除した時のみ取得）。

コンプライアンス（コンセプト §5/§7 の robots/法務要件）:
- **TS 側（主）**: フェッチ前に robots.txt を取得・キャッシュ。不許可なら crawler を呼ばず中止。`Crawl-delay`/自主レートをドメイン単位トークンバケットで制御。
- **Python 側（多層防御）**: `respect_robots=true` で二重チェック、ブロック時 `robots_blocked` 返却。
- User-Agent + 連絡先明示、ドメイン単位同時接続上限、全取得を `fetch_log` に記録（法務レビュー用エビデンス）。
- PR TIMES 等は **Gate4=公式 RSS 優先で回避**する設計自体がコンプラ対策。

---

## 7. コスト最適化の効き所

| 施策 | アーキ上の位置 | 期待効果 |
|---|---|---|
| 収集時 LLM を回さない（生 Markdown 蓄積） | Orchestrator/保存 | **最大の効き所**。LLM 課金をカルテ生成時のみに限定 |
| キャッシュ命中優先(Gate0/TTL) | Freshness Judge | 反復/近接要求の取得・LLM をゼロ化 |
| RSS/sitemap 優先(Gate1) | Source Adapter | プレス取得を数 KB の HTTP に圧縮、Playwright 起動回避 |
| 条件付き GET 304(Gate2) | Fetch 層 | 未更新 HP の本文 DL・再パース・再 embed を回避 |
| 画像/CSS/font block | Python Crawler | HTML 取得の帯域を大幅削減 |
| content_hash / chunk hash | 保存/embedding | 重複排除 + 未変更 chunk の再 embed 回避 |
| 公式 RSS/API 優先(PR TIMES) | Gate4 | 高コスト/高リスクなアンチボット突破を回避 |
| 軽量鮮度巡回で本文遅延取得 | node-cron | 常時全社フルクロールのコストを排除 |
| self-host VPS + 単一 Postgres | インフラ | マネージド crawl API/専用 VectorDB の従量課金を回避 |

---

## 8. 実装時の主要ファイル（greenfield: 新規作成想定）

準拠先（既存）:
- `docs/product-concept.md` — 唯一の確定要件源
- `CLAUDE.md` — TS strict/ESM/pnpm・skill/hook 方針

新規（実装フェーズ）:
- `packages/collector/src/orchestrator.ts` — Fetch Planner / 決定木の中枢
- `packages/collector/src/adapters/{rss,sitemap,conditional-get}.ts` — Source Adapters（Gate1/2）
- `packages/collector/src/storage/schema.sql` — §4 スキーマ + pgvector
- `packages/collector/src/queue.ts` — `enqueueFetch` 抽象（in-process→pg-boss 差し替え点）
- `services/crawler/main.py` — FastAPI + Crawl4AI、§6 契約
- 実装着手は既存方針どおり **`/scaffold` で TS 基盤（package.json/tsconfig/src）を初期化**してから。

---

## 9. 確定した設計判断 / 残課題

### 確定（本改訂 v0.2 で決定）
1. **マネージド API フォールバック**: RSS/Crawl4AI で不足する難サイト本文は **Firecrawl 等を opt-in の最終手段**として使う。**超過分の従量課金はユーザー負担**（原価をユーザーに転嫁）。既定 OFF、明示的に有効化した企業/リクエストのみ。
2. **Embedding 次元**: スキーマは **`vector(1536)` に固定**。埋め込み API は**アダプタパターン**で Voyage / OpenAI を差し替え可能にし、後からのインデックス再構築を回避（§4）。1536 に揃わないモデルは truncation/射影で吸収。
3. **同時実行 / メモリ安全**: Playwright(Chromium) は 1 プロセス 500MB〜1GB。**`CONCURRENT_CRAWL_LIMIT`(.env, 既定4)** で同時クロール数を上限固定 → メモリ 4GB の安価 VPS でも落とさず消化。スケール時はサーバー増強、または crawler を別インスタンスに分離。
4. **法務根拠**: 生 Markdown の蓄積は **著作権法 第30条の4（情報解析目的の複製）** を根拠とする。あわせて robots.txt 尊重・出典表示・公開ビジネス情報限定を運用要件として維持（§6）。ただし **カルテ出力（人が読む段階）は 30条の4 だけでは守れない**（享受目的の併存リスク）。有料化前の確認事項は **`docs/legal-review-checklist.md`** に整理。PoC 段階はマナー（同一ドメイン 10〜20 秒・並列1・robots 尊重）遵守のみ。
5. **スコープ限定 + ポリモーフィック化**: SNS/ニュースメディアは TOS/API 変更が激しいため**現時点はスコープ外**。ただし `scraped_contents.source_type`(enum) を `corporate_hp | press_release` で定義し、将来 `x_post | note_article` を**追加するだけ**で全体が壊れない構造にしておく（§3/§4）。

### 残課題（詳細設計/実装時に詰める）
6. **company→domain 解決**: 企業名からのドメイン特定（手入力必須か検索 API 併用か）。誤ドメインは全収集を汚染するため詳細設計で確定。
7. **プレスフィード可用性**: 全企業が RSS/sitemap を持つとは限らない。フィード無し企業は sitemap → HP のプレス一覧ページ Crawl4AI にフォールバック（詳細設計で規定）。

---

## 検証（設計の妥当性確認と次アクション）

本設計はコードを書く前の**基本設計**。実装/価値検証は以下で進める:
1. **価値検証（コンセプト §8）を先に**: 実在 10 社で手動+Claude によりカルテを作り、営業担当にヒアリング。品質基準とプロンプト要件を先に固める（収集基盤の作り込みより優先）。
2. **収集フロー PoC**: 対象 3〜5 社で Gate0〜4 を手動トレースし、RSS/sitemap の実在率・PR TIMES の RSS 取得可否・条件付き GET の 304 率を実測 → 鮮度パラメータ初期値とコスト試算を得る。
3. **実装着手時**: `/scaffold` で TS 基盤初期化 → `services/crawler` を FastAPI+Crawl4AI で立て `/healthz`・`/crawl` を疎通 → Postgres+pgvector を起動し §4 スキーマ適用 → 1 社をオンデマンド収集し `scraped_contents`/`embeddings`/`fetch_log` に想定どおり入るか、再取得時に 304/content_hash でスキップされるかを確認。
