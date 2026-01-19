from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class ValidationIssue(BaseModel):
    code: str
    message: str
    node_id: Optional[str] = None
    edge_id: Optional[str] = None
