#!/usr/bin/env bash
# Loopback development servers share one cleanup trap.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
source "$project_root/scripts/runtime-env.sh"
[[ -x .venv/bin/python && -d frontend/node_modules ]] || { echo "Run bash scripts/setup.sh under Linux/WSL2 first." >&2; exit 1; }
backend_pid=""
frontend_pid=""
cleanup() {
    trap - EXIT INT TERM
    [[ -z "$backend_pid" ]] || kill "$backend_pid" 2>/dev/null || true
    [[ -z "$frontend_pid" ]] || kill "$frontend_pid" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8675 --timeout-graceful-shutdown 5 &
backend_pid=$!
# Direct invocation ensures the tracked process owns the Vite server.
node frontend/node_modules/vite/bin/vite.js frontend --host 127.0.0.1 --port 5173 --strictPort &
frontend_pid=$!
echo "Studio development: http://127.0.0.1:5173 (API http://127.0.0.1:8675)"
wait -n "$backend_pid" "$frontend_pid"
