from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import Field

from agent_studio_backend.guardrails import GuardrailSpec
from agent_studio_backend.nodes.agent_runtime import build_agent, run_agent_stream
from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.nodes.tool import build_tool_instances, collect_tool_ids, get_tool_nodes
from agent_studio_backend.services.process_manager import ProcessManager
from agent_studio_backend.services.screenshot import ScreenshotService, build_screenshot_tools
from agent_studio_backend.services.shell_tools import build_shell_tools
from agent_studio_backend.services.workspace_tools import build_workspace_tools
from agent_studio_backend.validation import ValidationIssue


class AgentNode(NodeBase):
    type: Literal["agent"]
    instructions: str = ""
    model: dict[str, Any] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list)
    temperature: Optional[float] = None
    input_guardrails: list[GuardrailSpec] = Field(default_factory=list)
    output_guardrails: list[GuardrailSpec] = Field(default_factory=list)
    output_type: Optional[dict[str, Any]] = None
    workspace_root: Optional[str] = None
    sandbox_tools: bool = True


class AgentNodeHandler:
    type = "agent"
    model = AgentNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        tool_nodes = get_tool_nodes(graph)
        for node in graph.nodes:
            if not isinstance(node, AgentNode):
                continue
            if not node.model:
                issues.append(
                    ValidationIssue(
                        code="agent.missing_model",
                        message="Agent node must include a model definition.",
                        node_id=node.id,
                    )
                )
            for tool_id in collect_tool_ids(graph, node, tool_nodes):
                if tool_id not in tool_nodes:
                    issues.append(
                        ValidationIssue(
                            code="agent.missing_tool",
                            message="Agent references a tool that does not exist.",
                            node_id=node.id,
                        )
                    )
        return issues

    def compile_node(self, node: AgentNode, *, tools: list[dict[str, Any]]) -> dict[str, Any] | None:
        return {
            "type": "agent",
            "name": node.name or "Agent",
            "instructions": node.instructions,
            "model": node.model,
            "temperature": node.temperature,
            "tools": [t["name"] for t in tools],
            "handoffs": [],
            "input_guardrails": [g.model_dump(exclude_none=True) for g in node.input_guardrails],
            "output_guardrails": [g.model_dump(exclude_none=True) for g in node.output_guardrails],
            "output_type": node.output_type,
        }

    async def run(self, node: AgentNode, ctx: RunContext, input_value: Any) -> Any:
        tool_nodes = get_tool_nodes(ctx.graph)
        tool_ids = collect_tool_ids(ctx.graph, node, tool_nodes)
        tools = build_tool_instances(tool_ids, tool_nodes)
        tools.extend(_workspace_tools(node, ctx))

        handoff_agents = _build_handoff_agents(ctx, node)
        input_guardrails = _build_guardrail_callables(node.input_guardrails)
        output_guardrails = _build_guardrail_callables(node.output_guardrails)
        agent_cfg = _build_agent_cfg(node)

        return await run_agent_stream(
            agent_cfg=agent_cfg,
            tools=tools,
            handoffs=handoff_agents,
            input_guardrails=input_guardrails,
            output_guardrails=output_guardrails,
            output_type=node.output_type,
            input_value=input_value,
            llm_connection=ctx.llm_connection,
            emit_event=ctx.emit_event,
            inputs_json=ctx.inputs_json,
            compiled=ctx.compiled,
        )


def _workspace_tools(node: AgentNode, ctx: RunContext) -> list[Any]:
    if not node.workspace_root:
        return []
    workspace_root = Path(node.workspace_root).expanduser()
    tools = build_workspace_tools(workspace_root)
    if not node.sandbox_tools:
        return tools

    services = ctx.services
    process_manager = services.get("process_manager")
    if process_manager is None:
        process_manager = ProcessManager()
        services["process_manager"] = process_manager

    screenshot_service = services.get("screenshot_service")
    if screenshot_service is None:
        screenshot_service = ScreenshotService(workspace_root=workspace_root)
        services["screenshot_service"] = screenshot_service

    tools.extend(
        build_shell_tools(
            run_id=ctx.run_id,
            workspace_root=workspace_root,
            process_manager=process_manager,
        )
    )
    tools.extend(build_screenshot_tools(service=screenshot_service))
    return tools


def _build_agent_cfg(node: AgentNode) -> dict[str, Any]:
    return {
        "type": "agent",
        "name": node.name or "Agent",
        "instructions": node.instructions,
        "model": node.model,
        "temperature": node.temperature,
    }


def _build_handoff_agents(ctx: RunContext, node: AgentNode) -> list[Any]:
    agent_nodes = {n.id: n for n in ctx.graph.nodes if isinstance(n, AgentNode)}
    tool_nodes = get_tool_nodes(ctx.graph)
    targets = [
        agent_nodes.get(edge.target)
        for edge in ctx.graph.edges
        if edge.source == node.id and edge.target in agent_nodes
    ]
    agents: list[Any] = []
    for target in targets:
        if not target:
            continue
        tool_ids = collect_tool_ids(ctx.graph, target, tool_nodes)
        tools = build_tool_instances(tool_ids, tool_nodes)
        tools.extend(_workspace_tools(target, ctx))
        input_guardrails = _build_guardrail_callables(target.input_guardrails)
        output_guardrails = _build_guardrail_callables(target.output_guardrails)
        agent_cfg = _build_agent_cfg(target)
        agents.append(
            build_agent(
                agent_cfg=agent_cfg,
                tools=tools,
                handoffs=[],
                input_guardrails=input_guardrails,
                output_guardrails=output_guardrails,
                output_type=target.output_type,
            )
        )
    return agents


def _build_guardrail_callables(specs: list[GuardrailSpec]) -> list[Any]:
    callables: list[Any] = []
    for spec in specs:
        def _guardrail(*_args, **_kwargs):  # noqa: ANN001, ARG001
            return None
        _guardrail.__name__ = f"guardrail_{spec.name.replace(' ', '_')}"
        callables.append(_guardrail)
    return callables
