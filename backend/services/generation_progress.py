"""Observe YuE's existing reporter without modifying inference or parsing stderr.

Verified against YuE ef1936f2ee39, pipeline._status and progress._Stage.
The private reporter is capability-checked; unknown shapes remain stage-only.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from backend.generation_models import JobProgress

LOGGER = logging.getLogger(__name__)
ProgressCallback = Callable[[JobProgress], None]


class ProgressObserver:
    def __init__(self, native: Any, callback: ProgressCallback):
        self.native = native
        self.callback = callback

    @staticmethod
    def compatible(native: Any) -> bool:
        return (isinstance(getattr(native, "label", None), str)
                and type(getattr(native, "completed", None)) is int
                and (getattr(native, "total", None) is None or type(native.total) is int)
                and getattr(native, "unit", None) in (None, "tokens", "steps", "chunks")
                and all(callable(getattr(native, name, None)) for name in ("update", "advance", "finish")))

    def report(self, *, finished: bool = False) -> None:
        try:
            self.callback(JobProgress(label=self.native.label, completed=self.native.completed,
                                      total=self.native.total, unit=self.native.unit, finished=finished))
        except Exception:
            # Observability must never change a successful native result or stop a job.
            LOGGER.warning("Supplementary generation progress could not be reported", exc_info=True)

    def update(self, *args: Any, **kwargs: Any) -> Any:
        result = self.native.update(*args, **kwargs)
        self.report()
        return result

    def advance(self, *args: Any, **kwargs: Any) -> Any:
        result = self.native.advance(*args, **kwargs)
        # The public on_token callback already counts tokens without double-counting.
        if self.native.unit != "tokens":
            self.report()
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self.native, name)
