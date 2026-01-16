from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from agent_studio_backend.settings import get_settings


def create_db_engine() -> Engine:
    settings = get_settings()
    # Ensure SQLite URI form; allow users to provide either a path or a URI.
    if settings.db_path.startswith("sqlite:"):
        url = settings.db_path
    else:
        url = f"sqlite:///{settings.db_path}"
    return create_engine(url, echo=False, connect_args={"check_same_thread": False})


ENGINE: Engine = create_db_engine()


def init_db() -> None:
    SQLModel.metadata.create_all(ENGINE)


@contextmanager
def session_scope():
    with Session(ENGINE) as session:
        yield session

