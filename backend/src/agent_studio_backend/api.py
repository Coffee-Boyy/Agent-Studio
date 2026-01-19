from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlmodel import select
from sqlmodel import Session

from agent_studio_backend.db import ENGINE, init_db
from agent_studio_backend.models import RunEvent
from agent_studio_backend.schemas import (
    AgentRevisionCreateRequest,
    AgentRevisionResponse,
    HealthResponse,
    RunCreateRequest,
    RunEventResponse,
    RunResponse,
    SpecCompileResponse,
    SpecValidateRequest,
    SpecValidateResponse,
    WorkflowCreateRequest,
    WorkflowResponse,
    WorkflowRevisionCreateRequest,
    WorkflowRevisionResponse,
    WorkflowUpdateRequest,
    WorkflowWithLatestRevisionResponse,
)
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph
from agent_studio_backend.services.event_bus import EVENT_BUS
from agent_studio_backend.services.revisions import REVISIONS
from agent_studio_backend.services.runs import RUNS, sse_format
from agent_studio_backend.services.workflows import WORKFLOWS
from agent_studio_backend.settings import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Agent Studio Backend", version="0.1.0", lifespan=lifespan)

settings = get_settings()
origins = settings.cors_origins_list()
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True)


@app.post("/v1/spec/validate", response_model=SpecValidateResponse)
def validate_spec(req: SpecValidateRequest) -> SpecValidateResponse:
    issues = validate_graph(req.spec.graph)
    return SpecValidateResponse(ok=not issues, issues=issues, normalized=req.spec)


@app.post("/v1/spec/compile", response_model=SpecCompileResponse)
def compile_spec(req: SpecValidateRequest) -> SpecCompileResponse:
    compiled = compile_to_spec(req.spec.graph)
    return SpecCompileResponse(compiled=compiled)


# ─────────────────────────────────────────────────────────────────────────────
# Workflow endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/v1/workflows", response_model=WorkflowWithLatestRevisionResponse)
def create_workflow(req: WorkflowCreateRequest) -> WorkflowWithLatestRevisionResponse:
    """Create a new workflow with an optional initial revision."""
    with Session(ENGINE) as session:
        workflow, revision = WORKFLOWS.create_workflow(
            session,
            name=req.name,
            spec_json=req.spec_json if req.spec_json else None,
            author=req.author,
        )
        return WorkflowWithLatestRevisionResponse(
            id=workflow.id,
            name=workflow.name,
            created_at=workflow.created_at,
            updated_at=workflow.updated_at,
            latest_revision=WorkflowRevisionResponse.model_validate(revision) if revision else None,
        )


@app.get("/v1/workflows", response_model=list[WorkflowWithLatestRevisionResponse])
def list_workflows(limit: int = 100, offset: int = 0) -> list[WorkflowWithLatestRevisionResponse]:
    """List all workflows with their latest revisions."""
    with Session(ENGINE) as session:
        results = WORKFLOWS.list_workflows_with_latest_revision(
            session,
            limit=min(limit, 500),
            offset=max(offset, 0),
        )
        return [
            WorkflowWithLatestRevisionResponse(
                id=workflow.id,
                name=workflow.name,
                created_at=workflow.created_at,
                updated_at=workflow.updated_at,
                latest_revision=WorkflowRevisionResponse.model_validate(revision) if revision else None,
            )
            for workflow, revision in results
        ]


@app.get("/v1/workflows/{workflow_id}", response_model=WorkflowWithLatestRevisionResponse)
def get_workflow(workflow_id: str) -> WorkflowWithLatestRevisionResponse:
    """Get a workflow by ID with its latest revision."""
    with Session(ENGINE) as session:
        result = WORKFLOWS.get_workflow_with_latest_revision(session, workflow_id)
        if not result:
            raise HTTPException(status_code=404, detail="workflow_not_found")
        workflow, revision = result
        return WorkflowWithLatestRevisionResponse(
            id=workflow.id,
            name=workflow.name,
            created_at=workflow.created_at,
            updated_at=workflow.updated_at,
            latest_revision=WorkflowRevisionResponse.model_validate(revision) if revision else None,
        )


