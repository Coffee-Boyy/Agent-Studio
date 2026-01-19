from __future__ import annotations

from typing import Any

from agent_studio_backend.agent_spec import AgentGraphDocV1, AgentSpecEnvelope, ValidationIssue
from agent_studio_backend.nodes.agent import AgentNode
from agent_studio_backend.nodes.registry import DEFAULT_NODE_REGISTRY
from agent_studio_backend.nodes.tool import (
    build_tool_specs,
    collect_tool_ids,
    collect_used_tool_ids,
    get_tool_nodes,
    validate_used_tool_code,
)


def validate_graph(doc: AgentGraphDocV1) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    node_ids = set()
    for node in doc.nodes:
        if node.id in node_ids:
            issues.append(
                ValidationIssue(code="node.duplicate_id", message="Duplicate node id.", node_id=node.id)
            )
        node_ids.add(node.id)

    for edge in doc.edges:
        if edge.source not in node_ids:
            issues.append(
                ValidationIssue(
                    code="edge.missing_source",
                    message="Edge source not found.",
                    edge_id=edge.id,
                )
            )
        if edge.target not in node_ids:
            issues.append(
                ValidationIssue(
                    code="edge.missing_target",
                    message="Edge target not found.",
                    edge_id=edge.id,
                )
            )

    connected_ids = {e.source for e in doc.edges} | {e.target for e in doc.edges}
    for node in doc.nodes:
        if node.id not in connected_ids:
            issues.append(
                ValidationIssue(
                    code="node.disconnected",
                    message="Node is not connected to any edge.",
                    node_id=node.id,
                )
            )

    agent_nodes = [n for n in doc.nodes if isinstance(n, AgentNode)]
    if not agent_nodes:
        issues.append(
            ValidationIssue(code="graph.no_agent", message="Graph must include at least one agent node.")
        )

    for handler in DEFAULT_NODE_REGISTRY.handlers():
        issues.extend(handler.validate_graph(doc))

    tool_nodes = get_tool_nodes(doc)
    used_tool_ids = collect_used_tool_ids(doc)
    issues.extend(validate_used_tool_code(tool_nodes, used_tool_ids))
    return issues


def compile_to_spec(doc: AgentGraphDocV1) -> dict[str, Any]:
    agent_nodes = [n for n in doc.nodes if isinstance(n, AgentNode)]
    if not agent_nodes:
        return {"agent": {}, "tools": []}
    primary = agent_nodes[0]
    tool_nodes = get_tool_nodes(doc)
    tool_ids = collect_tool_ids(doc, primary, tool_nodes)
    tools = build_tool_specs(tool_ids, tool_nodes)

    handler = DEFAULT_NODE_REGISTRY.handler_for_node(primary)
    agent = handler.compile_node(primary, tools=tools) or {}
    return {"agent": agent, "tools": tools}


def normalize_spec(envelope: AgentSpecEnvelope) -> AgentSpecEnvelope:
    return envelope
