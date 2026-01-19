from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field

from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.validation import ValidationIssue
from agent_studio_backend.services.code_tools import build_code_tool


class ToolNode(NodeBase):
    type: Literal["tool"]
    tool_name: str
    language: str = "python"
    code: str = ""
    # Use `schema_` to avoid colliding with Pydantic's BaseModel.schema() API.
    # Keep JSON compatibility by aliasing to "schema".
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")
    description: Optional[str] = None


class ToolNodeHandler:
    type = "tool"
    model = ToolNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        tool_nodes = get_tool_nodes(graph)
        tool_name_map: dict[str, ToolNode] = {}
        for tool in tool_nodes.values():
            tool_name = tool.tool_name.strip()
            if tool_name in tool_name_map:
                issues.append(
                    ValidationIssue(
                        code="tool.duplicate_name",
                        message="Tool name must be unique.",
                        node_id=tool.id,
                    )
                )
            else:
                tool_name_map[tool_name] = tool
            if tool.schema_ and tool.schema_.get("type") not in (None, "object"):
                issues.append(
                    ValidationIssue(
                        code="tool.invalid_schema",
                        message="Tool schema must be a JSON object schema.",
                        node_id=tool.id,
                    )
                )
        return issues

    def compile_node(self, node: ToolNode, *, tools: list[dict[str, Any]]) -> dict[str, Any] | None:
        return None

    async def run(self, node: ToolNode, ctx: RunContext, input_value: Any) -> Any:
        return input_value


def get_tool_nodes(graph) -> dict[str, ToolNode]:
    return {n.id: n for n in graph.nodes if isinstance(n, ToolNode)}


def collect_tool_ids(graph, node, tool_nodes: dict[str, ToolNode]) -> list[str]:
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


def collect_used_tool_ids(graph) -> set[str]:
    from agent_studio_backend.nodes.agent import AgentNode

    tool_nodes = get_tool_nodes(graph)
    used: set[str] = set()
    for node in graph.nodes:
        if isinstance(node, AgentNode):
            used.update(collect_tool_ids(graph, node, tool_nodes))
    return used


def validate_used_tool_code(
    tool_nodes: dict[str, ToolNode], used_tool_ids: set[str]
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for tool_id in used_tool_ids:
        tool = tool_nodes.get(tool_id)
        if not tool:
            continue
        if not tool.code.strip():
            issues.append(
                ValidationIssue(
                    code="tool.missing_code",
                    message="Tool must include executable code.",
                    node_id=tool.id,
                )
            )
    return issues


def build_tool_specs(tool_ids: list[str], tool_nodes: dict[str, ToolNode]) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for tool_id in tool_ids:
        tool = tool_nodes.get(tool_id)
        if not tool:
            continue
        tools.append(
            {
                "name": tool.tool_name,
                "description": tool.description,
                "schema": tool.schema_,
                "language": tool.language,
                "code": tool.code,
            }
        )
    return tools


def build_tool_instances(tool_ids: list[str], tool_nodes: dict[str, ToolNode]) -> list[Any]:
    return [
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
