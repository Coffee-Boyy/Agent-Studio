from __future__ import annotations

import asyncio
from typing import Any, Protocol


class Executor(Protocol):
    async def run(self, *, spec_json: dict[str, Any], inputs_json: dict[str, Any], emit_event): ...


class MockExecutor:
    """
    Default executor for the MVP so the UI can be built without API keys.
    Emits a few lifecycle + "span-ish" events, then returns a final output string.
    """

    async def run(self, *, spec_json: dict[str, Any], inputs_json: dict[str, Any], emit_event):
        await emit_event("run.started", {"inputs": inputs_json, "spec_summary": {"name": spec_json.get("name")}})
        await asyncio.sleep(0.05)

        await emit_event("span.started", {"span_type": "llm", "name": "mock.generate"})
        await asyncio.sleep(0.15)
        await emit_event("span.completed", {"span_type": "llm", "name": "mock.generate", "tokens": 42})

        await emit_event("span.started", {"span_type": "tool", "name": "mock.tool_call"})
        await asyncio.sleep(0.10)
        await emit_event(
            "span.completed",
            {"span_type": "tool", "name": "mock.tool_call", "tool_result": {"ok": True}},
        )

        await asyncio.sleep(0.05)
        output = f"mock_output: processed keys={sorted(list(inputs_json.keys()))}"
        await emit_event("run.completed", {"final_output_preview": output[:200]})
        return output


DEFAULT_EXECUTOR: Executor = MockExecutor()

