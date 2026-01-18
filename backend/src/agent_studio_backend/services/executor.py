from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, Protocol
from agents import Agent, Runner

from agent_studio_backend.agent_spec import (
    AgentGraphDocV1,
    AgentSpecEnvelope,
    CodeEditorNode,
    LLMNode,
    ToolNode,
)
from agent_studio_backend.llm_providers import build_run_config
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph
from agent_studio_backend.services.code_tools import build_code_tool
from agent_studio_backend.services.workspace_tools import build_workspace_tools
from agent_studio_backend.settings import get_settings


class Executor(Protocol):
    async def run(
        self,
        *,
        run_id: str,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ): ...


class AgentsSdkExecutor:
    async def run(
        self,
        *,
        run_id: str,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ):
        envelope = AgentSpecEnvelope.model_validate(spec_json)
        graph = envelope.graph
        issues = validate_graph(graph)
        if issues:
            raise RuntimeError(f"spec_invalid: {issues[0].code} {issues[0].message}")

        compiled = compile_to_spec(graph)
        agent_nodes = _resolve_agent_sequence(graph)
        if not agent_nodes:
            raise RuntimeError("spec_invalid: graph.no_agent Graph must include at least one agent node.")

        await emit_event(
            "run.started",
            {"inputs": inputs_json, "spec_summary": {"name": agent_nodes[0].name or "Agent"}},
        )

        settings = get_settings()
        workspace_root = Path(settings.workspaces_dir).expanduser()
        run_workspace = workspace_root / run_id

        input_value = inputs_json.get("input")
        if input_value is None:
            input_value = inputs_json

        output_value: Any = input_value
        for node in agent_nodes:
            tools = _build_tools_for_agent(graph, node, run_workspace)
            agent_cfg = _build_agent_config(node)
            output_value = await _run_agent(
                agent_cfg=agent_cfg,
                tools=tools,
                input_value=output_value,
                llm_connection=llm_connection,
                emit_event=emit_event,
                inputs_json=inputs_json,
                compiled=compiled,
            )

        await emit_event("run.completed", {"final_output_preview": str(output_value)[:200]})
        return str(output_value)


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


def _resolve_agent_sequence(graph: AgentGraphDocV1) -> list[LLMNode | CodeEditorNode]:
    agent_nodes = [n for n in graph.nodes if isinstance(n, (LLMNode, CodeEditorNode))]
    if len(agent_nodes) <= 1:
        return agent_nodes

    agent_ids = {n.id for n in agent_nodes}
    agent_edges = [e for e in graph.edges if e.source in agent_ids and e.target in agent_ids]
    if not agent_edges:
        code_editor = next((n for n in agent_nodes if isinstance(n, CodeEditorNode)), None)
        return [code_editor or agent_nodes[0]]

    connected_ids = {e.source for e in agent_edges} | {e.target for e in agent_edges}
    connected_nodes = [n for n in agent_nodes if n.id in connected_ids]
    if not connected_nodes:
        return [agent_nodes[0]]
    return _topo_sort_agents(connected_nodes, agent_edges)


def _topo_sort_agents(
    nodes: list[LLMNode | CodeEditorNode],
    edges,
) -> list[LLMNode | CodeEditorNode]:
    order: list[LLMNode | CodeEditorNode] = []
    node_map = {n.id: n for n in nodes}
    in_degree = {n.id: 0 for n in nodes}
    outgoing: dict[str, list[str]] = {n.id: [] for n in nodes}
    for edge in edges:
        if edge.source not in node_map or edge.target not in node_map:
            continue
        outgoing[edge.source].append(edge.target)
        in_degree[edge.target] += 1

    queue = [n.id for n in nodes if in_degree[n.id] == 0]
    while queue:
        node_id = queue.pop(0)
        node = node_map.get(node_id)
        if node:
            order.append(node)
        for target in outgoing.get(node_id, []):
            in_degree[target] -= 1
            if in_degree[target] == 0:
                queue.append(target)

    if not order:
        return nodes[:1]
    return order


def _build_agent_config(node: LLMNode | CodeEditorNode) -> dict[str, Any]:
    return {
        "type": "code_editor" if isinstance(node, CodeEditorNode) else "llm",
        "name": node.name or "Agent",
        "system_prompt": node.system_prompt,
        "model": node.model,
        "temperature": node.temperature,
    }


def _build_tools_for_agent(
    graph: AgentGraphDocV1,
    node: LLMNode | CodeEditorNode,
    run_workspace: Path,
) -> list[Any]:
    tool_nodes = {n.id: n for n in graph.nodes if isinstance(n, ToolNode)}
    tool_ids = _collect_tool_ids(graph, node, tool_nodes)
    tools = [
        build_code_tool(
            {
                "name": tool_nodes[tool_id].tool_name,
                "description": tool_nodes[tool_id].description,
                "schema": tool_nodes[tool_id].schema_,
                "language": tool_nodes[tool_id].language,
                "code": tool_nodes[tool_id].code,
            }
        )
        for tool_id in tool_ids
        if tool_id in tool_nodes
    ]
    if isinstance(node, CodeEditorNode):
        workspace_root = run_workspace
        if node.workspace_root:
            workspace_root = Path(node.workspace_root).expanduser()
        tools.extend(build_workspace_tools(workspace_root))
    return tools


def _collect_tool_ids(
    graph: AgentGraphDocV1,
    node: LLMNode | CodeEditorNode,
    tool_nodes: dict[str, ToolNode],
) -> list[str]:
    tool_ids: list[str] = []
    seen: set[str] = set()
    for tool_id in getattr(node, "tools", []) or []:
        if tool_id in seen:
            continue
        seen.add(tool_id)
        tool_ids.append(tool_id)
    for edge in graph.edges:
        if edge.target == node.id and edge.source in tool_nodes and edge.source not in seen:
            seen.add(edge.source)
            tool_ids.append(edge.source)
    return tool_ids


async def _run_agent(
    *,
    agent_cfg: dict[str, Any],
    tools: list[Any],
    input_value: Any,
    llm_connection: dict[str, Any] | None,
    emit_event,
    inputs_json: dict[str, Any],
    compiled: dict[str, Any],
) -> Any:
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

    await emit_event(
        "run.agent_input",
        {
            "node_type": agent_cfg.get("type"),
            "name": agent_cfg.get("name"),
            "model": model_label,
            "input": _serialize_value(input_value),
        },
    )
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
    return output


DEFAULT_EXECUTOR: Executor = AgentsSdkExecutor()

