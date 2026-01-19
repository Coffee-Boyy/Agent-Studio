from __future__ import annotations

from typing import Iterable

from agent_studio_backend.nodes.base import NodeBase, NodeHandler
from agent_studio_backend.nodes.agent import AgentNodeHandler
from agent_studio_backend.nodes.input import InputNodeHandler
from agent_studio_backend.nodes.output import OutputNodeHandler
from agent_studio_backend.nodes.tool import ToolNodeHandler


class NodeRegistry:
    def __init__(self, handlers: Iterable[NodeHandler]) -> None:
        self._handlers = {handler.type: handler for handler in handlers}

    def handler_for_type(self, node_type: str) -> NodeHandler:
        handler = self._handlers.get(node_type)
        if not handler:
            raise RuntimeError(f"node_type_unknown: {node_type}")
        return handler

    def handler_for_node(self, node: NodeBase) -> NodeHandler:
        return self.handler_for_type(node.type)

    def handlers(self) -> list[NodeHandler]:
        return list(self._handlers.values())


DEFAULT_NODE_REGISTRY = NodeRegistry(
    [
        InputNodeHandler(),
        OutputNodeHandler(),
        AgentNodeHandler(),
        ToolNodeHandler(),
    ]
)
