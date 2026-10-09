"""Guided YuE2 installation; paths are Linux/WSL paths and model sizes are bytes."""
from __future__ import annotations

import argparse
import fnmatch
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
from typing import Any

# Running this file directly adds scripts/, not the application root, to sys.path.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(PROJECT_ROOT))
from backend.settings import Settings, SettingsStore

UPSTREAM_URL = 'https://github.com/multimodal-art-projection/YuE.git'
UPSTREAM_COMMIT = 'ef1936f2ee39fe8de486a0f47a481c95f8d4da87'


def run(arguments: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(arguments, cwd=cwd or PROJECT_ROOT, check=True)


def ask(label: str, default: str = '', *, automatic: bool = False) -> str:
    if automatic:
        return default
    suffix = f' [{default}]' if default else ''
    return input(f'{label}{suffix}: ').strip() or default


def confirm(label: str, *, automatic: bool = False) -> bool:
    return automatic or input(f'{label} [y/N]: ').strip().lower() in {'y', 'yes'}


def linux_path(value: str) -> Path:
    if re.match(r'^[A-Za-z]:[\\/]', value) or value.startswith('\\\\'):
        value = subprocess.check_output(['wslpath', '-u', value], text=True).strip()
    return Path(value).expanduser().resolve()


def validate_checkout(repository: Path) -> None:
    import ast
    import tomllib
    metadata_path = repository / 'pyproject.toml'
    metadata = tomllib.loads(metadata_path.read_text())
    if metadata.get('project', {}).get('name') != 'yue2-infer' or metadata['project'].get('version') != '0.1.6':
        raise ValueError('This installer supports the audited YuE2 0.1.6 API. Select a compatible checkout.')
    for filename, symbols in [('storage.py', {'resolve_model', 'model_identity'}), ('pipeline.py', {'YuE2Pipeline'})]:
        tree = ast.parse((repository / 'src/yue2' / filename).read_text())
        located = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        if not symbols <= located:
            raise ValueError(f'Expected YuE2 APIs missing in {filename}')
    if not (repository / 'MODEL_LICENSE').is_file():
        raise ValueError('YuE2 MODEL_LICENSE is missing')


def acquire_checkout(destination: Path) -> Path:
    if destination.exists():
        validate_checkout(destination)
        commit = subprocess.check_output(['git', '-C', str(destination), 'rev-parse', 'HEAD'], text=True).strip()
        changes = subprocess.check_output(['git', '-C', str(destination), 'status', '--porcelain'], text=True).strip()
        if commit != UPSTREAM_COMMIT or changes:
            raise ValueError('Managed YuE2 checkout differs from the audited commit. It was left unchanged; select it explicitly as an existing repository if intended.')
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='yue-download-', dir=destination.parent) as temporary:
        checkout = Path(temporary) / 'YuE'
        run(['git', 'clone', '--filter=blob:none', '--no-checkout', UPSTREAM_URL, str(checkout)])
        run(['git', '-C', str(checkout), 'checkout', '--detach', UPSTREAM_COMMIT])
        validate_checkout(checkout)
        checkout.rename(destination)
    return destination


def load_storage(repository: Path) -> Any:
    # Load the verified lightweight helper without importing torch or creating a pipeline.
    specification = importlib.util.spec_from_file_location('syntonal_installer_storage', repository / 'src/yue2/storage.py')
    if specification is None or specification.loader is None:
        raise ValueError('Cannot load YuE2 storage helpers')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def validate_model(directory: Path, storage: Any, expected_type: str) -> None:
    config = json.loads((directory / 'config.json').read_text())
    if config.get('model_type') != expected_type:
        raise ValueError(f'{directory} is not a {expected_type} model')
    if expected_type == 'yue2' and not (directory / 'qwen.tiktoken').is_file():
        raise ValueError('YuE2 tokenizer qwen.tiktoken is missing')
    storage.model_identity(directory)
    if len(list(directory.glob('model-*-of-*.safetensors'))) > 1 and not (directory / 'model.safetensors.index.json').is_file():
        raise ValueError('Sharded model index is missing')


def model_downloads(settings: Settings, storage: Any, *, automatic: bool) -> None:
    from huggingface_hub import HfApi
    patterns = sorted(storage.MODEL_FILES) + ['model-?????-of-?????.safetensors'] + ['licenses/' + name for name in sorted(storage.MODEL_LICENSES)]
    pending = []
    for field, revision_field, expected_type in [('model', 'model_revision', 'yue2'), ('vae', 'vae_revision', 'yue2_vae')]:
        source = getattr(settings, field)
        if Path(source).is_dir():
            validate_model(Path(source), storage, expected_type)
            continue
        information = HfApi().model_info(source, revision=getattr(settings, revision_field), files_metadata=True)
        selected = [file for file in information.siblings if any(fnmatch.fnmatchcase(file.rfilename, pattern) for pattern in patterns)]
        sizes = [file.size for file in selected]
        size_description = f'{sum(sizes) / 1024**3:.2f} GiB' if sizes and all(size is not None for size in sizes) else 'size unavailable'
        print(f'{source} @ {information.sha}: {size_description} in required files (cached files may reduce the download).')
        print(f'Model terms: https://huggingface.co/{source}/blob/{information.sha}/README.md')
        pending.append((field, revision_field, expected_type, information.sha))
    if pending and not confirm('Download these models after reviewing their terms?', automatic=automatic):
        raise ValueError('Download declined; existing settings were not changed. Rerun with --no-download-models for application setup only.')
    if settings.huggingface_cache:
        settings.huggingface_cache.mkdir(parents=True, exist_ok=True)
    for field, revision_field, expected_type, revision in pending:
        directory = storage.resolve_model(getattr(settings, field), revision=revision, cache_dir=settings.huggingface_cache)
        validate_model(directory, storage, expected_type)
        setattr(settings, revision_field, revision)
    settings.offline = True