@app.put("/v1/workflows/{workflow_id}", response_model=WorkflowResponse)
def update_workflow(workflow_id: str, req: WorkflowUpdateRequest) -> WorkflowResponse:
    """Update workflow metadata (e.g., rename) without creating a new revision."""
    with Session(ENGINE) as session:
        workflow = WORKFLOWS.update_workflow(session, workflow_id, name=req.name)
        if not workflow:
            raise HTTPException(status_code=404, detail="workflow_not_found")
        return WorkflowResponse.model_validate(workflow)


@app.delete("/v1/workflows/{workflow_id}")
def delete_workflow_by_id(workflow_id: str) -> dict[str, Any]:
    """Delete a workflow and all its revisions."""
    with Session(ENGINE) as session:
        deleted = WORKFLOWS.delete_workflow(session, workflow_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="workflow_not_found")
        return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# Workflow revision endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/v1/workflows/{workflow_id}/revisions", response_model=WorkflowRevisionResponse)
def create_workflow_revision(workflow_id: str, req: WorkflowRevisionCreateRequest) -> WorkflowRevisionResponse:
    """Create a new revision for an existing workflow."""
    with Session(ENGINE) as session:
        workflow = WORKFLOWS.get_workflow(session, workflow_id)
        if not workflow:
            raise HTTPException(status_code=404, detail="workflow_not_found")
        revision = WORKFLOWS.create_revision(
            session,
            workflow_id=workflow_id,
            spec_json=req.spec_json,
            author=req.author,
        )
        return WorkflowRevisionResponse.model_validate(revision)


@app.get("/v1/workflows/{workflow_id}/revisions", response_model=list[WorkflowRevisionResponse])
def list_workflow_revisions(workflow_id: str, limit: int = 100, offset: int = 0) -> list[WorkflowRevisionResponse]:
    """List all revisions for a workflow."""
    with Session(ENGINE) as session:
        workflow = WORKFLOWS.get_workflow(session, workflow_id)
        if not workflow:
            raise HTTPException(status_code=404, detail="workflow_not_found")
        revisions = WORKFLOWS.list_revisions(
            session,
            workflow_id,
            limit=min(limit, 500),
            offset=max(offset, 0),
        )
        return [WorkflowRevisionResponse.model_validate(r) for r in revisions]


@app.get("/v1/workflow-revisions/{revision_id}", response_model=WorkflowRevisionResponse)
def get_workflow_revision(revision_id: str) -> WorkflowRevisionResponse:
    """Get a specific workflow revision by ID."""
    with Session(ENGINE) as session:
        revision = WORKFLOWS.get_revision(session, revision_id)
        if not revision:
            raise HTTPException(status_code=404, detail="revision_not_found")
        return WorkflowRevisionResponse.model_validate(revision)


# ─────────────────────────────────────────────────────────────────────────────
# Legacy agent revision endpoints (kept for backward compatibility)
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/v1/agent-revisions", response_model=AgentRevisionResponse)
def create_agent_revision(req: AgentRevisionCreateRequest) -> AgentRevisionResponse:
    with Session(ENGINE) as session:
        rev = REVISIONS.create(session, name=req.name, author=req.author, spec_json=req.spec_json)
        return AgentRevisionResponse.model_validate(rev)


@app.get("/v1/agent-revisions", response_model=list[AgentRevisionResponse])
def list_agent_revisions(limit: int = 100, offset: int = 0) -> list[AgentRevisionResponse]:
    with Session(ENGINE) as session:
        revs = REVISIONS.list(session, limit=min(limit, 500), offset=max(offset, 0))
        return [AgentRevisionResponse.model_validate(r) for r in revs]


@app.get("/v1/agent-revisions/{revision_id}", response_model=AgentRevisionResponse)
def get_agent_revision(revision_id: str) -> AgentRevisionResponse:
    with Session(ENGINE) as session:
        rev = REVISIONS.get(session, revision_id)
        if not rev:
            raise HTTPException(status_code=404, detail="agent_revision_not_found")
        return AgentRevisionResponse.model_validate(rev)


