from __future__ import annotations

import inspect
from typing import Any, Protocol
from agents import Agent, Runner

from agent_studio_backend.agent_spec import AgentSpecEnvelope
from agent_studio_backend.llm_providers import build_run_config
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph
from agent_studio_backend.services.code_tools import build_code_tool


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
        tool_specs = compiled.get("tools") if isinstance(compiled, dict) else []
        tools = []
        for tool_spec in tool_specs or []:
            tools.append(build_code_tool(tool_spec))

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
            agent_kwargs["tools"] = tools

        agent = Agent(**agent_kwargs)

        input_value = inputs_json.get("input")
        if input_value is None:
            input_value = inputs_json

        runner_kwargs = {}
        run_sig = inspect.signature(Runner.run_streamed)
        if "input" in run_sig.parameters:
            runner_kwargs["input"] = input_value
        elif "messages" in run_sig.parameters:
            runner_kwargs["messages"] = input_value
        if "starting_agent" in run_sig.parameters:
            runner_kwargs["starting_agent"] = agent
        if "agent" in run_sig.parameters:
            runner_kwargs["agent"] = agent
        if "run_config" in run_sig.parameters:
            run_config = build_run_config(llm_connection)
            if run_config is not None:
                runner_kwargs["run_config"] = run_config
        if "context" in run_sig.parameters:
            runner_kwargs["context"] = {"inputs": inputs_json, "spec": compiled}

        await emit_event("span.started", {"span_type": "llm", "name": model_label})
        result = Runner.run_streamed(**runner_kwargs)
        raw_stream_event_id: str | None = None
        raw_stream_payload: dict[str, Any] | None = None
        async for event in result.stream_events():
            if getattr(event, "type", None) == "raw_response_event":
                if raw_stream_payload is None:
                    raw_stream_payload = {"type": event.type, "data": {}}
                delta = _serialize_value(getattr(event, "data", None))
                _merge_stream_delta(raw_stream_payload, delta)
                if raw_stream_event_id is None:
                    created = await emit_event("run.stream_event", raw_stream_payload)
                    raw_stream_event_id = getattr(created, "id", None)
                else:
                    await emit_event(
                        "run.stream_event",
                        raw_stream_payload,
                        update_event_id=raw_stream_event_id,
                    )
                continue
            await emit_event("run.stream_event", _serialize_stream_event(event))
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


def _serialize_stream_event(event: Any) -> dict[str, Any]:
    if hasattr(event, "type") and event.type == "raw_response_event":
        return {"type": event.type, "data": _serialize_value(getattr(event, "data", None))}
    if hasattr(event, "type") and event.type == "run_item_stream_event":
        return {
            "type": event.type,
            "name": getattr(event, "name", None),
            "item": _serialize_run_item(getattr(event, "item", None)),
        }
    if hasattr(event, "type") and event.type == "agent_updated_stream_event":
        agent = getattr(event, "new_agent", None)
        return {
            "type": event.type,
            "new_agent": {"name": getattr(agent, "name", None)},
        }
    return {"type": getattr(event, "type", type(event).__name__), "data": _serialize_value(event)}


def _serialize_run_item(item: Any) -> dict[str, Any]:
    if item is None:
        return {"type": None}
    payload: dict[str, Any] = {"type": getattr(item, "type", type(item).__name__)}
    if hasattr(item, "raw_item"):
        payload["raw_item"] = _serialize_value(getattr(item, "raw_item", None))
    if hasattr(item, "output"):
        payload["output"] = _serialize_value(getattr(item, "output", None))
    if hasattr(item, "source_agent"):
        payload["source_agent"] = {"name": getattr(getattr(item, "source_agent"), "name", None)}
    if hasattr(item, "target_agent"):
        payload["target_agent"] = {"name": getattr(getattr(item, "target_agent"), "name", None)}
    return payload


def _merge_stream_delta(payload: dict[str, Any], delta: Any) -> None:
    if isinstance(delta, dict):
        data = payload.setdefault("data", {})
        if isinstance(data, dict):
            _merge_dict_delta(data, delta)
        else:
            payload["data"] = delta
        return
    if isinstance(delta, str):
        payload["text"] = f"{payload.get('text', '')}{delta}"
        return
    payload["data"] = delta


def _merge_dict_delta(target: dict[str, Any], delta: dict[str, Any]) -> None:
    for key, value in delta.items():
        if key in ("delta", "text", "content") and isinstance(value, str):
            target[key] = f"{target.get(key, '')}{value}"
            continue
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_dict_delta(target[key], value)
            continue
        if isinstance(value, list) and isinstance(target.get(key), list):
            target[key].extend(value)
            continue
        target[key] = value


def _serialize_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if hasattr(value, "model_dump"):
        return _serialize_value(value.model_dump(exclude_unset=True))
    if hasattr(value, "dict"):
        return _serialize_value(value.dict())
    return str(value)


def _extract_model_name(model_cfg: Any) -> str | None:
    if isinstance(model_cfg, dict):
        name = model_cfg.get("name")
        return name if isinstance(name, str) else None
    if isinstance(model_cfg, str):
        return model_cfg
    return None


DEFAULT_EXECUTOR: Executor = AgentsSdkExecutor()

