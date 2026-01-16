# Agent Studio Backend (Python)

Local-first **Agent Runner** + **trace storage** service for Agent Studio.

This service is designed to match the backend shape described in `PLAN.md`:
- versioned **agent revisions**
- persisted **runs**
- per-run **events/spans**
- live monitoring via **server-sent events (SSE)**

## Quickstart

From `backend/`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
python -m uvicorn agent_studio_backend.api:app --host 127.0.0.1 --port 37123 --reload
```

If you hit `ModuleNotFoundError: No module named 'agent_studio_backend'`, it usually means
`uvicorn` is running under a *different* Python (common with `pyenv`/`conda` shims). Sanity check:

```bash
which python
python --version
python -c "import agent_studio_backend; print('import_ok')"
```

Health check:

- `GET http://127.0.0.1:37123/v1/health`

## Configuration

Environment variables (all optional):

- `AGENT_STUDIO_DB_PATH`: SQLite file path (default: `./agent_studio.sqlite`)
- `AGENT_STUDIO_ALLOW_CORS_ORIGINS`: comma-separated origins for CORS (default: empty)
- `AGENT_STUDIO_LOG_LEVEL`: `info|debug|warning|error` (default: `info`)

## API (MVP)

- `POST /v1/agent-revisions` create a versioned agent spec
- `GET /v1/agent-revisions` list revisions
- `GET /v1/agent-revisions/{revision_id}` fetch revision
- `POST /v1/runs` start a run (executes in background)
- `GET /v1/runs/{run_id}` fetch run status/output
- `GET /v1/runs/{run_id}/events` list persisted events
- `GET /v1/runs/{run_id}/events/stream` SSE stream (“tail -f”)
- `POST /v1/runs/{run_id}/cancel` best-effort cancel

## Notes

- The default executor is a **mock** (so the backend works without model keys).
- If you install the optional extra (`pip install -e '.[agents]'`) we provide a small
  integration point for wiring OpenAI Agents SDK execution + tracing later.

