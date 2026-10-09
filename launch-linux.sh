#!/usr/bin/env bash
# Production serves the compiled frontend and API on one local origin.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_root"
source "$project_root/scripts/runtime-env.sh"
[[ -x .venv/bin/python ]] || { echo "Run bash scripts/setup.sh under Linux/WSL2 first." >&2; exit 1; }
[[ -f frontend/dist/index.html ]] || { echo "Run npm --prefix frontend run build, or bash scripts/setup.sh." >&2; exit 1; }
echo "Syntonal Studio: http://127.0.0.1:8675"
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8675 --timeout-graceful-shutdown 5