# ─────────────────────────────────────────────────────────────────────────────
# Run endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/v1/runs", response_model=RunResponse)
async def create_run(req: RunCreateRequest) -> RunResponse:
    with Session(ENGINE) as session:
        # Support both new workflow_revision_id and legacy agent_revision_id
        revision_id = req.workflow_revision_id or req.agent_revision_id
        if not revision_id:
            raise HTTPException(status_code=400, detail="workflow_revision_id or agent_revision_id required")

        # Try new workflow revision first, then fall back to legacy
        revision = WORKFLOWS.get_revision(session, revision_id)
        if revision:
            spec_json = dict(revision.spec_json)
        else:
            # Fall back to legacy agent revision
            rev = REVISIONS.get(session, revision_id)
            if not rev:
                raise HTTPException(status_code=404, detail="revision_not_found")
            spec_json = dict(rev.spec_json)

        run = RUNS.create_run(
            session,
            workflow_revision_id=revision_id,
            inputs_json=req.inputs_json,
            tags_json=req.tags_json,
            group_id=req.group_id,
        )

    # Execute in background using a new session per DB interaction.
    async def _bg():
        await RUNS.execute_run(
            run_id=run.id,
            session_factory=lambda: Session(ENGINE),
            spec_json=spec_json,
            inputs_json=req.inputs_json,
            llm_connection=req.llm_connection.model_dump() if req.llm_connection else None,
        )

    asyncio.create_task(_bg())

    with Session(ENGINE) as session:
        fresh = RUNS.get_run(session, run.id)
        assert fresh is not None
        return RunResponse.model_validate(fresh)


@app.get("/v1/runs/{run_id}", response_model=RunResponse)
def get_run(run_id: str) -> RunResponse:
    with Session(ENGINE) as session:
        run = RUNS.get_run(session, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run_not_found")
        return RunResponse.model_validate(run)


@app.get("/v1/runs", response_model=list[RunResponse])
def list_runs(
    revision_id: Optional[str] = None,
    workflow_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[RunResponse]:
    with Session(ENGINE) as session:
        runs = RUNS.list_runs(
            session,
            revision_id=revision_id,
            workflow_id=workflow_id,
            limit=min(limit, 500),
            offset=max(offset, 0),
        )
        return [RunResponse.model_validate(r) for r in runs]


@app.post("/v1/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, Any]:
    with Session(ENGINE) as session:
        ok = RUNS.request_cancel(session, run_id)
        if not ok:
            raise HTTPException(status_code=404, detail="run_not_found")
        return {"ok": True}


@app.get("/v1/runs/{run_id}/events", response_model=list[RunEventResponse])
def list_run_events(run_id: str, limit: int = 500, offset: int = 0) -> list[RunEventResponse]:
    with Session(ENGINE) as session:
        run = RUNS.get_run(session, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run_not_found")
        events = RUNS.list_events(session, run_id, limit=min(limit, 2000), offset=max(offset, 0))
        return [RunEventResponse.model_validate(e) for e in events]


@app.get("/v1/runs/{run_id}/events/stream")
async def stream_run_events(run_id: str, after_seq: Optional[int] = None):
    """
    SSE stream for live run monitoring. Clients can pass `after_seq` to resume.
    """

    async def gen():
        # First, emit backlog (if requested)
        if after_seq is not None:
            with Session(ENGINE) as session:
                stmt = (
                    select(RunEvent)
                    .where(RunEvent.run_id == run_id)
                    .where(RunEvent.seq > int(after_seq))
                    .order_by(RunEvent.seq.asc())
                )
                backlog = list(session.exec(stmt).all())
                for ev in backlog:
                    data = {
                        "id": ev.id,
                        "run_id": ev.run_id,
                        "created_at": ev.created_at.isoformat(),
                        "seq": ev.seq,
                        "type": ev.type,
                        "payload_json": ev.payload_json,
                    }
                    yield sse_format("run_event", data)

        q = await EVENT_BUS.subscribe(run_id)
        try:
            # keepalive every 15s so proxies don't buffer forever
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield sse_format("run_event", ev)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await EVENT_BUS.unsubscribe(run_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream")

