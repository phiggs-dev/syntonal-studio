"""Application provenance snapshots use read-only probes and never import model runtimes."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from importlib import metadata
import os
from pathlib import Path
import platform
import subprocess
import tomllib
from typing import Any

from backend.settings import Settings

DEPENDENCIES = ("yue2-infer", "torch", "transformers", "numpy", "soundfile", "huggingface-hub", "safetensors", "tiktoken", "accelerate", "fastapi", "pydantic", "nvidia-cuda-runtime-cu12", "nvidia-cudnn-cu12", "triton")


def upstream_identity(repository: Path | None) -> dict[str, Any]:
    identity: dict[str, Any] = {
        "repository": str(repository.resolve()) if repository is not None else None,
        "commit": None,
        "dirty": None,
        "status": "unknown",
    }
    if repository is None:
        identity["detail"] = "No upstream checkout configured; package version is recorded under dependencies."
        return identity
    # Optional locks must stay disabled: git status must not refresh the read-only index.
    environment = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    try:
        commit = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True, env=environment,
        ).stdout.strip()
        identity["commit"] = commit
        changes = subprocess.run(
            ["git", "-C", str(repository), "status", "--porcelain", "--untracked-files=normal"],
            capture_output=True, text=True, timeout=5, check=True, env=environment,
        ).stdout
        identity["dirty"] = bool(changes.strip())
        identity["status"] = "verified"
    except (OSError, subprocess.SubprocessError) as exception:
        # Do not persist git stderr/environment: it can contain credential-bearing URLs.
        identity["detail"] = f"Read-only Git probe unavailable ({type(exception).__name__}); revision or dirty status could not be fully verified."
    return identity


def gpu_identity() -> dict[str, Any]:
    """Record driver-reported memory in MiB without initializing CUDA."""
    result: dict[str, Any] = {"status": "unknown", "devices": []}
    try:
        response = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        if len(response.stdout) > 65536:
            raise ValueError("Unexpected GPU probe size")
        devices = []
        for row in csv.reader(response.stdout.splitlines()):
            if len(row) != 3 or not row[0].strip() or not row[2].strip():
                raise ValueError("Malformed GPU probe")
            memory = int(row[1].strip())
            if memory <= 0:
                raise ValueError("Invalid GPU memory")
            devices.append({"name": row[0].strip(), "memory_total_mib": memory, "driver_version": row[2].strip()})
        if not devices:
            raise ValueError("No GPU reported")
        result.update(status="verified", devices=devices)
    except (OSError, subprocess.SubprocessError, ValueError, csv.Error) as exception:
        result["detail"] = f"Read-only GPU probe unavailable ({type(exception).__name__}); GPU identity is unknown."
    return result


def source_package_identity(repository: Path | None) -> dict[str, Any]:
    """Read the configured checkout version instead of assuming an installed wheel."""
    result: dict[str, Any] = {"status": "unknown", "name": None, "version": None}
    if repository is None:
        result["detail"] = "No upstream checkout configured."
        return result
    try:
        with (repository / "pyproject.toml").open("rb") as stream:
            payload = stream.read(262145)
        if len(payload) > 262144:
            raise ValueError("Package metadata too large")
        project = tomllib.loads(payload.decode("utf-8"))["project"]
        name, version = project["name"], project["version"]
        if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
            raise ValueError("Invalid package metadata")
        result.update(status="verified", name=name, version=version)
    except (OSError, ValueError, KeyError, TypeError) as exception:
        result["detail"] = f"Source package metadata unavailable ({type(exception).__name__}); package version is unknown."
    return result


def collect_provenance(settings: Settings) -> dict[str, Any]:
    dependencies: dict[str, str | None] = {}
    for package in DEPENDENCIES:
        try:
            dependencies[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            dependencies[package] = None
    return {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "upstream": upstream_identity(settings.upstream_repository),
        "source_package": source_package_identity(settings.upstream_repository),
        "gpu": gpu_identity(),
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "dependencies": dependencies,
        },
        "note": "Captured before inference. Requested model and VAE revisions are in settings.json; native resolved weight identities and configuration remain in artifacts/.",
    }
