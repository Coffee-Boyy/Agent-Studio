from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field
from pydantic import ConfigDict

from agent_studio_backend.agent_spec import AgentSpecEnvelope, ValidationIssue


class HealthResponse(BaseModel):
    ok: bool = True


# ─────────────────────────────────────────────────────────────────────────────
# Workflow endpoints
# ─────────────────────────────────────────────────────────────────────────────


class WorkflowCreateRequest(BaseModel):
    name: str
    spec_json: dict[str, Any] = Field(default_factory=dict)
    author: Optional[str] = None


class WorkflowUpdateRequest(BaseModel):
    name: Optional[str] = None


class WorkflowResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime
    updated_at: datetime


class WorkflowWithLatestRevisionResponse(BaseModel):
    """Workflow info combined with its latest revision for convenience."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    latest_revision: Optional["WorkflowRevisionResponse"] = None


class WorkflowRevisionCreateRequest(BaseModel):
    spec_json: dict[str, Any] = Field(default_factory=dict)
    author: Optional[str] = None


class WorkflowRevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    workflow_id: str
    created_at: datetime
    author: Optional[str] = None
    content_hash: str
    spec_json: dict[str, Any]


# ─────────────────────────────────────────────────────────────────────────────
# Legacy agent revision endpoints (kept for backward compatibility)
# ─────────────────────────────────────────────────────────────────────────────


class AgentRevisionCreateRequest(BaseModel):
    name: str
    author: Optional[str] = None
    spec_json: dict[str, Any] = Field(default_factory=dict)


class AgentRevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime
    author: Optional[str] = None
    content_hash: str
    spec_json: dict[str, Any]


class LlmConnection(BaseModel):
    provider: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    organization: Optional[str] = None
    project: Optional[str] = None


class RunCreateRequest(BaseModel):
    # New field - preferred
    workflow_revision_id: Optional[str] = None
    # Legacy field - for backward compatibility
    agent_revision_id: Optional[str] = None
    inputs_json: dict[str, Any] = Field(default_factory=dict)
    tags_json: dict[str, Any] = Field(default_factory=dict)
    group_id: Optional[str] = None
    llm_connection: Optional[LlmConnection] = None


class RunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    workflow_revision_id: str
    # Legacy field - for backward compatibility
    agent_revision_id: Optional[str] = None
    started_at: datetime
    ended_at: Optional[datetime] = None
    status: str
    inputs_json: dict[str, Any]
    final_output: Optional[str] = None
    tags_json: dict[str, Any]
    trace_id: Optional[str] = None
    group_id: Optional[str] = None
    error: Optional[str] = None
    cancel_requested: bool


class RunEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    created_at: datetime
    seq: int
    type: str
    payload_json: dict[str, Any]


class SpecValidateRequest(BaseModel):
    spec: AgentSpecEnvelope


class SpecValidateResponse(BaseModel):
    ok: bool
    issues: list[ValidationIssue]
    normalized: AgentSpecEnvelope


class SpecCompileResponse(BaseModel):
    compiled: dict[str, Any]

