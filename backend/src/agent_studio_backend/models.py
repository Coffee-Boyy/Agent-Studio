from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import Column, JSON
from sqlmodel import Field, SQLModel


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class AgentRevision(SQLModel, table=True):
    __tablename__ = "agent_revisions"

    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    name: str = Field(index=True)
    created_at: datetime = Field(default_factory=now_utc, index=True)
    author: Optional[str] = Field(default=None, index=True)
    content_hash: str = Field(index=True)
    spec_json: dict[str, Any] = Field(sa_column=Column(JSON), default_factory=dict)


class Run(SQLModel, table=True):
    __tablename__ = "runs"

    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    agent_revision_id: str = Field(index=True)
    started_at: datetime = Field(default_factory=now_utc, index=True)
    ended_at: Optional[datetime] = Field(default=None, index=True)
    status: str = Field(default="queued", index=True)  # queued|running|completed|failed|cancelled

    inputs_json: dict[str, Any] = Field(sa_column=Column(JSON), default_factory=dict)
    final_output: Optional[str] = Field(default=None)
    tags_json: dict[str, Any] = Field(sa_column=Column(JSON), default_factory=dict)
    trace_id: Optional[str] = Field(default=None, index=True)
    group_id: Optional[str] = Field(default=None, index=True)
    error: Optional[str] = Field(default=None)

    cancel_requested: bool = Field(default=False, index=True)


class RunEvent(SQLModel, table=True):
    __tablename__ = "run_events"

    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    run_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=now_utc, index=True)
    seq: int = Field(index=True)
    type: str = Field(index=True)
    payload_json: dict[str, Any] = Field(sa_column=Column(JSON), default_factory=dict)

