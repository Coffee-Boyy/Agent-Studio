from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Sequence


class SandboxMode(str, Enum):
    READ_ONLY = "read_only"
    WORKSPACE_WRITE = "workspace_write"
    NETWORK_ALLOWED = "network_allowed"
    FULL_ACCESS = "full_access"


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    sandboxed: bool


@dataclass(frozen=True)
class SandboxedProcess:
    process: subprocess.Popen[str]
    sandboxed: bool


class SandboxService:
    def __init__(self, *, workspace_root: Path) -> None:
        self._workspace_root = workspace_root.resolve()

    def run_command(
        self,
        cmd: Sequence[str],
        *,
        cwd: Path,
        mode: SandboxMode,
        timeout: float,
        env: dict[str, str] | None = None,
    ) -> CommandResult:
        command, sandboxed = self._prepare_command(cmd, mode=mode)
        try:
            completed = subprocess.run(
                command,
                cwd=str(cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            return CommandResult(
                stdout=completed.stdout,
                stderr=completed.stderr,
                exit_code=completed.returncode,
                timed_out=False,
                sandboxed=sandboxed,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout or ""
            stderr = exc.stderr or ""
            return CommandResult(
                stdout=stdout,
                stderr=stderr,
                exit_code=None,
                timed_out=True,
                sandboxed=sandboxed,
            )

    def spawn_process(
        self,
        cmd: Sequence[str],
        *,
        cwd: Path,
        mode: SandboxMode,
        env: dict[str, str] | None = None,
    ) -> SandboxedProcess:
        command, sandboxed = self._prepare_command(cmd, mode=mode)
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
        )
        return SandboxedProcess(process=process, sandboxed=sandboxed)

    def _prepare_command(self, cmd: Sequence[str], *, mode: SandboxMode) -> tuple[list[str], bool]:
        if mode == SandboxMode.FULL_ACCESS:
            return list(cmd), False

        if sys.platform == "darwin":
            return self._sandbox_macos(cmd, mode=mode)
        if sys.platform.startswith("linux"):
            return self._sandbox_linux(cmd, mode=mode)

        if _allow_no_sandbox():
            return list(cmd), False
        raise RuntimeError("sandbox_unavailable")

    def _sandbox_macos(self, cmd: Sequence[str], *, mode: SandboxMode) -> tuple[list[str], bool]:
        sandbox_exec = shutil.which("sandbox-exec")
        if not sandbox_exec:
            if _allow_no_sandbox():
                return list(cmd), False
            raise RuntimeError("sandbox_exec_missing")

        profile = _seatbelt_profile(self._workspace_root, mode=mode)
        return [sandbox_exec, "-p", profile, *cmd], True

    def _sandbox_linux(self, cmd: Sequence[str], *, mode: SandboxMode) -> tuple[list[str], bool]:
        helper = os.environ.get("AGENT_STUDIO_LINUX_SANDBOX_HELPER") or shutil.which("codex-linux-sandbox")
        if not helper:
            repo_helper = Path(__file__).resolve().parents[3] / "linux_sandbox" / "codex-linux-sandbox"
            if repo_helper.exists():
                helper = str(repo_helper)

        if helper:
            command = [
                helper,
                "--mode",
                mode.value,
                "--workspace",
                str(self._workspace_root),
                "--",
                *cmd,
            ]
            if helper.endswith(".py"):
                return [sys.executable, *command], True
            return command, True

        if _allow_no_sandbox():
            return list(cmd), False
        raise RuntimeError("linux_sandbox_helper_missing")


def _allow_no_sandbox() -> bool:
    return os.environ.get("AGENT_STUDIO_UNSAFE_ALLOW_NO_SANDBOX") == "1"


def _seatbelt_profile(workspace_root: Path, *, mode: SandboxMode) -> str:
    if mode == SandboxMode.READ_ONLY:
        return _seatbelt_profile_read_only()

    template_name = "network_allowed.sbpl" if mode == SandboxMode.NETWORK_ALLOWED else "workspace_write.sbpl"
    template = _read_profile_template(template_name)
    return template.format(workspace=str(workspace_root))


def _seatbelt_profile_read_only() -> str:
    return "\n".join(
        [
            "(version 1)",
            "(allow default)",
            "(deny network*)",
            "(deny file-write*)",
            '(allow file-write* (subpath "/tmp"))',
            '(allow file-write* (subpath "/private/tmp"))',
        ]
    )


def _read_profile_template(name: str) -> str:
    template_path = Path(__file__).resolve().parent.parent / "sandbox_profiles" / name
    if not template_path.exists():
        raise RuntimeError(f"sandbox_profile_missing:{name}")
    return template_path.read_text(encoding="utf-8")
