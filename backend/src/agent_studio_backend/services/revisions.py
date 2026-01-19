from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session, select

from agent_studio_backend.models import AgentRevision
from agent_studio_backend.utils.hashing import stable_json_hash


class AgentRevisionService:
    def create(
        self,
        session: Session,
        *,
        name: str,
        author: Optional[str],
        spec_json: dict[str, Any],
    ) -> AgentRevision:
        content_hash = stable_json_hash({"name": name, "author": author, "spec_json": spec_json})
        rev = AgentRevision(name=name, author=author, content_hash=content_hash, spec_json=spec_json)
        session.add(rev)
        session.commit()
        session.refresh(rev)
        return rev

    def get(self, session: Session, revision_id: str) -> Optional[AgentRevision]:
        return session.get(AgentRevision, revision_id)

    def list(self, session: Session, *, limit: int = 100, offset: int = 0) -> list[AgentRevision]:
        stmt = select(AgentRevision).order_by(AgentRevision.created_at.desc()).offset(offset).limit(limit)
        return list(session.exec(stmt).all())

    def delete_by_name(self, session: Session, *, name: str) -> int:
        stmt = select(AgentRevision).where(AgentRevision.name == name)
        revisions = list(session.exec(stmt).all())
        for rev in revisions:
            session.delete(rev)
        session.commit()
        return len(revisions)


REVISIONS = AgentRevisionService()

