from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse
from uuid import uuid4

from agents import FunctionTool
from agents.tool_context import ToolContext
from playwright.async_api import async_playwright

ToolHandler = Callable[..., Any] | Callable[..., Awaitable[Any]]


@dataclass
class ScreenshotResult:
    path: str
    width: int
    height: int


class ScreenshotService:
    def __init__(self, *, workspace_root: Path) -> None:
        self._workspace_root = workspace_root.resolve()
        self._playwright = None
        self._browser = None
        self._lock = asyncio.Lock()

    async def take_screenshot(
        self,
        *,
        url: str,
        full_page: bool = False,
        viewport: dict[str, int] | None = None,
        wait_for: str | None = None,
        delay_ms: int | None = None,
    ) -> ScreenshotResult:
        self._validate_url(url)
        await self._ensure_browser()

        viewport_cfg = viewport or {"width": 1280, "height": 720}
        context = await self._browser.new_context(viewport=viewport_cfg)
        page = await context.new_page()
        await page.goto(url, wait_until="networkidle")
        if wait_for:
            await page.wait_for_selector(wait_for)
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000)

        output_path = self._build_output_path()
        await page.screenshot(path=str(output_path), full_page=full_page)
        await context.close()

        return ScreenshotResult(
            path=str(output_path),
            width=int(viewport_cfg.get("width", 0)),
            height=int(viewport_cfg.get("height", 0)),
        )

    async def close(self) -> None:
        async with self._lock:
            if self._browser is not None:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None

    async def _ensure_browser(self) -> None:
        async with self._lock:
            if self._browser is not None:
                return
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True)

    def _build_output_path(self) -> Path:
        output_dir = self._workspace_root / "screenshots"
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{uuid4().hex[:8]}.png"
        return output_dir / filename

    def _validate_url(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise RuntimeError("screenshot_invalid_scheme")
        host = (parsed.hostname or "").lower()
        if host not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("screenshot_url_not_localhost")


def build_screenshot_tools(*, service: ScreenshotService) -> list[FunctionTool]:
    async def take_screenshot(
        url: str,
        full_page: bool | None = None,
        viewport: dict[str, int] | None = None,
        wait_for: str | None = None,
        delay_ms: int | None = None,
    ):
        result = await service.take_screenshot(
            url=url,
            full_page=bool(full_page),
            viewport=viewport,
            wait_for=wait_for,
            delay_ms=delay_ms,
        )
        data_url = _build_data_url(Path(result.path))
        return {
            "path": result.path,
            "width": result.width,
            "height": result.height,
            "data_url": data_url,
        }

    return [
        _make_tool(
            name="take_screenshot",
            description="Capture a screenshot of a localhost webpage.",
            params_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "full_page": {"type": "boolean"},
                    "viewport": {
                        "type": "object",
                        "properties": {"width": {"type": "integer"}, "height": {"type": "integer"}},
                        "additionalProperties": False,
                    },
                    "wait_for": {"type": "string"},
                    "delay_ms": {"type": "integer", "minimum": 0, "maximum": 30000},
                },
                "required": ["url"],
                "additionalProperties": False,
            },
            handler=take_screenshot,
        )
    ]


def _make_tool(name: str, description: str, params_schema: dict[str, Any], handler: ToolHandler) -> FunctionTool:
    async def _on_invoke(ctx: ToolContext[Any], input_json: str) -> Any:
        try:
            payload = json.loads(input_json) if input_json else {}
        except Exception as exc:  # noqa: BLE001
            return f"Invalid JSON input for tool {name}: {exc}"
        if not isinstance(payload, dict):
            return f"Invalid JSON input for tool {name}: expected object."
        try:
            result = handler(**payload)
            if asyncio.iscoroutine(result):
                result = await result
            return result
        except Exception as exc:  # noqa: BLE001
            return f"Tool {name} failed: {exc}"

    return FunctionTool(
        name=name,
        description=description,
        params_json_schema=params_schema,
        on_invoke_tool=_on_invoke,
        strict_json_schema=True,
    )


def _build_data_url(path: Path) -> str:
    if not path.exists():
        return ""
    raw = path.read_bytes()
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{encoded}"
