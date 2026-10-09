"""Test delegation to the configured upstream helper without inference dependencies."""
from fractions import Fraction
from pathlib import Path

import pytest

from backend.services.abc_service import ABCService, MAX_ABC_CHARACTERS


@pytest.fixture
def helper_service(monkeypatch):
    calls = []

    def parse(text):
        if text == "invalid":
            raise ValueError("Unsupported notation")
        return text

    def compare(before, after, **options):
        calls.append((before, after, options))
        return {"match": before == after, "differences": [] if before == after else ["notes differ"], "scope": "symbolic only"}

    helper = {
        "parse_abc": parse,
        "report": lambda score: {"score": score, "duration": Fraction(3, 2)},
        "json_value": lambda value: str(value),
        "compare": compare,
        "strip_chords": lambda text, keep_voice: text.replace('"C"', ""),
    }
    service = ABCService(Path("unused"))
    monkeypatch.setattr(service, "_helper", lambda: helper)
    return service, calls


def test_validation_preserves_text_and_serializes_exact_fractions(helper_service):
    service, _ = helper_service
    source = 'V:Vocal\n"C"C2 |\n'
    result = service.validate(source)
    assert result["valid"] is True
    assert result["report"] == {"score": source, "duration": "3/2"}
    assert service.validate("invalid")["errors"] == ["Unsupported notation"]
    assert service.validate(" ")["valid"] is False
    assert service.validate("C" * (MAX_ABC_CHARACTERS + 1))["valid"] is False


def test_comparison_delegates_voice_and_tempo_invariants(helper_service):
    service, calls = helper_service
    result = service.compare("before\n", "after\n", "Vocal", True)
    assert result["valid"] is True and result["match"] is False
    assert calls == [("before\n", "after\n", {"names": ("Vocal",), "allow_tempo_change": True})]
    assert "-before" in result["diff"] and "+after" in result["diff"]
    assert service.compare("invalid", "after")["match"] is None
    with pytest.raises(ValueError, match="voices"):
        service.compare("before", "after", "unknown")


def test_strip_returns_new_text_and_validation(helper_service):
    service, _ = helper_service
    original = '"C"C2 |\n'
    result = service.strip_chords(original)
    assert original == '"C"C2 |\n'
    assert result["abc"] == "C2 |\n"
    assert result["validation"]["valid"] is True


def test_unconfigured_or_missing_helper_is_actionable(tmp_path):
    with pytest.raises(ValueError, match="Configure"):
        ABCService(None).validate("score")
    with pytest.raises(ValueError, match="readable bundled ABC helper"):
        ABCService(tmp_path).validate("score")


def test_helper_interface_checked_without_importing_models(tmp_path):
    script = tmp_path / "skills/yue2-music/scripts/abc_tools.py"
    script.parent.mkdir(parents=True)
    script.write_text("def parse_abc(text): return text\n")
    with pytest.raises(ValueError, match="expected public functions"):
        ABCService(tmp_path).validate("score")
