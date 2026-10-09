"""Capture worker stderr only; redact common credentials before job logs are persisted."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stderr
import io
import os
import re
import sys
import threading
import time
from typing import Callable, Iterator, TextIO


def redact_secrets(text: str) -> str:
    for name, value in os.environ.items():
        if len(value) >= 8 and any(part in name.upper() for part in ("TOKEN", "API_KEY", "SECRET", "PASSWORD")):
            text = text.replace(value, "[REDACTED]")
    text = re.sub(r"\bhf_[A-Za-z0-9]{8,}\b", "[REDACTED]", text)
    text = re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._~-]+", r"\1[REDACTED]", text)
    return text


class WorkerLogStream(io.TextIOBase):
    def __init__(self, original: TextIO, emit: Callable[[str], None]):
        self.original = original
        self.emit = emit
        self.owner = threading.get_ident()
        self.pending = ""
        self.last_progress = 0.0

    def write(self, text: str) -> int:
        if threading.get_ident() != self.owner:
            return self.original.write(text)
        self.original.write(redact_secrets(text))
        # Terminal progress uses carriage returns; keep at most one snapshot per second.
        for part in text.splitlines(keepends=True):
            self.pending += part.rstrip("\r\n")
            if part.endswith(("\r", "\n")):
                if part.endswith("\n") or time.monotonic() - self.last_progress >= 1:
                    self._emit()
                    self.last_progress = time.monotonic()
                self.pending = ""
        if len(self.pending) > 8192:
            self._emit()
        return len(text)

    def _emit(self) -> None:
        if self.pending:
            message = redact_secrets(self.pending)
            self.pending = ""
            try:
                self.emit(message)
            except OSError:
                # stderr is supplementary: a failed log sink must not terminate the queue,
                # especially when this flush runs after the job's exception boundary.
                pass

    def flush(self) -> None:
        self.original.flush()

    def finish(self) -> None:
        self._emit()


@contextmanager
def capture_worker_stderr(emit: Callable[[str], None]) -> Iterator[None]:
    stream = WorkerLogStream(sys.stderr, emit)
    with redirect_stderr(stream):
        try:
            yield
        finally:
            stream.finish()

