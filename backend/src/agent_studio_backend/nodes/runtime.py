from __future__ import annotations

from typing import Any

from agent_studio_backend.agent_spec import AgentGraphDocV1
from agent_studio_backend.nodes.agent import AgentNode
from agent_studio_backend.nodes.input import InputNode
from agent_studio_backend.nodes.loop import LoopNode
from agent_studio_backend.nodes.loop_group import LoopGroupNode
from agent_studio_backend.nodes.tool import ToolNode
from agent_studio_backend.nodes.base import RunContext
from agent_studio_backend.nodes.registry import DEFAULT_NODE_REGISTRY, NodeRegistry
from agent_studio_backend.utils.expressions import ExpressionError, evaluate_expression


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
        nodes_by_id = {node.id: node for node in ctx.graph.nodes}
        flow_edges = [
            edge
            for edge in ctx.graph.edges
            if _is_flow_edge(edge, nodes_by_id)
        ]
        loop_groups = _build_loop_groups(ctx.graph.nodes, flow_edges, nodes_by_id)
        start_node = _resolve_start_node(ctx.graph, nodes_by_id, flow_edges)
        if not start_node:
            return output_value

        loop_counts: dict[str, int] = {}
        state: dict[str, Any] = {}
        current = start_node
        while current:
            handler = self._registry.handler_for_node(current)
            if isinstance(current, LoopNode):
                iteration = loop_counts.get(current.id, 0)
                context = {
                    "last": output_value,
                    "inputs": ctx.inputs_json,
                    "state": state,
                    "iteration": iteration,
                    "max_iterations": current.max_iterations,
                }
                try:
                    should_loop = evaluate_expression(current.condition, context)
                except ExpressionError as exc:
                    raise RuntimeError(f"loop_invalid_condition: {exc}") from exc

                loop_edge, exit_edge = _resolve_loop_edges(current, flow_edges, nodes_by_id)
                if should_loop:
                    if iteration >= current.max_iterations:
                        await ctx.emit_event(
                            "run.loop.limit_reached",
                            {
                                "node_id": current.id,
                                "max_iterations": current.max_iterations,
                                "iteration": iteration,
                            },
                        )
                        current = nodes_by_id.get(exit_edge.target)
                    else:
                        loop_counts[current.id] = iteration + 1
                        current = nodes_by_id.get(loop_edge.target)
                else:
                    current = nodes_by_id.get(exit_edge.target)
                continue

            output_value = await handler.run(current, ctx, output_value)
            next_node, exiting_group_id = _resolve_next_node(current, flow_edges, nodes_by_id, loop_groups)
            if exiting_group_id:
                group_meta = loop_groups.get(exiting_group_id)
                if group_meta is None:
                    raise RuntimeError("loop_group_not_found")
                iteration = loop_counts.get(exiting_group_id, 0)
                context = {
                    "last": output_value,
                    "inputs": ctx.inputs_json,
                    "state": state,
                    "iteration": iteration,
                    "max_iterations": group_meta["max_iterations"],
                }
                try:
                    should_loop = evaluate_expression(group_meta["condition"], context)
                except ExpressionError as exc:
                    raise RuntimeError(f"loop_group_invalid_condition: {exc}") from exc
                if should_loop and iteration < group_meta["max_iterations"]:
                    loop_counts[exiting_group_id] = iteration + 1
                    current = nodes_by_id.get(group_meta["entry_target_id"])
                else:
                    if should_loop and iteration >= group_meta["max_iterations"]:
                        await ctx.emit_event(
                            "run.loop.limit_reached",
                            {
                                "node_id": exiting_group_id,
                                "max_iterations": group_meta["max_iterations"],
                                "iteration": iteration,
                            },
                        )
                    current = next_node
            else:
                current = next_node
        return output_value


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


