from __future__ import annotations

import inspect
from typing import Any, Protocol
from agents import Agent, Runner

from agent_studio_backend.agent_spec import AgentSpecEnvelope
from agent_studio_backend.llm_providers import build_run_config
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph


class Executor(Protocol):
    async def run(
        self,
        *,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ): ...


class AgentsSdkExecutor:
    async def run(
        self,
        *,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ):
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

        model_label = _extract_model_name(agent_cfg.get("model"))

        agent_kwargs = {}
        sig = inspect.signature(Agent)
        if "name" in sig.parameters:
            agent_kwargs["name"] = agent_cfg.get("name", "Agent")
        if "instructions" in sig.parameters:
            agent_kwargs["instructions"] = agent_cfg.get("system_prompt", "")
        elif "system_prompt" in sig.parameters:
            agent_kwargs["system_prompt"] = agent_cfg.get("system_prompt", "")
        if "model" in sig.parameters and model_label:
            agent_kwargs["model"] = model_label
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
        if "starting_agent" in run_sig.parameters:
            runner_kwargs["starting_agent"] = agent
        if "agent" in run_sig.parameters:
            runner_kwargs["agent"] = agent
        if "trace_processor" in run_sig.parameters:
            runner_kwargs["trace_processor"] = RunEventTraceProcessor(emit_event)
        elif "tracing_processor" in run_sig.parameters:
            runner_kwargs["tracing_processor"] = RunEventTraceProcessor(emit_event)
        if "run_config" in run_sig.parameters:
            run_config = build_run_config(llm_connection)
            if run_config is not None:
                runner_kwargs["run_config"] = run_config

        await emit_event("span.started", {"span_type": "llm", "name": model_label})
        result = await Runner.run(**runner_kwargs)
        await emit_event("span.completed", {"span_type": "llm", "name": model_label})

        output = result.final_output if result is not None else None
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


def _extract_model_name(model_cfg: Any) -> str | None:
    if isinstance(model_cfg, dict):
        name = model_cfg.get("name")
        return name if isinstance(name, str) else None
    if isinstance(model_cfg, str):
        return model_cfg
    return None


DEFAULT_EXECUTOR: Executor = AgentsSdkExecutor()

