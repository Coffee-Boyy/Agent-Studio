from __future__ import annotations

import os

import uvicorn


def run() -> None:
    host = os.environ.get("AGENT_STUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("AGENT_STUDIO_PORT", "37123"))
    uvicorn.run("agent_studio_backend.api:app", host=host, port=port, reload=False)

