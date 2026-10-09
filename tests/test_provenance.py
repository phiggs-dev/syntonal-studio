"""Provenance probes report explicit unknowns and never require torch/model imports."""
from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest

from backend.services import provenance
from backend.settings import Settings


def test_git_revision_dirty_status_and_read_only_arguments(tmp_path, monkeypatch):
    calls = []
    def run(arguments, **options):
        calls.append((arguments, options))
        return SimpleNamespace(stdout="a" * 40 + "\n" if arguments[-1] == "HEAD" else "?? untracked.txt\n")
    monkeypatch.setattr(provenance.subprocess, "run", run)
    identity = provenance.upstream_identity(tmp_path)
    assert identity == {"repository": str(tmp_path), "commit": "a" * 40, "dirty": True, "status": "verified"}
    assert calls[0][0] == ["git", "-C", str(tmp_path), "rev-parse", "HEAD"]
    assert calls[1][0] == ["git", "-C", str(tmp_path), "status", "--porcelain", "--untracked-files=normal"]
    assert all(options["env"]["GIT_OPTIONAL_LOCKS"] == "0" and options["timeout"] == 5 for _, options in calls)


@pytest.mark.parametrize("exception", [FileNotFoundError("no git"), subprocess.TimeoutExpired("git", 5), subprocess.CalledProcessError(1, "git", stderr="private credential")])
def test_unavailable_git_is_explicitly_unknown_without_persisting_stderr(tmp_path, monkeypatch, exception):
    def unavailable(*args, **kwargs):
        raise exception
    monkeypatch.setattr(provenance.subprocess, "run", unavailable)
    identity = provenance.upstream_identity(tmp_path)
    assert identity["status"] == "unknown"
    assert identity["commit"] is None
    assert identity["dirty"] is None
    assert "private credential" not in json.dumps(identity)


def test_failed_status_probe_retains_known_commit(tmp_path, monkeypatch):
    def partially_available(arguments, **options):
        if arguments[-1] == "HEAD":
            return SimpleNamespace(stdout="b" * 40)
        raise subprocess.TimeoutExpired("git status", 5)
    monkeypatch.setattr(provenance.subprocess, "run", partially_available)
    identity = provenance.upstream_identity(tmp_path)
    assert identity["commit"] == "b" * 40
    assert identity["dirty"] is None
    assert identity["status"] == "unknown"


def test_package_runtime_identity_without_model_imports(monkeypatch):
    monkeypatch.setattr(provenance.metadata, "version", lambda package: "test-version")
    snapshot = provenance.collect_provenance(Settings())
    assert snapshot["schema_version"] == 1
    assert snapshot["captured_at"]
    assert snapshot["upstream"]["status"] == "unknown"
    assert snapshot["runtime"]["python_version"]
    assert snapshot["runtime"]["dependencies"]["torch"] == "test-version"
