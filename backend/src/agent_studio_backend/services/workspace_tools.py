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
    root_resolved = workspace_root.resolve()

    def list_files(
        path: str | None = None,
        max_depth: int = 6,
        max_entries: int = 500,
    ) -> dict[str, Any]:
        base = _resolve_path(workspace_root, path, allow_root=True)
        if not base.exists():
            return {"entries": [], "truncated": False, "missing": True}
        if base.is_file():
            return {"entries": [_relative_to_root(root_resolved, base)], "truncated": False}
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
        return {"path": _relative_to_root(root_resolved, target), "content": content}

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
        return {"path": _relative_to_root(root_resolved, target), "bytes": len(content.encode("utf-8"))}

    def delete_path(path: str, recursive: bool = False) -> dict[str, Any]:
        target = _resolve_path(workspace_root, path)
        if not target.exists():
            return {"path": _relative_to_root(root_resolved, target), "deleted": False}
        if target.is_dir():
            if not recursive:
                raise RuntimeError("path_is_directory")
            shutil.rmtree(target)
        else:
            target.unlink()
        return {"path": _relative_to_root(root_resolved, target), "deleted": True}

    def apply_patch(patch: str) -> dict[str, Any]:
        if not patch or not patch.strip():
            raise RuntimeError("patch_required")
        file_patches = _parse_unified_diff(patch)
        results: list[dict[str, Any]] = []
        for file_patch in file_patches:
            result = _apply_file_patch(root_resolved, file_patch)
            results.append(result)
        return {"applied": len(results), "results": results}

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
        _make_tool(
            name="apply_patch",
            description="Apply a unified diff patch to files in the workspace.",
            params_schema={
                "type": "object",
                "properties": {"patch": {"type": "string"}},
                "required": ["patch"],
                "additionalProperties": False,
            },
            handler=apply_patch,
        ),
    ]


def _resolve_path(root: Path, path: str | None, *, allow_root: bool = False) -> Path:
    if not path:
        if allow_root:
            return root
        raise RuntimeError("path_required")
    normalized = path.strip().lstrip("/\\")
    root_resolved = root.resolve()
    target = (root_resolved / normalized).resolve()
    if target == root_resolved or root_resolved in target.parents:
        return target
    raise RuntimeError("path_outside_workspace")


def _relative_to_root(root: Path, target: Path) -> str:
    return str(target.resolve().relative_to(root.resolve()))


def _parse_unified_diff(patch: str) -> list[dict[str, Any]]:
    lines = patch.splitlines(keepends=True)
    file_patches: list[dict[str, Any]] = []
    idx = 0

    def _strip_path(raw: str) -> str:
        cleaned = raw.strip()
        if cleaned.startswith(("a/", "b/")):
            return cleaned[2:]
        return cleaned

    while idx < len(lines):
        line = lines[idx]
        if line.startswith("diff --git "):
            idx += 1
            continue
        if line.startswith("--- "):
            old_path = _strip_path(line[4:].strip())
            idx += 1
            if idx >= len(lines) or not lines[idx].startswith("+++ "):
                raise RuntimeError("patch_missing_new_path")
            new_path = _strip_path(lines[idx][4:].strip())
            idx += 1
            hunks: list[dict[str, Any]] = []
            while idx < len(lines) and lines[idx].startswith("@@ "):
                header = lines[idx].strip()
                idx += 1
                old_info, new_info = header.split(" @@")[0][3:].split(" ")
                old_start, old_len = _parse_hunk_range(old_info)
                new_start, new_len = _parse_hunk_range(new_info)
                hunk_lines: list[dict[str, str]] = []
                while idx < len(lines) and lines[idx][:1] in (" ", "+", "-"):
                    hunk_lines.append({"kind": lines[idx][:1], "text": lines[idx][1:]})
                    idx += 1
                hunks.append(
                    {
                        "old_start": old_start,
                        "old_len": old_len,
                        "new_start": new_start,
                        "new_len": new_len,
                        "lines": hunk_lines,
                    }
                )
            file_patches.append(
                {"old_path": old_path, "new_path": new_path, "hunks": hunks}
            )
            continue
        idx += 1
    return file_patches


def _parse_hunk_range(token: str) -> tuple[int, int]:
    if token.startswith("-") or token.startswith("+"):
        token = token[1:]
    if "," in token:
        start_str, len_str = token.split(",", 1)
        return int(start_str), int(len_str)
    return int(token), 1


def _apply_file_patch(root: Path, file_patch: dict[str, Any]) -> dict[str, Any]:
    old_path = file_patch["old_path"]
    new_path = file_patch["new_path"]
    hunks = file_patch["hunks"]
    if old_path == "/dev/null":
        target_rel = new_path
        op = "create"
    elif new_path == "/dev/null":
        target_rel = old_path
        op = "delete"
    else:
        target_rel = new_path
        op = "update"

    target = _resolve_path(root, target_rel)
    if op == "create" and target.exists():
        raise RuntimeError(f"patch_create_exists: {target_rel}")
    if op in ("update", "delete") and not target.exists():
        raise RuntimeError(f"patch_missing_file: {target_rel}")

    if op == "delete":
        if hunks:
            content = target.read_text(encoding="utf-8", errors="replace")
            lines = content.splitlines(keepends=True)
            lines = _apply_hunks(lines, hunks, target_rel)
            if "".join(lines):
                raise RuntimeError(f"patch_delete_not_empty: {target_rel}")
        target.unlink()
        return {"path": target_rel, "operation": "delete"}

    lines: list[str] = []
    if op == "update" and target.exists():
        content = target.read_text(encoding="utf-8", errors="replace")
        lines = content.splitlines(keepends=True)
    lines = _apply_hunks(lines, hunks, target_rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(lines), encoding="utf-8", errors="replace", newline="")
    return {"path": target_rel, "operation": op, "bytes": len("".join(lines).encode("utf-8"))}


def _apply_hunks(lines: list[str], hunks: list[dict[str, Any]], path: str) -> list[str]:
    offset = 0
    for hunk in hunks:
        start = hunk["old_start"] - 1 + offset
        if start < 0 or start > len(lines):
            raise RuntimeError(f"patch_hunk_out_of_range: {path}")
        idx = start
        for entry in hunk["lines"]:
            kind = entry["kind"]
            if kind in (" ", "-"):
                if idx >= len(lines) or lines[idx] != entry["text"]:
                    raise RuntimeError(f"patch_hunk_mismatch: {path}")
                idx += 1
        new_chunk: list[str] = []
        idx = start
        for entry in hunk["lines"]:
            kind = entry["kind"]
            if kind == " ":
                new_chunk.append(lines[idx])
                idx += 1
            elif kind == "-":
                idx += 1
            elif kind == "+":
                new_chunk.append(entry["text"])
        lines = lines[:start] + new_chunk + lines[idx:]
        offset += len(new_chunk) - (idx - start)
    return lines


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
