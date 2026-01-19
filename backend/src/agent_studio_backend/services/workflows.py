from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session, select

from agent_studio_backend.models import Workflow, WorkflowRevision, now_utc
from agent_studio_backend.utils.hashing import stable_json_hash


class WorkflowService:
    """
    Service for managing workflows and their revisions.

    A Workflow represents the identity of a workflow (name, created_at, etc.)
    while WorkflowRevision stores the actual graph content at different points in time.
    """

    # ─────────────────────────────────────────────────────────────────────────
    # Workflow operations
    # ─────────────────────────────────────────────────────────────────────────

    def create_workflow(
        self,
        session: Session,
        *,
        name: str,
        spec_json: Optional[dict[str, Any]] = None,
        author: Optional[str] = None,
    ) -> tuple[Workflow, Optional[WorkflowRevision]]:
        """
        Create a new workflow. If spec_json is provided, also creates the initial revision.
        Returns a tuple of (workflow, revision) where revision may be None if no spec_json provided.
        """
        workflow = Workflow(name=name)
        session.add(workflow)
        session.commit()
        session.refresh(workflow)

        revision = None
        if spec_json is not None:
            revision = self.create_revision(
                session,
                workflow_id=workflow.id,
                spec_json=spec_json,
                author=author,
            )

        return workflow, revision

    def get_workflow(self, session: Session, workflow_id: str) -> Optional[Workflow]:
        return session.get(Workflow, workflow_id)

    def list_workflows(
        self,
        session: Session,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Workflow]:
        stmt = (
            select(Workflow)
            .order_by(Workflow.updated_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return list(session.exec(stmt).all())

    def update_workflow(
        self,
        session: Session,
        workflow_id: str,
        *,
        name: Optional[str] = None,
    ) -> Optional[Workflow]:
        """Update workflow metadata (like name) without creating a new revision."""
        workflow = session.get(Workflow, workflow_id)
        if not workflow:
            return None

        if name is not None:
            workflow.name = name

        workflow.updated_at = now_utc()
        session.add(workflow)
        session.commit()
        session.refresh(workflow)
        return workflow

    def delete_workflow(self, session: Session, workflow_id: str) -> bool:
        """Delete a workflow and all its revisions."""
        workflow = session.get(Workflow, workflow_id)
        if not workflow:
            return False

        # Delete all revisions first
        stmt = select(WorkflowRevision).where(WorkflowRevision.workflow_id == workflow_id)
        revisions = list(session.exec(stmt).all())
        for rev in revisions:
            session.delete(rev)

        session.delete(workflow)
        session.commit()
        return True

    # ─────────────────────────────────────────────────────────────────────────
    # Revision operations
    # ─────────────────────────────────────────────────────────────────────────

    def create_revision(
        self,
        session: Session,
        *,
        workflow_id: str,
        spec_json: dict[str, Any],
        author: Optional[str] = None,
    ) -> WorkflowRevision:
        """Create a new revision for a workflow."""
        # Hash only the spec_json content, not the workflow name
        content_hash = stable_json_hash({"spec_json": spec_json})

        revision = WorkflowRevision(
            workflow_id=workflow_id,
            author=author,
            content_hash=content_hash,
            spec_json=spec_json,
        )
        session.add(revision)

        # Update workflow's updated_at timestamp
        workflow = session.get(Workflow, workflow_id)
        if workflow:
            workflow.updated_at = now_utc()
            session.add(workflow)

        session.commit()
        session.refresh(revision)
        return revision

    def get_revision(self, session: Session, revision_id: str) -> Optional[WorkflowRevision]:
        return session.get(WorkflowRevision, revision_id)

    def list_revisions(
        self,
        session: Session,
        workflow_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[WorkflowRevision]:
        """List revisions for a specific workflow, newest first."""
        stmt = (
            select(WorkflowRevision)
            .where(WorkflowRevision.workflow_id == workflow_id)
            .order_by(WorkflowRevision.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return list(session.exec(stmt).all())

    def get_latest_revision(
        self,
        session: Session,
        workflow_id: str,
    ) -> Optional[WorkflowRevision]:
        """Get the most recent revision for a workflow."""
        stmt = (
            select(WorkflowRevision)
            .where(WorkflowRevision.workflow_id == workflow_id)
            .order_by(WorkflowRevision.created_at.desc())
            .limit(1)
        )
        return session.exec(stmt).first()

    def get_workflow_with_latest_revision(
        self,
        session: Session,
        workflow_id: str,
    ) -> Optional[tuple[Workflow, Optional[WorkflowRevision]]]:
        """Get a workflow along with its latest revision."""
        workflow = self.get_workflow(session, workflow_id)
        if not workflow:
            return None
        revision = self.get_latest_revision(session, workflow_id)
        return workflow, revision

    def list_workflows_with_latest_revision(
        self,
        session: Session,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[tuple[Workflow, Optional[WorkflowRevision]]]:
        """List workflows along with their latest revisions."""
        workflows = self.list_workflows(session, limit=limit, offset=offset)
        result = []
        for workflow in workflows:
            revision = self.get_latest_revision(session, workflow.id)
            result.append((workflow, revision))
        return result


WORKFLOWS = WorkflowService()
