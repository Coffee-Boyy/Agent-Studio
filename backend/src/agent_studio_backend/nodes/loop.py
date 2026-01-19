from __future__ import annotations

from typing import Literal

from pydantic import Field

from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.nodes.tool import ToolNode
from agent_studio_backend.utils.expressions import ExpressionError, validate_expression
from agent_studio_backend.validation import ValidationIssue


class LoopNode(NodeBase):
    type: Literal["loop"]
    condition: str = ""
    max_iterations: int = Field(default=1, ge=1)


class LoopNodeHandler:
    type = "loop"
    model = LoopNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        node_map = {node.id: node for node in graph.nodes}
        for node in graph.nodes:
            if not isinstance(node, LoopNode):
                continue
            if not node.condition.strip():
                issues.append(
                    ValidationIssue(
                        code="loop.missing_condition",
                        message="Loop node must include a condition expression.",
                        node_id=node.id,
                    )
                )
            if node.max_iterations < 1:
                issues.append(
                    ValidationIssue(
                        code="loop.invalid_limit",
                        message="Loop max iterations must be at least 1.",
                        node_id=node.id,
                    )
                )
            try:
                validate_expression(node.condition)
            except ExpressionError as exc:
                issues.append(
                    ValidationIssue(
                        code="loop.invalid_condition",
                        message=f"Loop condition is not a supported expression: {exc}",
                        node_id=node.id,
                    )
                )
            loop_edges = [
                edge
                for edge in graph.edges
                if edge.source == node.id
                and edge.target in node_map
                and not isinstance(node_map[edge.target], ToolNode)
            ]
            loop_label = _find_edge_with_label(loop_edges, _LOOP_LABELS)
            exit_label = _find_edge_with_label(loop_edges, _EXIT_LABELS)
            if len(loop_edges) != 2 or loop_label is None or exit_label is None:
                issues.append(
                    ValidationIssue(
                        code="loop.edges_missing",
                        message="Loop node must have exactly one 'loop' edge and one 'exit' edge.",
                        node_id=node.id,
                    )
                )
        return issues

    def compile_node(self, node: LoopNode, *, tools: list[dict[str, object]]) -> dict[str, object] | None:
        return None

    async def run(self, node: LoopNode, ctx: RunContext, input_value: object) -> object:
        return input_value


_LOOP_LABELS = {"loop", "true", "continue"}
_EXIT_LABELS = {"exit", "false", "done"}


def _find_edge_with_label(edges, labels: set[str]):
    found = None
    for edge in edges:
        label = (edge.label or "").strip().lower()
        if label in labels:
            if found is not None:
                return None
            found = edge
    return found
