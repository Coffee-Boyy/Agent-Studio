# Embedded Python (bundled)

Place an embedded Python distribution in this folder so Electron can launch the backend.

Expected layout:

- macOS/Linux: `python/bin/python3`
- Windows: `python/python.exe`

The embedded Python must include the backend dependencies (`fastapi`, `uvicorn`, etc.)
or a compatible `site-packages` so `python -m agent_studio_backend.main` can run.
