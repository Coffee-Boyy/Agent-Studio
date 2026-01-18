from __future__ import annotations

import inspect
import json
import os
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from agents import FunctionTool, ToolContext
except ImportError:  # pragma: no cover - compatibility for newer agents API
    from agents import FunctionTool
    try:
        from agents.tool_context import ToolContext  # type: ignore
    except Exception:
        ToolContext = Any  # type: ignore[misc,assignment]

ToolHandler = Callable[..., Any] | Callable[..., Awaitable[Any]]


def build_workspace_tools(workspace_root: Path) -> list[FunctionTool]:
    workspace_root.mkdir(parents=True, exist_ok=True)

    def list_files(
        path: str | None = None,
        max_depth: int = 6,
        max_entries: int = 500,
    ) -> dict[str, Any]:
        base = _resolve_path(workspace_root, path, allow_root=True)
        if not base.exists():
            return {"entries": [], "truncated": False, "missing": True}
        if base.is_file():
            return {"entries": [str(base.relative_to(workspace_root))], "truncated": False}
        entries: list[str] = []
        truncated = False
        root_depth = len(base.relative_to(workspace_root).parts)
        for current, dirs, files in os.walk(base):
            rel = Path(current).relative_to(workspace_root)
            depth = len(rel.parts) - root_depth
            if depth > max_depth:
                dirs[:] = []
                continue
            for name in sorted(dirs):
                entries.append(f"{rel / name}/")
                if len(entries) >= max_entries:
                    truncated = True
                    break
            if truncated:
                break
            for name in sorted(files):
                entries.append(str(rel / name))
                if len(entries) >= max_entries:
                    truncated = True
                    break
            if truncated:
                break
        return {"entries": entries, "truncated": truncated}

    def read_file(path: str) -> dict[str, Any]:
        target = _resolve_path(workspace_root, path)
        if not target.exists() or target.is_dir():
            raise RuntimeError("path_not_file")
        content = target.read_text(encoding="utf-8", errors="replace")
        return {"path": str(target.relative_to(workspace_root)), "content": content}

    def write_file(path: str, content: str, mode: str = "overwrite") -> dict[str, Any]:
        target = _resolve_path(workspace_root, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if mode not in ("overwrite", "append"):
            raise RuntimeError("mode_invalid")
        if mode == "append":
            with target.open("a", encoding="utf-8", errors="replace", newline="") as handle:
                handle.write(content)
        else:
            target.write_text(content, encoding="utf-8", errors="replace", newline="")
        return {"path": str(target.relative_to(workspace_root)), "bytes": len(content.encode("utf-8"))}

    def delete_path(path: str, recursive: bool = False) -> dict[str, Any]:
        target = _resolve_path(workspace_root, path)
        if not target.exists():
            return {"path": str(target.relative_to(workspace_root)), "deleted": False}
        if target.is_dir():
            if not recursive:
                raise RuntimeError("path_is_directory")
            shutil.rmtree(target)
        else:
            target.unlink()
        return {"path": str(target.relative_to(workspace_root)), "deleted": True}

    return [
        _make_tool(
            name="list_workspace",
            description="List files in the workspace. Paths are relative to the workspace root.",
            params_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "max_depth": {"type": "integer", "minimum": 0, "maximum": 20},
                    "max_entries": {"type": "integer", "minimum": 1, "maximum": 5000},
                },
                "additionalProperties": False,
            },
            handler=list_files,
        ),
        _make_tool(
            name="read_file",
            description="Read a file from the workspace. Paths are relative to the workspace root.",
            params_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            handler=read_file,
        ),
        _make_tool(
            name="write_file",
            description="Create or overwrite a file in the workspace. Paths are relative to the workspace root.",
            params_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "mode": {"type": "string", "enum": ["overwrite", "append"]},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
            handler=write_file,
        ),
        _make_tool(
            name="delete_file",
            description="Delete a file or directory in the workspace. Paths are relative to the workspace root.",
            params_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}, "recursive": {"type": "boolean"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            handler=delete_path,
        ),
    ]


def _resolve_path(root: Path, path: str | None, *, allow_root: bool = False) -> Path:
    if not path:
        if allow_root:
            return root
        raise RuntimeError("path_required")
    normalized = path.strip().lstrip("/\\")
    target = (root / normalized).resolve()
    if target == root or root in target.parents:
        return target
    raise RuntimeError("path_outside_workspace")


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
