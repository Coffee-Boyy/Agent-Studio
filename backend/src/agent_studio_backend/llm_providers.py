from __future__ import annotations

from typing import Any

from agents.models.multi_provider import MultiProvider
from agents.run import RunConfig

PROVIDERS = ("openai", "anthropic", "local")

OPENAI_COMPATIBLE_PROVIDERS = ("openai", "anthropic", "local")


def normalize_provider(value: Any) -> str | None:
    if isinstance(value, str) and value in PROVIDERS:
        return value
    return None


def build_run_config(llm_connection: dict[str, Any] | None) -> RunConfig | None:
    if not llm_connection:
        return None
    provider = normalize_provider(llm_connection.get("provider"))
    if provider is None:
        return None
    if provider in OPENAI_COMPATIBLE_PROVIDERS:
        return RunConfig(
            model_provider=MultiProvider(
                openai_api_key=llm_connection.get("api_key"),
                openai_base_url=llm_connection.get("base_url"),
                openai_organization=llm_connection.get("organization"),
                openai_project=llm_connection.get("project"),
            )
        )
    return None
