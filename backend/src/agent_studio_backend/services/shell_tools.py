from __future__ import annotations

import inspect
import json
import shlex
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

try:
    from agents import FunctionTool, ToolContext
except ImportError:  # pragma: no cover - compatibility for newer agents API
    from agents import FunctionTool
    try:
        from agents.tool_context import ToolContext  # type: ignore
    except Exception:
        ToolContext = Any  # type: ignore[misc,assignment]

from agent_studio_backend.services.process_manager import ProcessManager
from agent_studio_backend.services.sandbox import SandboxMode, SandboxService

ToolHandler = Callable[..., Any] | Callable[..., Awaitable[Any]]

MAX_OUTPUT_BYTES = 64 * 1024
MAX_TIMEOUT_SECONDS = 300


def build_shell_tools(
    *,
    run_id: str,
    workspace_root: Path,
    process_manager: ProcessManager,
) -> list[FunctionTool]:
    sandbox_service = SandboxService(workspace_root=workspace_root)

    def run_shell(command: str, timeout: int | None = None, working_dir: str | None = None, allow_network: bool = False):
        cmd_list = _split_command(command)
        timeout_value = _clamp_timeout(timeout)
        cwd = _resolve_workspace_path(workspace_root, working_dir)
        mode = SandboxMode.NETWORK_ALLOWED if allow_network else SandboxMode.WORKSPACE_WRITE

        result = sandbox_service.run_command(cmd_list, cwd=cwd, mode=mode, timeout=timeout_value)
        return {
            "stdout": _truncate_output(result.stdout),
            "stderr": _truncate_output(result.stderr),
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "sandboxed": result.sandboxed,
        }

    def start_process(
        command: str,
        name: str,
        working_dir: str | None = None,
        allow_network: bool = True,
    ):
        cmd_list = _split_command(command)
        cwd = _resolve_workspace_path(workspace_root, working_dir)
        mode = SandboxMode.NETWORK_ALLOWED if allow_network else SandboxMode.WORKSPACE_WRITE

        sand = sandbox_service.spawn_process(cmd_list, cwd=cwd, mode=mode)
        process_id = f"{name}-{uuid4().hex[:8]}"
        handle = process_manager.start_process(
            run_id=run_id,
            process_id=process_id,
            name=name,
            command=command,
            popen=sand.process,
        )
        return {"process_id": handle.process_id, "pid": sand.process.pid, "sandboxed": sand.sandboxed}

    def stop_process(process_id: str):
        stopped, exit_code = process_manager.stop_process(run_id=run_id, process_id=process_id)
        return {"stopped": stopped, "exit_code": exit_code}

    def get_process_output(process_id: str, lines: int | None = None):
        output = process_manager.get_output(run_id=run_id, process_id=process_id, lines=lines or 50)
        return output

    return [
        _make_tool(
            name="run_shell",
            description="Run a shell command inside the sandbox.",
            params_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer", "minimum": 1, "maximum": MAX_TIMEOUT_SECONDS},
                    "working_dir": {"type": "string"},
                    "allow_network": {"type": "boolean"},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
            handler=run_shell,
        ),
        _make_tool(
            name="start_process",
            description="Start a long-running process inside the sandbox.",
            params_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "name": {"type": "string"},
                    "working_dir": {"type": "string"},
                    "allow_network": {"type": "boolean"},
                },
                "required": ["command", "name"],
                "additionalProperties": False,
            },
            handler=start_process,
        ),
        _make_tool(
            name="stop_process",
            description="Stop a running background process.",
            params_schema={
                "type": "object",
                "properties": {"process_id": {"type": "string"}},
                "required": ["process_id"],
                "additionalProperties": False,
            },
            handler=stop_process,
        ),
        _make_tool(
            name="get_process_output",
            description="Fetch recent output from a background process.",
            params_schema={
                "type": "object",
                "properties": {
                    "process_id": {"type": "string"},
                    "lines": {"type": "integer", "minimum": 1, "maximum": 500},
                },
                "required": ["process_id"],
                "additionalProperties": False,
            },
            handler=get_process_output,
        ),
    ]


def _split_command(command: str) -> list[str]:
    if not command or not command.strip():
        raise RuntimeError("command_required")
    return shlex.split(command)


def _clamp_timeout(timeout: int | None) -> int:
    if timeout is None:
        return 30
    return max(1, min(int(timeout), MAX_TIMEOUT_SECONDS))


def _resolve_workspace_path(workspace_root: Path, working_dir: str | None) -> Path:
    base = workspace_root.resolve()
    if not working_dir:
        return base
    normalized = working_dir.strip().lstrip("/\\")
    target = (base / normalized).resolve()
    if target == base or base in target.parents:
        return target
    raise RuntimeError("working_dir_outside_workspace")


def _truncate_output(value: str) -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return value
    truncated = encoded[-MAX_OUTPUT_BYTES:]
    return truncated.decode("utf-8", errors="replace")


def _make_tool(name: str, description: str, params_schema: dict[str, Any], handler: ToolHandler) -> FunctionTool:
    async def _on_invoke(ctx: ToolContext[Any], input_json: str) -> Any:
        try:
            payload = json.loads(input_json) if input_json else {}
        except Exception as exc:  # noqa: BLE001
            return f"Invalid JSON input for tool {name}: {exc}"
        if not isinstance(payload, dict):
            return f"Invalid JSON input for tool {name}: expected object."
        try:
            result = handler(**payload)
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as exc:  # noqa: BLE001
            return f"Tool {name} failed: {exc}"

    return FunctionTool(
        name=name,
        description=description,
        params_json_schema=params_schema,
        on_invoke_tool=_on_invoke,
        strict_json_schema=True,
    )
