from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Protocol

from pydantic import BaseModel, ConfigDict


class GraphPosition(BaseModel):
    x: float
    y: float


class NodeBase(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str
    type: str
    name: Optional[str] = None
    position: GraphPosition


@dataclass(frozen=True)
class RunContext:
    run_id: str
    graph: "AgentGraphDocV1"
    compiled: dict[str, Any]
    inputs_json: dict[str, Any]
    llm_connection: dict[str, Any] | None
    emit_event: Callable[[str, dict[str, Any]], Awaitable[Any]]
    run_workspace: Path
    services: dict[str, Any] = field(default_factory=dict)


class NodeHandler(Protocol):
    type: str
    model: type[NodeBase]

    def validate_graph(self, graph: "AgentGraphDocV1") -> list["ValidationIssue"]: ...

    def compile_node(self, node: NodeBase, *, tools: list[dict[str, Any]]) -> dict[str, Any] | None: ...

    async def run(self, node: NodeBase, ctx: RunContext, input_value: Any) -> Any: ...