def save_settings(store: SettingsStore, settings: Settings) -> None:
    if store.path.is_file():
        backup_directory = PROJECT_ROOT / '.runtime/backups'
        backup_directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix='settings-', suffix='.json', dir=backup_directory, delete=False) as backup:
            backup.write(store.path.read_bytes())
    store.save(settings)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Configure YuE2 and optionally download its required models. Run through install-linux.sh after prerequisite setup.')
    parser.add_argument('--application-only', action='store_true', help='Skip inference setup and preserve existing settings')
    parser.add_argument('--upstream', help='Existing YuE2 repository; Windows paths accepted under WSL')
    parser.add_argument('--model-directory', help='Existing local YuE2 model folder')
    parser.add_argument('--vae-directory', help='Existing local YuE2 VAE folder')
    parser.add_argument('--cache-directory', help='Hugging Face cache destination; omit to retain the configured/default cache')
    downloads = parser.add_mutually_exclusive_group()
    downloads.add_argument('--download-models', action='store_true', help='Offer downloads of required model files')
    downloads.add_argument('--no-download-models', action='store_true', help='Skip model downloads')
    parser.add_argument('--login', action='store_true', help='Prompt for Hugging Face login; credentials stay in its standard user credential store')
    parser.add_argument('--yes', action='store_true', help='Accept application confirmations; downloads still require --download-models')
    return parser


def main(arguments: list[str] | None = None) -> int:
    options = build_parser().parse_args(arguments)
    if not options.yes and not sys.stdin.isatty():
        raise ValueError('Interactive installation needs a terminal; use --yes with explicit options for unattended setup.')
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', 8675)) == 0:
            raise ValueError('Stop the Studio server before changing its environment or settings.')
    if options.application_only:
        print('Application installed. Inference setup and existing settings were left unchanged.')
        return 0
    settings_path = linux_path(os.environ.get('SYNTONAL_STUDIO_SETTINGS', os.environ.get('YUE2_STUDIO_SETTINGS', 'data/settings.json')))
    store = SettingsStore(settings_path)
    settings = store.load()
    selected_repository = options.upstream or ask("YuE2 repository: existing path or 'download'", str(settings.upstream_repository or 'download'), automatic=options.yes)
    if selected_repository.lower() == 'download':
        selected_repository = ''
    repository = linux_path(selected_repository) if selected_repository else PROJECT_ROOT / '.runtime/repositories/YuE'
    if selected_repository:
        validate_checkout(repository)
    if settings_path.is_relative_to(repository):
        raise ValueError('Settings cannot be written inside the YuE2 repository')
    model_choice = options.model_directory or ask('YuE2 model: Hub ID or existing directory', settings.model, automatic=options.yes)
    vae_choice = options.vae_directory or ask('VAE: Hub ID or existing directory', settings.vae, automatic=options.yes)
    local_models = []
    for field, choice, explicit in [('model', model_choice, options.model_directory), ('vae', vae_choice, options.vae_directory)]:
        looks_local = explicit or choice.startswith(('/', '.', '~', '\\')) or re.match(r'^[A-Za-z]:', choice) or Path(choice).is_dir()
        if looks_local:
            directory = linux_path(choice)
            if not directory.is_dir():
                raise ValueError(f'Local {field} directory does not exist: {directory}')
            setattr(settings, field, str(directory))
            setattr(settings, 'model_revision' if field == 'model' else 'vae_revision', None)
            local_models.append(field)
        else:
            if choice != getattr(settings, field):
                setattr(settings, 'model_revision' if field == 'model' else 'vae_revision', None)
            setattr(settings, field, choice)
    cache_choice = options.cache_directory if options.cache_directory is not None else ask('Model cache directory (blank uses standard Hugging Face cache)', str(settings.huggingface_cache or ''), automatic=options.yes)
    settings.huggingface_cache = linux_path(cache_choice) if cache_choice else None
    if settings.huggingface_cache and settings.huggingface_cache.is_relative_to(repository):
        raise ValueError('The model cache cannot be inside the read-only YuE2 repository')
    settings.upstream_repository = repository
    download = options.download_models or (not options.no_download_models and not options.yes and confirm('Download the model and VAE now?'))
    print(f'YuE2 source: {repository}')
    print(f'Model: {settings.model}; VAE: {settings.vae}')
    print(f'Cache: {settings.huggingface_cache or "standard Hugging Face cache"}')
    print(f'Settings: {settings_path}')
    print('Inference dependencies may require several GB. Existing recordings and source repositories will not be rewritten.')
    if not confirm('Install inference dependencies and save this configuration?', automatic=options.yes):
        print('Inference setup declined; settings unchanged.')
        return 0
    if not selected_repository:
        acquire_checkout(repository)
    run(['bash', 'scripts/setup-inference.sh', str(repository)])
    storage = load_storage(repository)
    for field in local_models:
        validate_model(Path(getattr(settings, field)), storage, 'yue2' if field == 'model' else 'yue2_vae')
    if options.login or (download and not options.yes and confirm('Sign in to Hugging Face before downloading?')):
        from huggingface_hub import login
        login(add_to_git_credential=False)
    if download:
        model_downloads(settings, storage, automatic=options.yes)
    elif len(local_models) == 2:
        settings.offline = True
    save_settings(store, settings)
    print('Installation complete. Start with bash launch-linux.sh (or launch-win.bat on Windows).')
    print('Download/integrity checks do not establish GPU compatibility or successful music generation.')
    return 0


if __name__ == '__main__':
    os.chdir(PROJECT_ROOT)
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as exception:
        print(f'Installation stopped: {exception}', file=sys.stderr)
        raise SystemExit(1)
