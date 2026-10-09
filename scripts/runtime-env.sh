#!/usr/bin/env bash
# Project-local tools take precedence without changing the user's shell profile.
syntonal_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$syntonal_root/.runtime/tools/node/bin:$syntonal_root/.runtime/tools/uv:$syntonal_root/.runtime/tools/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$syntonal_root/.runtime/tools/python"
export UV_PYTHON_BIN_DIR="$syntonal_root/.runtime/tools/bin"
