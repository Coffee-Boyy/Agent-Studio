# Linux Sandbox Helper

This helper enforces OS-level sandboxing on Linux using Landlock and a lightweight
seccomp filter. It mirrors the Codex approach by applying Landlock filesystem
rules and then restricting dangerous syscalls.

## Build

```bash
make
```

This produces `codex-linux-sandbox` in the same directory.

## Usage

```bash
./codex-linux-sandbox --mode workspace_write --workspace /path/to/workspace -- <command> [args...]
```

Modes:
- `read_only`: No writes except `/tmp`.
- `workspace_write`: Writes allowed inside workspace and `/tmp`.
- `network_allowed`: Same as `workspace_write`, but no network restrictions (Landlock handles filesystem only).

## Environment

- `AGENT_STUDIO_UNSAFE_ALLOW_NO_SANDBOX=1` allows bypass if Landlock is unavailable.
- `AGENT_STUDIO_LINUX_SANDBOX_HELPER` can point to a custom helper path.