def _resolve_start_node(
    graph: AgentGraphDocV1,
    nodes_by_id: dict[str, Any],
    flow_edges,
) -> Any | None:
    input_nodes = [node for node in graph.nodes if isinstance(node, InputNode)]
    if input_nodes:
        input_ids = {node.id for node in input_nodes}
        for edge in flow_edges:
            if edge.source in input_ids:
                return nodes_by_id.get(edge.source)
        return input_nodes[0]
    agent_nodes = [node for node in graph.nodes if isinstance(node, AgentNode)]
    return agent_nodes[0] if agent_nodes else None


def _is_flow_edge(edge, nodes_by_id: dict[str, Any]) -> bool:
    source = nodes_by_id.get(edge.source)
    target = nodes_by_id.get(edge.target)
    if not source or not target:
        return False
    if isinstance(source, ToolNode) or isinstance(target, ToolNode):
        return False
    if isinstance(source, LoopGroupNode) or isinstance(target, LoopGroupNode):
        return False
    if isinstance(source, AgentNode) and isinstance(target, AgentNode):
        return False
    return True


def _resolve_next_node(current, edges, nodes_by_id: dict[str, Any], loop_groups: dict[str, dict[str, Any]]):
    outgoing = [edge for edge in edges if edge.source == current.id]
    if not outgoing:
        return None, None
    group_id = _loop_group_id_for_node(current, nodes_by_id)
    if group_id and group_id in loop_groups:
        group_meta = loop_groups[group_id]
        internal_edges = [
            edge for edge in outgoing if edge.target in group_meta["members"]
        ]
        if internal_edges:
            return nodes_by_id.get(internal_edges[0].target), None
        exit_edges = [
            edge for edge in outgoing if edge.target == group_meta["exit_target_id"]
        ]
        if exit_edges:
            return nodes_by_id.get(exit_edges[0].target), group_id
        return nodes_by_id.get(outgoing[0].target), None
    return nodes_by_id.get(outgoing[0].target), None


def _resolve_loop_edges(loop_node: LoopNode, edges, nodes_by_id: dict[str, Any]):
    loop_edge = None
    exit_edge = None
    for edge in edges:
        if edge.source != loop_node.id:
            continue
        label = (edge.label or "").strip().lower()
        if label in {"loop", "true", "continue"}:
            loop_edge = edge
        elif label in {"exit", "false", "done"}:
            exit_edge = edge
    if loop_edge is None or exit_edge is None:
        raise RuntimeError("loop_edges_invalid")
    return loop_edge, exit_edge


def _build_loop_groups(nodes, edges, nodes_by_id: dict[str, Any]) -> dict[str, dict[str, Any]]:
    loop_groups = {node.id: node for node in nodes if isinstance(node, LoopGroupNode)}
    if not loop_groups:
        return {}
    members_map: dict[str, set[str]] = {group_id: set() for group_id in loop_groups}
    for node in nodes:
        parent_id = getattr(node, "parent_id", None)
        if parent_id in members_map:
            members_map[parent_id].add(node.id)
    meta: dict[str, dict[str, Any]] = {}
    for group_id, group in loop_groups.items():
        members = members_map.get(group_id, set())
        entry_edges = [edge for edge in edges if edge.target in members and edge.source not in members]
        exit_edges = [edge for edge in edges if edge.source in members and edge.target not in members]
        entry_target_id = entry_edges[0].target if entry_edges else None
        exit_target_id = exit_edges[0].target if exit_edges else None
        meta[group_id] = {
            "condition": group.condition,
            "max_iterations": group.max_iterations,
            "members": members,
            "entry_target_id": entry_target_id,
            "exit_target_id": exit_target_id,
        }
    return meta


def _loop_group_id_for_node(node, nodes_by_id: dict[str, Any]) -> str | None:
    parent_id = getattr(node, "parent_id", None)
    if not parent_id:
        return None
    parent = nodes_by_id.get(parent_id)
    if isinstance(parent, LoopGroupNode):
        return parent_id
    return None
