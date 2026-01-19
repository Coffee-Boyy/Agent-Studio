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
)
from agent_studio_backend.services.compiler import compile_to_spec, validate_graph
from agent_studio_backend.services.event_bus import EVENT_BUS
from agent_studio_backend.services.revisions import REVISIONS
from agent_studio_backend.services.runs import RUNS, sse_format
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


@app.delete("/v1/workflows/{workflow_name}")
def delete_workflow(workflow_name: str) -> dict[str, Any]:
    with Session(ENGINE) as session:
        deleted = REVISIONS.delete_by_name(session, name=workflow_name)
        return {"deleted": deleted}


@app.post("/v1/runs", response_model=RunResponse)
async def create_run(req: RunCreateRequest) -> RunResponse:
    with Session(ENGINE) as session:
        rev = REVISIONS.get(session, req.agent_revision_id)
        if not rev:
            raise HTTPException(status_code=404, detail="agent_revision_not_found")
        spec_json = dict(rev.spec_json)

        run = RUNS.create_run(
            session,
            agent_revision_id=req.agent_revision_id,
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
    workflow_name: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[RunResponse]:
    with Session(ENGINE) as session:
        runs = RUNS.list_runs(
            session,
            revision_id=revision_id,
            workflow_name=workflow_name,
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

