from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class GuardrailSpec(BaseModel):
    name: str
    rule: str
    blocking: bool = False
    description: Optional[str] = None
