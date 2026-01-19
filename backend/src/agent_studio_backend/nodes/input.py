from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from agent_studio_backend.nodes.base import NodeBase, RunContext
from agent_studio_backend.validation import ValidationIssue


class InputNode(NodeBase):
    type: Literal["input"]
    # Use `schema_` to avoid colliding with Pydantic's BaseModel.schema() API.
    # Keep JSON compatibility by aliasing to "schema".
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")


class InputNodeHandler:
    type = "input"
    model = InputNode

    def validate_graph(self, graph) -> list[ValidationIssue]:
        return []

    def compile_node(self, node: InputNode, *, tools: list[dict[str, Any]]) -> dict[str, Any] | None:
        return None

    async def run(self, node: InputNode, ctx: RunContext, input_value: Any) -> Any:
        return input_value
