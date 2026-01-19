from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field

from agent_studio_backend.nodes.base import NodeBase
from agent_studio_backend.nodes.agent import AgentNode as AgentNodeModel
from agent_studio_backend.nodes.input import InputNode
from agent_studio_backend.nodes.loop import LoopNode
from agent_studio_backend.nodes.loop_group import LoopGroupNode
from agent_studio_backend.nodes.output import OutputNode
from agent_studio_backend.nodes.tool import ToolNode
from agent_studio_backend.validation import ValidationIssue


class GraphViewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: float = 1


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: Optional[str] = None
    source_handle: Optional[str] = None
    target_handle: Optional[str] = None


AgentNode = Union[
    InputNode,
    OutputNode,
    AgentNodeModel,
    ToolNode,
    LoopNode,
    LoopGroupNode,
]


class AgentGraphDocV1(BaseModel):
    schema_version: Literal["graph-v1"] = "graph-v1"
    nodes: list[AgentNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    viewport: GraphViewport = Field(default_factory=GraphViewport)
    metadata: dict[str, Any] = Field(default_factory=dict)
    workspace_root: Optional[str] = None


class AgentSpecEnvelope(BaseModel):
    schema_version: Literal["graph-v1"] = "graph-v1"
    graph: AgentGraphDocV1
    compiled: Optional[dict[str, Any]] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


