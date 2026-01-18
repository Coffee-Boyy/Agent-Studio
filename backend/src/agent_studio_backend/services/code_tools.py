from __future__ import annotations

import inspect
import json
from typing import Any, Callable

try:
    from agents import FunctionTool, ToolContext
except ImportError:  # pragma: no cover - compatibility for newer agents API
    from agents import FunctionTool
    try:
        from agents.tool_context import ToolContext  # type: ignore
    except Exception:
        ToolContext = Any  # type: ignore[misc,assignment]

ToolCallable = Callable[..., Any]


def build_code_tool(tool_spec: dict[str, Any]) -> FunctionTool:
    name = str(tool_spec.get("name") or "").strip()
    description = tool_spec.get("description") or ""
    language = str(tool_spec.get("language") or "python").lower()
    code = str(tool_spec.get("code") or "")
    schema = tool_spec.get("schema") or {}

    if not name:
        raise RuntimeError("tool_missing_name")
    if language != "python":
        raise RuntimeError(f"tool_language_unsupported: {language}")

    params_schema = _ensure_object_schema(schema)
    run_func = _load_run_function(code, name=name)

    async def _on_invoke(ctx: ToolContext[Any], input_json: str) -> Any:
        try:
            payload = json.loads(input_json) if input_json else {}
        except Exception as exc:  # noqa: BLE001
            return f"Invalid JSON input for tool {name}: {exc}"
        if not isinstance(payload, dict):
            return f"Invalid JSON input for tool {name}: expected object."

        try:
            result = _call_tool_function(run_func, ctx, payload)
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as exc:  # noqa: BLE001
            return f"Tool {name} failed: {exc}"

    return FunctionTool(
        name=name,
        description=str(description),
        params_json_schema=params_schema,
        on_invoke_tool=_on_invoke,
        strict_json_schema=True,
    )


def _load_run_function(code: str, *, name: str) -> ToolCallable:
    if not code.strip():
        raise RuntimeError(f"tool_missing_code: {name}")

    globals_dict: dict[str, Any] = {"__builtins__": __builtins__}
    locals_dict: dict[str, Any] = {}
    exec(code, globals_dict, locals_dict)
    run_func = locals_dict.get("run") or globals_dict.get("run")
    if not callable(run_func):
        raise RuntimeError(f"tool_missing_run_function: {name}")
    return run_func


def _call_tool_function(run_func: ToolCallable, ctx: ToolContext[Any], payload: dict[str, Any]) -> Any:
    try:
        sig = inspect.signature(run_func)
        sig.bind(ctx, **payload)
        return run_func(ctx, **payload)
    except TypeError:
        return run_func(**payload)


def _ensure_object_schema(schema: Any) -> dict[str, Any]:
    if isinstance(schema, dict) and schema:
        return schema
    return {"type": "object", "properties": {}, "additionalProperties": False}
