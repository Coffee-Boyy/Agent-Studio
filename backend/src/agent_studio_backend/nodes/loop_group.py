from __future__ import annotations

from typing import Literal

from pydantic import Field

from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.nodes.tool import ToolNode
from agent_studio_backend.utils.expressions import ExpressionError, validate_expression
from agent_studio_backend.validation import ValidationIssue


class LoopGroupNode(NodeBase):
    type: Literal["loop_group"]
    condition: str = ""
    max_iterations: int = Field(default=1, ge=1)
    width: int | None = None
    height: int | None = None


class LoopGroupNodeHandler:
    type = "loop_group"
    model = LoopGroupNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        node_map = {node.id: node for node in graph.nodes}
        for node in graph.nodes:
            if not isinstance(node, LoopGroupNode):
                continue
            if not node.condition.strip():
                issues.append(
                    ValidationIssue(
                        code="loop_group.missing_condition",
                        message="Loop group must include a condition expression.",
                        node_id=node.id,
                    )
                )
            if node.max_iterations < 1:
                issues.append(
                    ValidationIssue(
                        code="loop_group.invalid_limit",
                        message="Loop group max iterations must be at least 1.",
                        node_id=node.id,
                    )
                )
            try:
                validate_expression(node.condition)
            except ExpressionError as exc:
                issues.append(
                    ValidationIssue(
                        code="loop_group.invalid_condition",
                        message=f"Loop condition is not a supported expression: {exc}",
                        node_id=node.id,
                    )
                )
            members = {n.id for n in graph.nodes if getattr(n, "parent_id", None) == node.id}
            if not members:
                issues.append(
                    ValidationIssue(
                        code="loop_group.empty",
                        message="Loop group must contain at least one node.",
                        node_id=node.id,
                    )
                )
                continue
            entry_edges = [
                edge
                for edge in graph.edges
                if edge.target in members
                and edge.source not in members
                and not _edge_has_tool(endpoint=edge.source, node_map=node_map)
            ]
            exit_edges = [
                edge
                for edge in graph.edges
                if edge.source in members
                and edge.target not in members
                and not _edge_has_tool(endpoint=edge.target, node_map=node_map)
            ]
            if len(entry_edges) != 1 or len(exit_edges) != 1:
                issues.append(
                    ValidationIssue(
                        code="loop_group.edges_invalid",
                        message="Loop group must have exactly one entry edge and one exit edge.",
                        node_id=node.id,
                    )
                )
            for edge in graph.edges:
                if edge.source == node.id or edge.target == node.id:
                    issues.append(
                        ValidationIssue(
                            code="loop_group.edge_to_group",
                            message="Loop group node cannot be connected directly by edges.",
                            node_id=node.id,
                            edge_id=edge.id,
                        )
                    )
        return issues

    def compile_node(self, node: LoopGroupNode, *, tools: list[dict[str, object]]) -> dict[str, object] | None:
        return None

    async def run(self, node: LoopGroupNode, ctx: RunContext, input_value: object) -> object:
        return input_value


def _edge_has_tool(*, endpoint: str, node_map: dict[str, NodeBase]) -> bool:
    node = node_map.get(endpoint)
    return isinstance(node, ToolNode)
