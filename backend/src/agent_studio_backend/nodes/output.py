from __future__ import annotations

from typing import Any, Literal

from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.validation import ValidationIssue


class OutputNode(NodeBase):
    type: Literal["output"]


class OutputNodeHandler:
    type = "output"
    model = OutputNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        return []

    def compile_node(self, node: OutputNode, *, tools: list[dict[str, Any]]) -> dict[str, Any] | None:
        return None

    async def run(self, node: OutputNode, ctx: RunContext, input_value: Any) -> Any:
        return input_value
