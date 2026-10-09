"""ABC is a bounded two-voice notation dialect; upstream helpers own musical semantics.

Fractions remain exact strings in JSON. Validation never loads a model, changes
score text, or claims that generated audio follows the notation exactly.
"""
from __future__ import annotations

import difflib
from functools import lru_cache
import json
from pathlib import Path
import runpy
import threading
from typing import Any

MAX_ABC_CHARACTERS = 100_000
SCOPE = "Upstream native-dialect structural check; not general ABC validity or audio verification."
_HELPER_LOCK = threading.Lock()


@lru_cache(maxsize=4)
def _load_helper(path: str, modified_ns: int, size: int) -> dict[str, Any]:
    # run_path temporarily registers a module; serialize initialization across HTTP workers.
    with _HELPER_LOCK:
        try:
            helper = runpy.run_path(path, run_name="_studio_abc_helper")
        except (OSError, SyntaxError, ImportError) as exception:
            raise ValueError("Cannot load the configured upstream ABC helper; check the YuE checkout.") from exception
    required = ("parse_abc", "report", "compare", "strip_chords", "json_value", "AbcError")
    if any(not callable(helper.get(name)) for name in required):
        raise ValueError("Configured upstream ABC helper does not expose the expected public functions.")
    return helper


class ABCService:
    def __init__(self, repository: Path | None):
        self.repository = repository

    def _helper(self) -> dict[str, Any]:
        if self.repository is None:
            raise ValueError("Configure the upstream YuE repository in Settings to validate ABC.")
        path = self.repository / "skills/yue2-music/scripts/abc_tools.py"
        try:
            details = path.stat()
            if not path.is_file() or details.st_size > 1_000_000:
                raise ValueError("Configured ABC helper is unavailable or unexpectedly large.")
        except OSError as exception:
            raise ValueError("The configured YuE checkout has no readable bundled ABC helper.") from exception
        return _load_helper(str(path.resolve()), details.st_mtime_ns, details.st_size)

    @staticmethod
    def _check_text(text: str) -> None:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("ABC must contain score text.")
        if len(text) > MAX_ABC_CHARACTERS:
            raise ValueError(f"ABC exceeds Studio's {MAX_ABC_CHARACTERS:,}-character limit.")

    def validate(self, abc: str) -> dict[str, Any]:
        helper = self._helper()
        try:
            self._check_text(abc)
            report = helper["report"](helper["parse_abc"](abc))
            serializable = json.loads(json.dumps(report, default=helper["json_value"], allow_nan=False))
            return {"valid": True, "report": serializable, "errors": [], "scope": SCOPE}
        except ValueError as exception:
            return {"valid": False, "report": None, "errors": [str(exception)], "scope": SCOPE}

    def compare(self, before: str, after: str, voices: str = "both", allow_tempo_change: bool = False) -> dict[str, Any]:
        helper = self._helper()
        self._check_text(before)
        self._check_text(after)
        if voices not in {"both", "Vocal", "Ins"}:
            raise ValueError("Select both voices, Vocal, or Ins.")
        if not isinstance(allow_tempo_change, bool):
            raise ValueError("allow_tempo_change must be a boolean.")
        text_diff = "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile="original.abc", tofile="draft.abc"))
        try:
            names = ("Vocal", "Ins") if voices == "both" else (voices,)
            result = helper["compare"](helper["parse_abc"](before), helper["parse_abc"](after), names=names, allow_tempo_change=allow_tempo_change)
            return {"valid": True, "match": result["match"], "differences": result["differences"], "errors": [], "scope": result["scope"], "diff": text_diff}
        except ValueError as exception:
            return {"valid": False, "match": None, "differences": [], "errors": [str(exception)], "scope": SCOPE, "diff": text_diff}

    def strip_chords(self, abc: str, keep_voice: str = "both") -> dict[str, Any]:
        self._check_text(abc)
        if keep_voice not in {"both", "Vocal", "Ins"}:
            raise ValueError("Select both voices, Vocal, or Ins.")
        helper = self._helper()
        result = helper["strip_chords"](abc, keep_voice=keep_voice)
        return {"abc": result, "validation": self.validate(result)}
