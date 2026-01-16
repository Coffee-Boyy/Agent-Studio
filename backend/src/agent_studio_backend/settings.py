from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = Field(default="./agent_studio.sqlite", alias="AGENT_STUDIO_DB_PATH")
    allow_cors_origins: str = Field(default="", alias="AGENT_STUDIO_ALLOW_CORS_ORIGINS")
    log_level: str = Field(default="info", alias="AGENT_STUDIO_LOG_LEVEL")

    def cors_origins_list(self) -> list[str]:
        raw = (self.allow_cors_origins or "").strip()
        if not raw:
            return []
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


SettingsDep = Annotated[Settings, Field(default_factory=get_settings)]

