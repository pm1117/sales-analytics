"""Playwright リソースブロック（帯域削減）。詳細設計 §5.4。"""
from __future__ import annotations

BLOCKABLE = {"image", "stylesheet", "font", "media"}


async def install_block(page, block_resources: list[str]) -> None:
    """指定リソース種別を abort する route を張る。既定で image/css/font/media を落とす。"""
    block = {r for r in block_resources if r in BLOCKABLE}
    if not block:
        return

    async def _route(route):
        if route.request.resource_type in block:
            await route.abort()
        else:
            await route.continue_()

    await page.route("**/*", _route)
