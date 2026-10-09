#!/usr/bin/env bash
# Install upstream inference pins into Studio's Python environment only.
# YuE2 remains imported from its configured source checkout; no weights download here.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
export PYTHONDONTWRITEBYTECODE=1
[[ $# -le 1 ]] || { echo "Usage: bash scripts/setup-inference.sh [upstream-repository]" >&2; exit 1; }
[[ -x .venv/bin/python ]] || { echo "Run bash scripts/setup.sh first." >&2; exit 1; }
# Resolve configuration and install in one Python process so invalid paths fail before mutation.
.venv/bin/python - "${1:-}" <<'PYTHON'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

if sys.version_info[:2] != (3, 12):
    raise SystemExit("Studio inference requires Python 3.12.")
project_root = Path.cwd().resolve()
if Path(sys.prefix).resolve() != project_root / ".venv":
    raise SystemExit("Refusing to install outside the Studio .venv.")
configured_source = sys.argv[1]
if not configured_source:
    settings_path = Path(os.environ.get("SYNTONAL_STUDIO_SETTINGS", os.environ.get("YUE2_STUDIO_SETTINGS", "data/settings.json"))).expanduser()
    if settings_path.is_file():
        configured_source = json.loads(settings_path.read_text(encoding="utf-8")).get("upstream_repository")
if not configured_source:
    raise SystemExit("Configure the upstream repository in Settings or supply its Linux/WSL path as an argument.")
upstream_repository = Path(configured_source).expanduser().resolve()
if not (upstream_repository / "src/yue2/pipeline.py").is_file():
    raise SystemExit(f"YuE2 source was not found in {upstream_repository}.")
metadata = tomllib.loads((upstream_repository / "pyproject.toml").read_text(encoding="utf-8"))
if metadata["project"]["name"] != "yue2-infer":
    raise SystemExit("Expected the current upstream yue2-infer project.")
dependencies = metadata["project"]["dependencies"]
if not dependencies or not all(isinstance(item, str) for item in dependencies):
    raise SystemExit("The upstream dependency list is invalid.")
print("Installing upstream dependency requirements:", *dependencies, sep="\n  ", flush=True)
uv_command = shutil.which("uv")
if uv_command:
    command = [uv_command, "pip", "install", "--python", sys.executable, "--link-mode", "copy", *dependencies]
else:
    command = [sys.executable, "-m", "pip", "install", *dependencies]
subprocess.run(command, check=True)
subprocess.run([sys.executable, "-m", "pip", "check"], check=True)
print("Inference dependencies installed. Upstream checkout and environment were not modified.")
print("This does not download models or certify GPU generation readiness.")
PYTHON
