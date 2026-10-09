"""Local readiness probes; cached directories do not establish model integrity."""
from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend.settings import Settings

TORCH_PROBE = """import json, torch
devices=[]
for index in range(torch.cuda.device_count()):
    with torch.cuda.device(index):
        free,total=torch.cuda.mem_get_info()
        devices.append({'name':torch.cuda.get_device_name(index),'total_gib':total/2**30,'free_gib':free/2**30,'bf16':torch.cuda.is_bf16_supported()})
print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'available':torch.cuda.is_available(),'devices':devices,'selected_device':torch.cuda.current_device() if torch.cuda.is_available() else None}))
"""


def run_probe(arguments: list[str], timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, check=False, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


def collect_diagnostics(settings: Settings) -> dict:
    checks: list[dict[str, str]] = []

    def add(identifier: str, label: str, status: str, detail: str) -> None:
        checks.append(dict(id=identifier, label=label, status=status, detail=detail))

    add("python", "Python / operating system", "pass" if sys.version_info[:2] == (3, 12) and platform.system() == "Linux" else "warning", f"Python {platform.python_version()} on {platform.system()}; upstream recommends Linux/WSL2 and Python 3.12")
    try:
        import psutil
        memory = psutil.virtual_memory()
        add("ram", "System RAM", "pass", f"{memory.total / 2**30:.1f} GiB total, {memory.available / 2**30:.1f} GiB available")
    except Exception as exception:
        add("ram", "System RAM", "warning", f"Unavailable: {type(exception).__name__}")
    for package in ("yue2-infer", "torch", "transformers", "huggingface-hub", "safetensors", "tiktoken", "soundfile", "accelerate", "numpy"):
        try:
            add(f"package-{package}", package, "pass", f"Installed {importlib.metadata.version(package)}; compatibility not verified")
        except importlib.metadata.PackageNotFoundError:
            add(f"package-{package}", package, "warning", "Not installed in the backend interpreter; inference requires upstream dependencies")
    if settings.upstream_repository:
        repository = settings.upstream_repository
        if not (repository / "src/yue2/__init__.py").is_file():
            add("source", "YuE2 source", "fail", f"Missing src/yue2 package in {repository}")
        else:
            try:
                result = run_probe(["git", "-C", str(repository), "rev-parse", "HEAD"])
                add("source", "YuE2 source", "pass" if result.returncode == 0 else "warning", result.stdout.strip() if result.returncode == 0 else "Source exists but Git commit could not be read")
            except (OSError, subprocess.TimeoutExpired) as exception:
                add("source", "YuE2 source", "warning", f"Source exists; Git probe unavailable: {type(exception).__name__}")
    else:
        add("source", "YuE2 source", "warning", "No checkout configured; adapter will use the installed yue2 package")
    try:
        source = str((settings.upstream_repository.expanduser() / "src").resolve()) if settings.upstream_repository else None
        code = "import sys; sys.dont_write_bytecode=True; "
        if source is not None:
            code += f"sys.path.insert(0, {source!r}); "
        code += "import yue2; print(yue2.__file__)"
        result = run_probe([sys.executable, "-c", code], timeout=15)
        correct_source = source is None or (result.returncode == 0 and Path(result.stdout.strip()).resolve().is_relative_to(Path(source)))
        add("import", "YuE2 package import", "pass" if result.returncode == 0 and correct_source else "warning", (result.stdout.strip() + "; package import only, inference dependencies not loaded") if result.returncode == 0 and correct_source else "Package import failed or resolved outside configured source; install/configure upstream")
    except (OSError, subprocess.TimeoutExpired, ValueError) as exception:
        add("import", "YuE2 package import", "warning", f"Unavailable: {type(exception).__name__}")
    try:
        result = run_probe([sys.executable, "-c", TORCH_PROBE], timeout=30)
        if result.returncode != 0:
            add("gpu", "CUDA / GPU", "warning", "Torch GPU probe failed; verify upstream dependencies in the backend environment")
        else:
            report = json.loads(result.stdout.strip())
            selected = report["devices"][report["selected_device"]] if report["available"] else None
            adequate = selected is not None and selected["bf16"] and selected["total_gib"] >= 23
            add("gpu", "CUDA / GPU", "pass" if adequate else "warning", json.dumps(report) + "; recommended: BF16 NVIDIA GPU with 24 GB VRAM")
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError) as exception:
        add("gpu", "CUDA / GPU", "warning", f"Probe unavailable: {type(exception).__name__}; no inference attempted")
    cache = settings.huggingface_cache or Path(os.environ.get("HF_HUB_CACHE", str(Path(os.environ.get("HF_HOME", str(Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "huggingface"))) / "hub")))
    for identifier, model, revision in (("model", settings.model, settings.model_revision), ("vae", settings.vae, settings.vae_revision)):
        try:
            location = Path(model).expanduser()
            present = location.is_dir()
            if not present:
                root = cache / ("models--" + model.replace("/", "--"))
                revision_name = revision or "main"
                reference = root / "refs" / revision_name
                if reference.resolve().is_relative_to(root.resolve()) and reference.is_file():
                    revision_name = reference.read_text(encoding="utf-8").strip()
                location = root / "snapshots" / revision_name
                present = location.resolve().is_relative_to(root.resolve()) and location.is_dir()
            add(identifier, f"{identifier.upper()} files", "pass" if present else "warning", f"{'Directory present' if present else 'Not found locally'}: {location}. Presence only; completeness and integrity are not verified. No network lookup performed.")
        except (OSError, ValueError) as exception:
            add(identifier, f"{identifier.upper()} files", "warning", f"Cannot inspect local files: {type(exception).__name__}")
    for identifier, directory in (("outputs", settings.outputs_directory), ("projects", settings.projects_directory)):
        try:
            existing = directory.expanduser().resolve()
            if settings.upstream_repository is not None and existing.is_relative_to(settings.upstream_repository.expanduser().resolve()):
                raise PermissionError("Output cannot target read-only upstream")
            while not existing.exists() and existing != existing.parent:
                existing = existing.parent
            if not existing.is_dir():
                raise NotADirectoryError(str(existing))
            if settings.upstream_repository is not None and existing.is_relative_to(settings.upstream_repository.expanduser().resolve()):
                raise PermissionError("Cannot probe read-only upstream")
            with tempfile.TemporaryFile(dir=existing) as probe:
                probe.write(b"studio permission probe")
                probe.flush()
            add(identifier, f"{identifier.title()} location", "pass", f"Writable {'directory' if directory.is_dir() else 'existing ancestor'}: {existing}")
        except OSError as exception:
            add(identifier, f"{identifier.title()} location", "fail", f"Cannot write: {exception}")
    executable = shutil.which(settings.ffmpeg)
    add("ffmpeg", "FFmpeg", "pass" if executable else "warning", executable or "Not found; optional conversion and transcription require FFmpeg")
    if settings.sheetsage_python is None:
        add("sheetsage", "SheetSage2 interpreter", "warning", "Not configured; transcription is a later phase and needs a separate environment")
    else:
        try:
            result = run_probe([str(settings.sheetsage_python), "--version"])
            add("sheetsage", "SheetSage2 interpreter", "pass" if result.returncode == 0 else "warning", (result.stdout or result.stderr).strip() + "; interpreter only, SheetSage2 dependencies not verified")
        except (OSError, subprocess.TimeoutExpired) as exception:
            add("sheetsage", "SheetSage2 interpreter", "warning", f"Unavailable: {type(exception).__name__}")
    return {"collected_at": datetime.now(timezone.utc).isoformat(), "checks": checks}
