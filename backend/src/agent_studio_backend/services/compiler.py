from __future__ import annotations

from typing import Any

from agent_studio_backend.agent_spec import (
    AgentGraphDocV1,
    AgentSpecEnvelope,
    LLMNode,
    ToolNode,
    ValidationIssue,
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

    llm_nodes = [n for n in doc.nodes if isinstance(n, LLMNode)]
    if not llm_nodes:
        issues.append(ValidationIssue(code="graph.no_llm", message="Graph must include at least one LLM node."))
    else:
        for node in llm_nodes:
            if not node.model:
                issues.append(
                    ValidationIssue(
                        code="llm.missing_model",
                        message="LLM node must include a model definition.",
                        node_id=node.id,
                    )
                )

    tool_nodes = {n.id: n for n in doc.nodes if isinstance(n, ToolNode)}
    for node in llm_nodes:
        for tool_id in node.tools:
            if tool_id not in tool_nodes:
                issues.append(
                    ValidationIssue(
                        code="llm.missing_tool",
                        message="LLM references a tool that does not exist.",
                        node_id=node.id,
                    )
                )

    return issues


def compile_to_spec(doc: AgentGraphDocV1) -> dict[str, Any]:
    llm_nodes = [n for n in doc.nodes if isinstance(n, LLMNode)]
    primary = llm_nodes[0]
    tool_nodes = {n.id: n for n in doc.nodes if isinstance(n, ToolNode)}

    tools: list[dict[str, Any]] = []
    for tool_id in primary.tools:
        tool = tool_nodes.get(tool_id)
        if not tool:
            continue
        tools.append(
            {
                "name": tool.tool_name,
                "description": tool.description,
                "schema": tool.schema_,
            }
        )

    return {
        "agent": {
            "name": primary.name or "Agent",
            "system_prompt": primary.system_prompt,
            "model": primary.model,
            "temperature": primary.temperature,
            "tools": [t["name"] for t in tools],
        },
        "tools": tools,
    }


def normalize_spec(envelope: AgentSpecEnvelope) -> AgentSpecEnvelope:
    return envelope
