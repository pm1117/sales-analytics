"""robots.txt 二重チェック（多層防御）。TS 側が一次判定、ここは保険。"""
from __future__ import annotations

import urllib.robotparser
from urllib.parse import urlparse

import httpx


async def is_blocked_by_robots(url: str, user_agent: str, timeout_s: float) -> bool:
    """robots.txt が明確に拒否している場合のみ True。取得不能は False（許可扱い）。"""
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            res = await client.get(robots_url, headers={"user-agent": user_agent})
        if res.status_code != 200:
            return False
    except httpx.HTTPError:
        return False

    rp = urllib.robotparser.RobotFileParser()
    rp.parse(res.text.splitlines())
    return not rp.can_fetch(user_agent, url)
