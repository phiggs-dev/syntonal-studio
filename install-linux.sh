#!/usr/bin/env bash
# Bootstrap missing prerequisites locally, then delegate application setup and choices.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_root"
source scripts/runtime-env.sh
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    echo "Usage: bash install-linux.sh [--install-system-packages] [installer options]"
    echo "Options: --application-only, --upstream PATH, --model-directory PATH,"
    echo "         --vae-directory PATH, --cache-directory PATH, --download-models,"
    echo "         --no-download-models, --login, --yes"
    echo "--yes accepts application confirmations; system packages need separate consent."
    exit 0
fi
[[ "$(uname -s)" == Linux ]] || { echo "Use Linux or Windows with WSL2." >&2; exit 1; }
install_system_packages=false
noninteractive=false
arguments=()
for argument in "$@"; do
    case "$argument" in
        --install-system-packages) install_system_packages=true ;;
        --yes) noninteractive=true; arguments+=("$argument") ;;
        *) arguments+=("$argument") ;;
    esac
done
# A running app must not have its dependencies replaced underneath it.
if [[ -x .venv/bin/python ]]; then
    .venv/bin/python -c 'import socket; connection=socket.socket(); assert connection.connect_ex(("127.0.0.1",8675)) != 0, "Stop Syntonal Studio before installing"; connection.close()'
fi
missing=()
for command in curl git tar xz sha256sum; do
    command -v "$command" >/dev/null || missing+=("$command")
done
if (( ${#missing[@]} )); then
    echo "Missing system tools: ${missing[*]}"
    command -v apt-get >/dev/null || { echo "Install those tools with your distribution's package manager, then rerun." >&2; exit 1; }
    if ! $install_system_packages; then
        $noninteractive && { echo "System packages require --install-system-packages." >&2; exit 1; }
        read -r -p "Install missing prerequisites using apt (without upgrading installed packages)? [y/N] " answer
        [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]] || exit 1
    fi
    privilege=()
    if (( EUID != 0 )); then
        command -v sudo >/dev/null || { echo "Install missing system tools as administrator." >&2; exit 1; }
        privilege=(sudo)
    fi
    "${privilege[@]}" apt-get update
    "${privilege[@]}" apt-get install -y --no-upgrade ca-certificates curl git tar xz-utils coreutils
fi
python_usable() {
    "$1" -c 'import sys, venv, ensurepip; assert sys.version_info[:2] == (3, 12)' >/dev/null 2>&1
}
python_command="${PYTHON:-python3.12}"
if [[ -x .venv/bin/python ]] && python_usable .venv/bin/python; then
    python_command="$project_root/.venv/bin/python"
elif ! python_usable "$python_command"; then
    echo "Installing isolated Python 3.12 under .runtime/tools."
    if ! command -v uv >/dev/null; then
        mkdir -p .runtime/tools/uv
        installer="$(mktemp)"
        trap 'rm -f -- "$installer"' EXIT
        curl --fail --location --proto '=https' --tlsv1.2 https://astral.sh/uv/install.sh -o "$installer"
        UV_UNMANAGED_INSTALL="$project_root/.runtime/tools/uv" sh "$installer"
        rm -f -- "$installer"
        trap - EXIT
    fi
    uv python install 3.12
    python_command="$(uv python find --managed-python 3.12)"
fi
export PYTHON="$python_command"
node_usable() {
    command -v node >/dev/null && command -v npm >/dev/null || return 1
    [[ "$(node -p 'process.platform')" == linux ]] || return 1
    local version
    version="$(node --version)" || return 1
    [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\. ]] || return 1
    (( BASH_REMATCH[1] > 22 || (BASH_REMATCH[1] == 22 && BASH_REMATCH[2] >= 12) ))
}
if ! node_usable; then
    case "$(uname -m)" in
        x86_64) architecture=x64 ;;
        aarch64|arm64) architecture=arm64 ;;
        *) echo "Install Node.js 22.12+ manually for this architecture." >&2; exit 1 ;;
    esac
    [[ ! -e .runtime/tools/node ]] || { echo "Existing local Node.js is unusable; preserve it and repair it before rerunning." >&2; exit 1; }
    mkdir -p .runtime/tools
    staging="$(mktemp -d "$project_root/.runtime/tools/node-download.XXXXXX")"
    trap 'rm -rf -- "$staging"' EXIT
    download_base=https://nodejs.org/dist/latest-v22.x
    curl --fail --location --proto '=https' --tlsv1.2 "$download_base/SHASUMS256.txt" -o "$staging/SHASUMS256.txt"
    archive="$(awk -v suffix="-linux-$architecture.tar.xz" 'index($2,suffix) == length($2)-length(suffix)+1 {print $2}' "$staging/SHASUMS256.txt")"
    [[ "$archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo "Unexpected Node.js release listing." >&2; exit 1; }
    curl --fail --location --proto '=https' --tlsv1.2 "$download_base/$archive" -o "$staging/$archive"
    (cd "$staging"; grep -F " $archive" SHASUMS256.txt | sha256sum --check -)
    mkdir "$staging/unpacked"
    tar -xJf "$staging/$archive" -C "$staging/unpacked" --strip-components=1
    mv -- "$staging/unpacked" "$project_root/.runtime/tools/node"
    rm -rf -- "$staging"
    trap - EXIT
    node_usable || { echo "Downloaded Node.js cannot run; this system may require a newer glibc." >&2; exit 1; }
fi
bash scripts/setup.sh
exec .venv/bin/python scripts/install.py "${arguments[@]}"
