"""FastAPI エントリ。POST /crawl（URL→Markdown）, GET /healthz。詳細設計 §5。"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from crawler import crawl
from schemas import CrawlRequest, CrawlResponse
from settings import settings

app = FastAPI(title="sales-analytics crawler", version="0.1.0")

# Playwright 同時起動数の二次防御（一次は TS 側 CONCURRENT_CRAWL_LIMIT）
_semaphore = asyncio.Semaphore(settings.max_concurrency)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.post("/crawl", response_model=CrawlResponse)
async def crawl_endpoint(req: CrawlRequest) -> CrawlResponse:
    async with _semaphore:
        return await crawl(req)


@app.exception_handler(Exception)
async def unhandled(_request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "final_url": None,
            "status": 500,
            "markdown": "",
            "meta": None,
            "robots_blocked": False,
            "error": {"code": "crawler_error", "message": str(exc)},
        },
    )
