"""HTTP 契約（詳細設計 §5）。ワイヤは snake_case（TS 側 CrawlResponseWireSchema と一致）。"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

RenderMode = Literal["auto", "static", "js"]
BlockResource = Literal["image", "stylesheet", "font", "media"]

DEFAULT_BLOCK: list[BlockResource] = ["image", "stylesheet", "font", "media"]


class CrawlRequest(BaseModel):
    url: str
    render: RenderMode = "auto"
    extraction_hint: Optional[str] = None
    block_resources: list[BlockResource] = Field(default_factory=lambda: list(DEFAULT_BLOCK))
    timeout_ms: int = 30000
    respect_robots: bool = True


class CrawlMeta(BaseModel):
    title: Optional[str] = None
    fetched_at: str
    byte_size: int
    rendered: bool


class CrawlError(BaseModel):
    code: str
    message: str


class CrawlResponse(BaseModel):
    final_url: Optional[str]
    status: int
    markdown: str
    meta: Optional[CrawlMeta]
    robots_blocked: bool = False
    error: Optional[CrawlError] = None
