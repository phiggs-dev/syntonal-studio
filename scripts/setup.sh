#!/usr/bin/env bash
# Studio owns this environment; upstream and model weights stay untouched.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
source "$project_root/scripts/runtime-env.sh"
python_command="${PYTHON:-python3.12}"
command -v "$python_command" >/dev/null || { echo "Install Python 3.12 or set PYTHON to its executable." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install Node.js with npm first." >&2; exit 1; }
"$python_command" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 required"'
if [[ ! -d .venv ]]; then
    "$python_command" -m venv .venv
fi
[[ -x .venv/bin/python ]] || { echo "Expected Linux/WSL2 .venv/bin/python." >&2; exit 1; }
.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 12), "Existing Studio environment must use Python 3.12"'
if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
    .venv/bin/python -m ensurepip --upgrade || { echo "Install Python 3.12 venv/ensurepip support, then rerun setup." >&2; exit 1; }
fi
.venv/bin/python -m pip install -e '.[test]'
if [[ -f frontend/package-lock.json ]]; then
    npm --prefix frontend ci
else
    npm --prefix frontend install
fi
npm --prefix frontend run build
echo "Foundation ready. Run bash launch-linux.sh or bash scripts/dev.sh. No inference packages or models were installed."
