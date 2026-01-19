from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from agent_studio_backend.agent_spec import AgentSpecEnvelope
from agent_studio_backend.nodes.base import RunContext
from agent_studio_backend.nodes.runtime import GraphRunner
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph
from agent_studio_backend.services.process_manager import ProcessManager
from agent_studio_backend.settings import get_settings


class Executor(Protocol):
    async def run(
        self,
        *,
        run_id: str,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ): ...


class AgentsSdkExecutor:
    async def run(
        self,
        *,
        run_id: str,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: dict[str, Any] | None,
        emit_event,
    ):
        envelope = AgentSpecEnvelope.model_validate(spec_json)
        graph = envelope.graph
        issues = validate_graph(graph)
        if issues:
            raise RuntimeError(f"spec_invalid: {issues[0].code} {issues[0].message}")

        compiled = compile_to_spec(graph)
        runner = GraphRunner()
        agent_nodes = runner.resolve_agent_sequence(graph)
        if not agent_nodes:
            raise RuntimeError("spec_invalid: graph.no_agent Graph must include at least one agent node.")

        await emit_event(
            "run.started",
            {"inputs": inputs_json, "spec_summary": {"name": agent_nodes[0].name or "Agent"}},
        )

        settings = get_settings()
        workspace_root = Path(settings.workspaces_dir).expanduser()
        run_workspace = workspace_root / run_id

        input_value = inputs_json.get("input")
        if input_value is None:
            input_value = inputs_json

        services: dict[str, Any] = {"process_manager": ProcessManager()}
        run_ctx = RunContext(
            run_id=run_id,
            graph=graph,
            compiled=compiled,
            inputs_json=inputs_json,
            llm_connection=llm_connection,
            emit_event=emit_event,
            run_workspace=run_workspace,
            services=services,
        )
        try:
            output_value: Any = await runner.run(run_ctx, input_value)
            await emit_event("run.completed", {"final_output_preview": str(output_value)[:200]})
            return str(output_value)
        finally:
            process_manager = services.get("process_manager")
            if process_manager:
                process_manager.cleanup_run(run_id)
            screenshot_service = services.get("screenshot_service")
            if screenshot_service:
                await screenshot_service.close()


class RunEventTraceProcessor:
    def __init__(self, emit_event) -> None:
        self._emit_event = emit_event

    async def on_span_start(self, span: Any) -> None:
        await self._emit_event("span.started", {"span_type": "sdk", "name": getattr(span, "name", None)})

    async def on_span_end(self, span: Any) -> None:
        await self._emit_event("span.completed", {"span_type": "sdk", "name": getattr(span, "name", None)})




DEFAULT_EXECUTOR: Executor = AgentsSdkExecutor()

