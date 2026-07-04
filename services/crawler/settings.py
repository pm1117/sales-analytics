"""環境設定。app 側 CONCURRENT_CRAWL_LIMIT と CRAWLER_MAX_CONCURRENCY を揃える。"""
from __future__ import annotations

import os


class Settings:
    port: int = int(os.environ.get("CRAWLER_PORT", "8000"))
    crawl_timeout_ms: int = int(os.environ.get("CRAWL_TIMEOUT_MS", "30000"))
    connect_timeout_ms: int = int(os.environ.get("CRAWL_CONNECT_TIMEOUT_MS", "5000"))
    max_concurrency: int = int(os.environ.get("CRAWLER_MAX_CONCURRENCY", "4"))
    user_agent: str = os.environ.get(
        "USER_AGENT",
        "SalesAnalyticsBot/0.1 (+https://example.com/bot; contact: bot@example.com)",
    )


settings = Settings()
