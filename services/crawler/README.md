# crawler service (Python / FastAPI + Crawl4AI)

TS 本体から HTTP で呼ばれるステートレスな取得器。`URL(+ヒント) → Markdown` に限定。

## ローカル起動

```bash
cd services/crawler
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium   # 動的レンダに必要
uvicorn main:app --reload --port 8000
```

`crawl4ai` / Playwright 未導入でも `render:"static"` と `/healthz` は動作する（動的パスは遅延 import）。

## 契約

- `GET /healthz` → `{ "status": "ok" }`
- `POST /crawl`（詳細設計 §5）:
  ```json
  { "url": "https://example.co.jp/news", "render": "auto",
    "block_resources": ["image","stylesheet","font","media"],
    "timeout_ms": 30000, "respect_robots": true }
  ```
  → `{ final_url, status, markdown, meta, robots_blocked, error }`
