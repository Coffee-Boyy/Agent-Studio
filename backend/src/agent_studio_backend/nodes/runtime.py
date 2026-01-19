from __future__ import annotations

from typing import Any

from agent_studio_backend.agent_spec import AgentGraphDocV1
from agent_studio_backend.nodes.agent import AgentNode
from agent_studio_backend.nodes.base import RunContext
from agent_studio_backend.nodes.registry import DEFAULT_NODE_REGISTRY, NodeRegistry


class GraphRunner:
    def __init__(self, registry: NodeRegistry = DEFAULT_NODE_REGISTRY) -> None:
        self._registry = registry

    def resolve_agent_sequence(self, graph: AgentGraphDocV1) -> list[AgentNode]:
        agent_nodes = [n for n in graph.nodes if isinstance(n, AgentNode)]
        if not agent_nodes:
            return []
        start = _resolve_start_agent(graph, agent_nodes)
        return [start] if start else []

    async def run(self, ctx: RunContext, input_value: Any) -> Any:
        output_value: Any = input_value
        start_nodes = self.resolve_agent_sequence(ctx.graph)
        if not start_nodes:
            return output_value
        handler = self._registry.handler_for_node(start_nodes[0])
        return await handler.run(start_nodes[0], ctx, output_value)


def _resolve_start_agent(graph: AgentGraphDocV1, agent_nodes: list[AgentNode]) -> AgentNode | None:
    if not agent_nodes:
        return None
    input_ids = {n.id for n in graph.nodes if getattr(n, "type", None) == "input"}
    for edge in graph.edges:
        if edge.source in input_ids:
            for node in agent_nodes:
                if node.id == edge.target:
                    return node
    return agent_nodes[0]
