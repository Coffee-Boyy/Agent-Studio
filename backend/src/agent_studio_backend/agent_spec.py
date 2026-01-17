from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class GraphPosition(BaseModel):
    x: float
    y: float


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


class NodeBase(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str
    type: str
    name: Optional[str] = None
    position: GraphPosition


class InputNode(NodeBase):
    type: Literal["input"]
    # Use `schema_` to avoid colliding with Pydantic's BaseModel.schema() API.
    # Keep JSON compatibility by aliasing to "schema".
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")


class OutputNode(NodeBase):
    type: Literal["output"]


class LLMNode(NodeBase):
    type: Literal["llm"]
    system_prompt: str = ""
    model: dict[str, Any] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list)
    temperature: Optional[float] = None


class ToolNode(NodeBase):
    type: Literal["tool"]
    tool_name: str
    # Use `schema_` to avoid colliding with Pydantic's BaseModel.schema() API.
    # Keep JSON compatibility by aliasing to "schema".
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")
    description: Optional[str] = None


class GuardrailNode(NodeBase):
    type: Literal["guardrail"]
    rule: str = ""


class RouterNode(NodeBase):
    type: Literal["router"]
    strategy: str = "first"


class HandoffNode(NodeBase):
    type: Literal["handoff"]
    target_agent_id: str


class SubAgentNode(NodeBase):
    type: Literal["subagent"]
    agent_name: str
    system_prompt: str = ""


AgentNode = Union[
    InputNode,
    OutputNode,
    LLMNode,
    ToolNode,
    GuardrailNode,
    RouterNode,
    HandoffNode,
    SubAgentNode,
]


class AgentGraphDocV1(BaseModel):
    schema_version: Literal["graph-v1"] = "graph-v1"
    nodes: list[AgentNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    viewport: GraphViewport = Field(default_factory=GraphViewport)
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentSpecEnvelope(BaseModel):
    schema_version: Literal["graph-v1"] = "graph-v1"
    graph: AgentGraphDocV1
    compiled: Optional[dict[str, Any]] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ValidationIssue(BaseModel):
    code: str
    message: str
    node_id: Optional[str] = None
    edge_id: Optional[str] = None
