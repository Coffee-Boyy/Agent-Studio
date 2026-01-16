from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, DefaultDict


class RunEventBus:
    """
    In-process pub/sub for live run events (used by SSE).

    Notes:
    - This is intentionally simple for the MVP.
    - If/when you add multi-process execution, swap this for Redis/NATS/etc.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._subs: DefaultDict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)

    async def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        async with self._lock:
            self._subs[run_id].add(q)
        return q

    async def unsubscribe(self, run_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            subs = self._subs.get(run_id)
            if not subs:
                return
            subs.discard(q)
            if not subs:
                self._subs.pop(run_id, None)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        async with self._lock:
            subs = list(self._subs.get(run_id, set()))
        for q in subs:
            # best-effort: don't let one slow subscriber block others
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


EVENT_BUS = RunEventBus()

