from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque


@dataclass
class LineBuffer:
    max_bytes: int
    _lines: Deque[str] = field(default_factory=deque)
    _bytes: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def append(self, line: str) -> None:
        encoded = line.encode("utf-8", errors="replace")
        with self._lock:
            self._lines.append(line)
            self._bytes += len(encoded)
            while self._bytes > self.max_bytes and self._lines:
                removed = self._lines.popleft()
                self._bytes -= len(removed.encode("utf-8", errors="replace"))

    def tail(self, lines: int) -> str:
        with self._lock:
            if lines <= 0:
                return ""
            items = list(self._lines)[-lines:]
        return "".join(items)


@dataclass
class ProcessHandle:
    process_id: str
    name: str
    command: str
    started_at: float
    process: any
    stdout: LineBuffer
    stderr: LineBuffer

    def is_running(self) -> bool:
        return self.process.poll() is None


class ProcessManager:
    def __init__(self, *, max_processes_per_run: int = 5, max_output_bytes: int = 100 * 1024) -> None:
        self._max_processes_per_run = max_processes_per_run
        self._max_output_bytes = max_output_bytes
        self._lock = threading.Lock()
        self._processes: dict[str, dict[str, ProcessHandle]] = {}

    def start_process(self, *, run_id: str, process_id: str, name: str, command: str, popen) -> ProcessHandle:
        with self._lock:
            run_processes = self._processes.setdefault(run_id, {})
            if process_id in run_processes:
                raise RuntimeError("process_id_exists")
            if len(run_processes) >= self._max_processes_per_run:
                raise RuntimeError("process_limit_reached")

            handle = ProcessHandle(
                process_id=process_id,
                name=name,
                command=command,
                started_at=time.time(),
                process=popen,
                stdout=LineBuffer(self._max_output_bytes),
                stderr=LineBuffer(self._max_output_bytes),
            )
            run_processes[process_id] = handle

        self._start_reader_threads(handle)
        return handle

    def stop_process(self, *, run_id: str, process_id: str, timeout: float = 5.0) -> tuple[bool, int | None]:
        handle = self._get_handle(run_id, process_id)
        if not handle:
            return False, None

        process = handle.process
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except Exception:  # noqa: BLE001
                process.kill()
        return True, process.returncode

    def get_output(self, *, run_id: str, process_id: str, lines: int = 50) -> dict[str, str | bool]:
        handle = self._get_handle(run_id, process_id)
        if not handle:
            raise RuntimeError("process_not_found")
        return {
            "stdout": handle.stdout.tail(lines),
            "stderr": handle.stderr.tail(lines),
            "running": handle.is_running(),
        }

    def cleanup_run(self, run_id: str) -> None:
        with self._lock:
            run_processes = self._processes.pop(run_id, {})
        for process_id in list(run_processes.keys()):
            self.stop_process(run_id=run_id, process_id=process_id)

    def _get_handle(self, run_id: str, process_id: str) -> ProcessHandle | None:
        with self._lock:
            return self._processes.get(run_id, {}).get(process_id)

    def _start_reader_threads(self, handle: ProcessHandle) -> None:
        def _reader(stream, buffer: LineBuffer) -> None:
            if stream is None:
                return
            try:
                for line in iter(stream.readline, ""):
                    buffer.append(line)
            finally:
                try:
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass

        if handle.process.stdout is not None:
            threading.Thread(
                target=_reader,
                args=(handle.process.stdout, handle.stdout),
                daemon=True,
            ).start()
        if handle.process.stderr is not None:
            threading.Thread(
                target=_reader,
                args=(handle.process.stderr, handle.stderr),
                daemon=True,
            ).start()
