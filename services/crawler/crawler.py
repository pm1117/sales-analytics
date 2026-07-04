"""Crawl4AI ラッパ。static は httpx 素取得、auto/js は Playwright レンダ。"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import httpx

from resource_block import install_block
from schemas import CrawlMeta, CrawlRequest, CrawlResponse
from settings import settings


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<(script|style|noscript)[\s\S]*?</\1>", re.IGNORECASE)
_TITLE_RE = re.compile(r"<title[^>]*>([\s\S]*?)</title>", re.IGNORECASE)


def html_to_markdown(html: str) -> tuple[str | None, str]:
    """依存の薄い best-effort HTML→Markdown（高品質抽出は Crawl4AI が担う）。"""
    title_m = _TITLE_RE.search(html)
    title = title_m.group(1).strip() if title_m else None

    body = _SCRIPT_RE.sub("", html)
    body = re.sub(r"<h1[^>]*>([\s\S]*?)</h1>", r"\n# \1\n", body, flags=re.IGNORECASE)
    body = re.sub(r"<h2[^>]*>([\s\S]*?)</h2>", r"\n## \1\n", body, flags=re.IGNORECASE)
    body = re.sub(r"<h3[^>]*>([\s\S]*?)</h3>", r"\n### \1\n", body, flags=re.IGNORECASE)
    body = re.sub(r"<li[^>]*>([\s\S]*?)</li>", r"\n- \1", body, flags=re.IGNORECASE)
    body = re.sub(r"</p>", "\n\n", body, flags=re.IGNORECASE)
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.IGNORECASE)
    text = _TAG_RE.sub(" ", body)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    md = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return title, md


async def _static_fetch(url: str) -> tuple[int, str]:
    timeout = httpx.Timeout(
        settings.crawl_timeout_ms / 1000,
        connect=settings.connect_timeout_ms / 1000,
    )
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        res = await client.get(url, headers={"user-agent": settings.user_agent})
        return res.status_code, res.text


async def _dynamic_fetch(req: CrawlRequest) -> tuple[int, str, str | None]:
    """Crawl4AI(Playwright) でレンダして Markdown を得る。crawl4ai は遅延 import。"""
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig  # type: ignore

    browser_cfg = BrowserConfig(headless=True, user_agent=settings.user_agent)

    async def _on_page(page, **_kwargs):
        await install_block(page, req.block_resources)

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        # フック名/シグネチャは crawl4ai のバージョンに依存するため防御的に設定する
        try:
            crawler.crawler_strategy.set_hook("on_page_context_created", _on_page)
        except Exception:  # noqa: BLE001
            pass
        result = await crawler.arun(
            url=req.url,
            config=CrawlerRunConfig(page_timeout=req.timeout_ms),
        )
    status = getattr(result, "status_code", 200) or 200
    markdown = getattr(result, "markdown", "") or ""
    title = None
    meta = getattr(result, "metadata", None)
    if isinstance(meta, dict):
        title = meta.get("title")
    return status, markdown, title


async def crawl(req: CrawlRequest) -> CrawlResponse:
    if req.respect_robots:
        from robots import is_blocked_by_robots

        blocked = await is_blocked_by_robots(
            req.url, settings.user_agent, settings.connect_timeout_ms / 1000
        )
        if blocked:
            return CrawlResponse(
                final_url=req.url, status=0, markdown="", meta=None, robots_blocked=True
            )

    rendered = False
    title: str | None = None
    try:
        if req.render == "static":
            status, html = await _static_fetch(req.url)
            title, markdown = html_to_markdown(html)
        elif req.render == "js":
            status, markdown, title = await _dynamic_fetch(req)
            rendered = True
        else:  # auto: まず static、薄ければ dynamic
            status, html = await _static_fetch(req.url)
            title, markdown = html_to_markdown(html)
            if len(markdown) < 200:
                status, markdown, title = await _dynamic_fetch(req)
                rendered = True
    except Exception as exc:  # noqa: BLE001
        return CrawlResponse(
            final_url=None,
            status=502,
            markdown="",
            meta=None,
            error={"code": "upstream_error", "message": str(exc)},
        )

    return CrawlResponse(
        final_url=req.url,
        status=status,
        markdown=markdown,
        meta=CrawlMeta(
            title=title,
            fetched_at=_now_iso(),
            byte_size=len(markdown.encode("utf-8")),
            rendered=rendered,
        ),
    )
