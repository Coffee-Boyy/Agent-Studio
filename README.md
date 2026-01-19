## Agent Studio

Agent Studio is a **local-first desktop app** for designing, running, and inspecting LLM agent workflows. It pairs an **Electron + React** UI with a **FastAPI + SQLite** runner service that stores runs and streams trace events live via **Server-Sent Events (SSE)**.

### What you can do

- **Design workflows visually**: build an agent graph with nodes + edges (powered by `@xyflow/react`).
- **Version workflows**: save your workflow spec as a versioned “agent revision” in the backend.
- **Run workflows locally**: start runs against a selected revision with structured inputs + tags.
- **Watch live traces**: “tail -f” run events in the UI via SSE, or load persisted events.
- **Stay local by default**: runs, revisions, and trace events are stored in a local SQLite DB.

### High-level architecture

- **Desktop app** (`desktop/`)
  - Electron main process launches the UI and (in dev + packaged builds) spawns the Python backend as a **sidecar**.
  - React UI provides:
    - workflow graph editor
    - run launcher
    - trace viewer (static + streaming)
    - settings (backend URL, LLM connection)
- **Backend service** (`backend/`)
  - FastAPI app exposing a small `/v1/*` API for:
    - agent revisions (create/list/get)
    - runs (create/get/list/cancel)
    - run events (list + SSE stream)
    - spec validation + compilation
  - SQLite persistence via `sqlmodel`.

### Repo layout

- `desktop/`: Electron + Vite + React UI
- `backend/`: FastAPI runner + local trace store
- `backend/src/agent_studio_backend/`: backend source (API, DB models, executor, sandboxing, etc.)
- `backend/linux_sandbox/`: optional Linux helper binary for OS-level sandboxing
- `PLAN.md`: product/architecture notes and roadmap thoughts

### Running locally (dev)

#### Backend (Python)

From `backend/`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
python -m uvicorn agent_studio_backend.api:app --host 127.0.0.1 --port 37123 --reload
```

Health check: `GET http://127.0.0.1:37123/v1/health`

#### Desktop (Electron + Vite)

From `desktop/`:

```bash
pnpm install
pnpm dev
```

The Electron main process will try to start the backend automatically in dev using `backend/.venv` (see `desktop/electron/main.mjs`).

### Packaging notes (how the sidecar works)

When packaged, Electron expects an **embedded Python** distribution at `desktop/python/` to be included as an extra resource:

- macOS/Linux: `python/bin/python3`
- Windows: `python/python.exe`

The embedded Python must include backend deps (`fastapi`, `uvicorn`, etc.) so it can run:

```bash
python -m agent_studio_backend.main
```

### Backend configuration

Environment variables (all optional):

- **`AGENT_STUDIO_DB_PATH`**: SQLite file path (default: `./agent_studio.sqlite`)
- **`AGENT_STUDIO_ALLOW_CORS_ORIGINS`**: comma-separated origins for CORS (default: empty)
- **`AGENT_STUDIO_LOG_LEVEL`**: `info|debug|warning|error` (default: `info`)
- **`AGENT_STUDIO_HOST`**: bind host (default: `127.0.0.1`)
- **`AGENT_STUDIO_PORT`**: bind port (default: `37123`)

### Desktop configuration

- **Backend URL**: configurable in the app Settings. Default is `http://127.0.0.1:37123`.
- **LLM connection**: run requests can include an `llm_connection` payload (provider + optional API key/base URL/etc.).

### Implementation details (useful mental model)

#### Workflow specs: graph-first

The UI edits a declarative graph document (`schema_version: "graph-v1"`) containing:

- **nodes**: `input`, `agent`, `tool`, `loop_group`, `output`
- **edges**: directed connections between nodes
- **viewport/metadata**: editor state

The backend exposes:

- `POST /v1/spec/validate`: validates graph shape and returns issues
- `POST /v1/spec/compile`: compiles the graph doc into a runnable “spec” representation

#### Runs + events: persisted + streamable

Creating a run (`POST /v1/runs`) does two things:

- persists the run record in SQLite
- starts execution in a background task

During execution, the backend:

- persists **run events** with a per-run, monotonic `seq`
- publishes events to an in-process bus
- streams them to clients via `GET /v1/runs/{run_id}/events/stream` (SSE)

The UI’s trace viewer uses `EventSource` to subscribe to SSE and renders events as they arrive, while also supporting a “static” mode that loads persisted events.

#### Executors + sandboxing

The backend is structured so the executor can be swapped:

- The default executor is currently **mock-friendly** so the system works without requiring model keys.
- Optional extras in `backend/pyproject.toml` include:
  - `agents`: integration point for wiring `openai-agents` execution/tracing later
  - `sandbox`: sandbox-related dependencies (e.g. Playwright; Linux-specific seccomp)

On Linux, `backend/linux_sandbox/` includes a helper that applies **Landlock** filesystem rules and a lightweight **seccomp** filter. This is intended to support safer “workspace tools” execution in local runs.

### API quick reference (MVP)

- `GET /v1/health`
- `POST /v1/spec/validate`
- `POST /v1/spec/compile`
- `POST /v1/agent-revisions`
- `GET /v1/agent-revisions`
- `GET /v1/agent-revisions/{revision_id}`
- `POST /v1/runs`
- `GET /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `GET /v1/runs/{run_id}/events/stream` (SSE)
- `POST /v1/runs/{run_id}/cancel`

