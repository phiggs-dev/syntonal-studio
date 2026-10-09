# Installing Syntonal Studio

## Windows

Double-click `install-win.bat`. It reuses Ubuntu when available, or selects an existing non-Docker WSL distribution. To choose explicitly, run:

```powershell
.\install-win.bat -Distribution Ubuntu
```

The distribution must run under WSL2 with a non-root Linux user. When WSL/Ubuntu is missing, the installer asks before using Windows' supported `wsl --install` command, with administrator approval when needed. It then stops: restart if Windows requests it, open Ubuntu-24.04 once to create your Linux username, and rerun the installer. It does not restart your computer or convert existing distributions automatically.

After successful installation, `launch-win.bat` remembers the selected distribution in ignored `.runtime/wsl-distribution.txt`. An explicit launch argument still overrides it. Windows paths entered for existing repositories, local models, or the cache are translated using `wslpath` before settings are saved.

## Linux and WSL

```bash
bash install-linux.sh
```

Supported baseline: Linux with glibc, Bash, and x86_64 or ARM64 for automated Node.js downloads. Existing compatible Python 3.12 and Linux Node.js 22.12+ are reused. Other architectures can use preinstalled compatible tools. macOS and native Windows inference are not supported by these installers.

Missing Python is installed with uv into `.runtime/tools/python`; missing Node.js is downloaded from the official Node.js 22 release directory into `.runtime/tools/node`, with its published SHA-256 checked before extraction. uv is installed locally when needed. These tools are added to the current setup/launch process's PATH; shell profiles and system Python/Node.js are not replaced.

If curl, git, tar, xz, or sha256sum are missing, Debian/Ubuntu users are asked before apt installs the required system packages without upgrading already-installed ones. Other Linux distributions receive an explicit list of tools to install with their own package manager. Administrative permission is used only for those system packages, not the application environment.

Stop the application before installation. Re-running setup preserves existing recordings and projects, but can refresh application dependencies and rebuild the frontend. An incompatible existing `.venv` is not deleted automatically.

## Repository and model choices

The guided setup offers:

- Existing YuE2 checkout, validated against the supported 0.1.6 package and required helper symbols, or a downloaded checkout at audited commit `ef1936f2ee39fe8de486a0f47a481c95f8d4da87` under `.runtime/repositories/YuE/`. Existing repositories are not checked out, updated, or written to. Existing modified managed checkouts are not reset automatically.
- Existing model and VAE folders, or Hugging Face repository IDs (defaults: `m-a-p/YuE2-3B` and `m-a-p/YuE2-Vae`).
- A chosen Hugging Face cache directory, or the standard user cache. Existing local model folders remain in place.
- Optional model downloads, with available full required-file sizes and revision hashes shown before confirmation. Cached files can reduce actual network traffic. The native `storage.resolve_model` helper determines the files, and `model_identity` verifies weight manifests when provided. Configuration type, tokenizer presence, and multi-shard index presence are also checked. Downloads are pinned to the resolved revision.

Read YuE2's `MODEL_LICENSE` and each selected model's terms before downloading. The installer does not automatically accept gated model access agreements. Use the Hugging Face website to obtain access when required. Optional terminal login stores credentials through Hugging Face's standard user credential mechanism, never in Studio settings; existing cached credentials or `HF_TOKEN` can also be used. Windows login is performed inside WSL.

The original `data/settings.json` (or the settings environment-variable override) is backed up under `.runtime/backups/` before saving changes. `SYNTONAL_STUDIO_SETTINGS` takes precedence over the legacy `YUE2_STUDIO_SETTINGS`. All ordinary settings, including output/project paths, are preserved unless selected installation choices change them. Successful model downloads or two validated local model folders enable offline mode; skipping downloads preserves the existing offline setting.

## Explicit and unattended options

Application and frontend only, with no inference configuration changes:

```bash
bash install-linux.sh --application-only --yes
```

Existing YuE2, selected cache, and model downloads:

```bash
bash install-linux.sh --upstream /path/to/YuE --cache-directory /path/to/model-cache --download-models
```

Existing local model folders without downloads:

```bash
bash install-linux.sh --upstream /path/to/YuE --model-directory /path/to/model --vae-directory /path/to/vae --no-download-models
```

For unattended setup, add `--yes` and supply explicit choices. `--yes` does not request model downloads: those require `--download-models`. It accepts the displayed application/download confirmations, so review the terms first. Missing apt packages additionally require `--install-system-packages`; administrative authentication can still be required. `--login` remains interactive and should not be used in unattended runs.

After WSL prerequisites exist, the same Linux options can be invoked from Windows:

```powershell
wsl --distribution Ubuntu --cd "C:\path\to\SyntonalStudio" --exec bash install-linux.sh --application-only --yes
```

Run `bash install-linux.sh --help` for available options. Foundation-only setup is also retained as `bash scripts/setup.sh`; inference-only setup remains `bash scripts/setup-inference.sh`.

## Start and limits

Windows: `launch-win.bat`. Linux: `bash launch-linux.sh`. Open http://127.0.0.1:8675.

These scripts do not install GPU drivers, change inference precision/defaults, install SheetSage2, initialize Git, or commit/push anything. Model files being downloaded and structurally validated do not prove CUDA compatibility, GPU memory sufficiency, or successful music generation. The official baseline remains a BF16 NVIDIA GPU with 24 GB VRAM. Actual GPU generation is a separate acceptance step.
