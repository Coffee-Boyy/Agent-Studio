from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Session, select

from agent_studio_backend.models import Run, RunEvent, now_utc
from agent_studio_backend.services.event_bus import EVENT_BUS
from agent_studio_backend.services.executor import DEFAULT_EXECUTOR, Executor


class RunService:
    def __init__(self, *, executor: Executor = DEFAULT_EXECUTOR) -> None:
        self._executor = executor
        self._seq_locks: dict[str, asyncio.Lock] = {}
        self._seq_locks_lock = asyncio.Lock()

    async def _get_seq_lock(self, run_id: str) -> asyncio.Lock:
        async with self._seq_locks_lock:
            lock = self._seq_locks.get(run_id)
            if lock is None:
                lock = asyncio.Lock()
                self._seq_locks[run_id] = lock
            return lock

    def create_run(
        self,
        session: Session,
        *,
        agent_revision_id: str,
        inputs_json: dict[str, Any],
        tags_json: dict[str, Any],
        group_id: Optional[str],
    ) -> Run:
        run = Run(
            agent_revision_id=agent_revision_id,
            inputs_json=inputs_json,
            tags_json=tags_json,
            group_id=group_id,
            status="queued",
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        return run

    def get_run(self, session: Session, run_id: str) -> Optional[Run]:
        return session.get(Run, run_id)

    def list_events(self, session: Session, run_id: str, *, limit: int = 500, offset: int = 0) -> list[RunEvent]:
        stmt = (
            select(RunEvent)
            .where(RunEvent.run_id == run_id)
            .order_by(RunEvent.seq.asc())
            .offset(offset)
            .limit(limit)
        )
        return list(session.exec(stmt).all())

    def request_cancel(self, session: Session, run_id: str) -> bool:
        run = session.get(Run, run_id)
        if not run:
            return False
        run.cancel_requested = True
        session.add(run)
        session.commit()
        return True

    async def emit_event(self, session: Session, *, run_id: str, type: str, payload_json: dict[str, Any]) -> RunEvent:
        """
        Persist event with a monotonic per-run `seq`, then publish to the in-process bus for SSE.
        """
        lock = await self._get_seq_lock(run_id)
        async with lock:
            # Get next seq (single-writer per run expected, but keep it safe).
            stmt = select(RunEvent.seq).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.desc()).limit(1)
            last = session.exec(stmt).first()
            next_seq = int(last or 0) + 1

            ev = RunEvent(run_id=run_id, seq=next_seq, type=type, payload_json=payload_json)
            session.add(ev)
            session.commit()
            session.refresh(ev)

        await EVENT_BUS.publish(
            run_id,
            {
                "id": ev.id,
                "run_id": ev.run_id,
                "created_at": ev.created_at.isoformat(),
                "seq": ev.seq,
                "type": ev.type,
                "payload_json": ev.payload_json,
            },
        )
        return ev

    async def _set_run_status(
        self,
        session: Session,
        *,
        run_id: str,
        status: str,
        ended_at: Optional[datetime] = None,
        final_output: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        run = session.get(Run, run_id)
        if not run:
            return
        run.status = status
        run.ended_at = ended_at
        run.final_output = final_output
        run.error = error
        session.add(run)
        session.commit()

    async def execute_run(
        self,
        *,
        run_id: str,
        session_factory,
        spec_json: dict[str, Any],
        inputs_json: dict[str, Any],
        llm_connection: Optional[dict[str, Any]] = None,
    ):
        """
        Background execution entrypoint.
        `session_factory` should return a fresh sqlmodel.Session (thread-safe).
        """
        with session_factory() as session:
            await self._set_run_status(session, run_id=run_id, status="running")

        async def emit(type: str, payload: dict[str, Any]):
            with session_factory() as session:
                run = session.get(Run, run_id)
                if not run:
                    raise RuntimeError("run_not_found")
                if run.cancel_requested:
                    raise CancelledError("cancel_requested")
                await self.emit_event(session, run_id=run_id, type=type, payload_json=payload)

        try:
            output = await self._executor.run(
                spec_json=spec_json,
                inputs_json=inputs_json,
                llm_connection=llm_connection,
                emit_event=emit,
            )
            with session_factory() as session:
                await self._set_run_status(session, run_id=run_id, status="completed", ended_at=now_utc(), final_output=output)
        except CancelledError as e:
            with session_factory() as session:
                await self.emit_event(session, run_id=run_id, type="run.cancelled", payload_json={"reason": str(e)})
                await self._set_run_status(session, run_id=run_id, status="cancelled", ended_at=now_utc())
        except Exception as e:  # noqa: BLE001
            with session_factory() as session:
                await self.emit_event(
                    session,
                    run_id=run_id,
                    type="run.failed",
                    payload_json={"error": str(e), "error_type": type(e).__name__},
                )
                await self._set_run_status(session, run_id=run_id, status="failed", ended_at=now_utc(), error=str(e))


class CancelledError(Exception):
    pass


RUNS = RunService()


def sse_format(event_type: str, data: dict[str, Any]) -> str:
    """
    Format one SSE message. `data` is emitted as JSON.
    """
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"

