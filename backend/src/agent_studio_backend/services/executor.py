from __future__ import annotations

import asyncio
import inspect
from typing import Any, Protocol

from agent_studio_backend.agent_spec import AgentSpecEnvelope
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph


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


class AgentsSdkExecutor:
    def __init__(self) -> None:
        try:
            from agents import Agent, Runner  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "openai-agents not installed. Install backend with extras: pip install -e '.[agents]'."
            ) from exc
        self._Agent = Agent
        self._Runner = Runner

    async def run(self, *, spec_json: dict[str, Any], inputs_json: dict[str, Any], emit_event):
        envelope = AgentSpecEnvelope.model_validate(spec_json)
        issues = validate_graph(envelope.graph)
        if issues:
            raise RuntimeError(f"spec_invalid: {issues[0].code} {issues[0].message}")

        compiled = compile_to_spec(envelope.graph)
        agent_cfg = compiled["agent"]

        await emit_event(
            "run.started",
            {"inputs": inputs_json, "spec_summary": {"name": agent_cfg.get("name")}},
        )

        Agent = self._Agent
        Runner = self._Runner

        agent_kwargs = {}
        sig = inspect.signature(Agent)
        if "name" in sig.parameters:
            agent_kwargs["name"] = agent_cfg.get("name", "Agent")
        if "instructions" in sig.parameters:
            agent_kwargs["instructions"] = agent_cfg.get("system_prompt", "")
        elif "system_prompt" in sig.parameters:
            agent_kwargs["system_prompt"] = agent_cfg.get("system_prompt", "")
        if "model" in sig.parameters:
            agent_kwargs["model"] = agent_cfg.get("model", {}).get("name") or agent_cfg.get("model")
        if "tools" in sig.parameters:
            agent_kwargs["tools"] = []

        agent = Agent(**agent_kwargs)

        input_value = inputs_json.get("input")
        if input_value is None:
            input_value = inputs_json

        runner_kwargs = {}
        run_sig = inspect.signature(Runner.run)
        if "input" in run_sig.parameters:
            runner_kwargs["input"] = input_value
        elif "messages" in run_sig.parameters:
            runner_kwargs["messages"] = input_value
        if "agent" in run_sig.parameters:
            runner_kwargs["agent"] = agent
        if "trace_processor" in run_sig.parameters:
            runner_kwargs["trace_processor"] = RunEventTraceProcessor(emit_event)
        elif "tracing_processor" in run_sig.parameters:
            runner_kwargs["tracing_processor"] = RunEventTraceProcessor(emit_event)

        await emit_event("span.started", {"span_type": "llm", "name": agent_cfg.get("model")})
        result = await Runner.run(**runner_kwargs)
        await emit_event("span.completed", {"span_type": "llm", "name": agent_cfg.get("model")})

        output = getattr(result, "output", None) if result is not None else None
        if output is None:
            output = str(result)

        await emit_event("run.completed", {"final_output_preview": str(output)[:200]})
        return str(output)


class RunEventTraceProcessor:
    def __init__(self, emit_event) -> None:
        self._emit_event = emit_event

    async def on_span_start(self, span: Any) -> None:
        await self._emit_event("span.started", {"span_type": "sdk", "name": getattr(span, "name", None)})

    async def on_span_end(self, span: Any) -> None:
        await self._emit_event("span.completed", {"span_type": "sdk", "name": getattr(span, "name", None)})


def _load_default_executor() -> Executor:
    try:
        return AgentsSdkExecutor()
    except Exception:
        return MockExecutor()


DEFAULT_EXECUTOR: Executor = _load_default_executor()

