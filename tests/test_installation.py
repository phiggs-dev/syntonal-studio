"""Installer tests isolate settings and mock downloads; no model or system installs run."""
from importlib import util
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'scripts/install.py'
specification = util.spec_from_file_location('studio_install', SCRIPT_PATH)
installer = util.module_from_spec(specification)
specification.loader.exec_module(installer)


@pytest.fixture
def installation(tmp_path, monkeypatch):
    monkeypatch.setattr(installer, 'PROJECT_ROOT', tmp_path)
    monkeypatch.delenv('SYNTONAL_STUDIO_SETTINGS', raising=False)
    monkeypatch.delenv('YUE2_STUDIO_SETTINGS', raising=False)
    class UnusedPort:
        def __enter__(self): return self
        def __exit__(self, *arguments): pass
        def connect_ex(self, address): return 111
    monkeypatch.setattr(installer, 'socket', SimpleNamespace(socket=UnusedPort))
    repository = tmp_path / 'existing YuE'
    source = repository / 'src/yue2'
    source.mkdir(parents=True)
    (repository / 'pyproject.toml').write_text('[project]\nname="yue2-infer"\nversion="0.1.6"\n')
    (repository / 'MODEL_LICENSE').write_text('Fixture model terms')
    (source / 'pipeline.py').write_text('class YuE2Pipeline: pass\n')
    (source / 'storage.py').write_text('def resolve_model(): pass\ndef model_identity(): pass\n')
    storage = SimpleNamespace(MODEL_FILES={'config.json','model.safetensors','qwen.tiktoken'}, MODEL_LICENSES=set(), model_identity=lambda path: {'files': {}})
    monkeypatch.setattr(installer, 'load_storage', lambda path: storage)
    calls = []
    monkeypatch.setattr(installer, 'run', lambda arguments, **kwargs: calls.append(arguments))
    return repository, storage, calls


def test_existing_source_and_settings_are_preserved_on_dependency_failure(installation, monkeypatch):
    repository, storage, calls = installation
    store = installer.SettingsStore(installer.PROJECT_ROOT / 'data/settings.json')
    store.save(installer.Settings(offline=True))
    before = store.path.read_bytes()
    source_before = (repository / 'pyproject.toml').read_bytes()
    def fail(arguments, **kwargs):
        raise subprocess.CalledProcessError(1, arguments)
    monkeypatch.setattr(installer, 'run', fail)
    with pytest.raises(subprocess.CalledProcessError):
        installer.main(['--upstream', str(repository), '--yes', '--no-download-models'])
    assert store.path.read_bytes() == before
    assert (repository / 'pyproject.toml').read_bytes() == source_before


def test_existing_repository_and_cache_selection_back_up_settings(installation):
    repository, storage, calls = installation
    store = installer.SettingsStore(installer.PROJECT_ROOT / 'data/settings.json')
    store.save(installer.Settings(offline=True, model_revision='pinned-model'))
    before = store.path.read_bytes()
    cache = installer.PROJECT_ROOT / 'my model cache'
    assert installer.main(['--upstream', str(repository), '--cache-directory', str(cache), '--yes', '--no-download-models']) == 0
    result = store.load()
    assert result.upstream_repository == repository
    assert result.huggingface_cache == cache
    assert result.model_revision == 'pinned-model'
    assert result.offline
    assert calls == [['bash', 'scripts/setup-inference.sh', str(repository)]]
    backups = list((installer.PROJECT_ROOT / '.runtime/backups').glob('settings-*.json'))
    assert len(backups) == 1 and backups[0].read_bytes() == before


def test_windows_paths_are_translated_without_shell_interpolation(monkeypatch):
    recorded = []
    def translate(arguments, **kwargs):
        recorded.append(arguments)
        return '/mnt/d/Models with spaces\n'
    monkeypatch.setattr(installer.subprocess, 'check_output', translate)
    assert installer.linux_path(r'D:\Models with spaces') == Path('/mnt/d/Models with spaces')
    assert recorded == [['wslpath', '-u', r'D:\Models with spaces']]


def test_local_model_and_vae_skip_downloads(installation):
    repository, storage, calls = installation
    arguments = ['--upstream', str(repository), '--yes', '--no-download-models']
    for option, model_type in [('--model-directory','yue2'), ('--vae-directory','yue2_vae')]:
        directory = installer.PROJECT_ROOT / model_type
        directory.mkdir()
        (directory / 'config.json').write_text(json.dumps({'model_type': model_type}))
        if model_type == 'yue2':
            (directory / 'qwen.tiktoken').write_text('fixture tokenizer')
        arguments.extend([option, str(directory)])
    assert installer.main(arguments) == 0
    settings = installer.SettingsStore(installer.PROJECT_ROOT / 'data/settings.json').load()
    assert settings.offline
    assert settings.model_revision is None and settings.vae_revision is None


def test_model_downloads_pin_revisions_and_forward_cache(installation, monkeypatch):
    repository, storage, calls = installation
    destinations = {}
    for source, kind in [('m-a-p/YuE2-3B','yue2'), ('m-a-p/YuE2-Vae','yue2_vae')]:
        path = installer.PROJECT_ROOT / kind
        path.mkdir()
        (path / 'config.json').write_text(json.dumps({'model_type':kind}))
        (path / 'qwen.tiktoken').write_text('fixture tokenizer')
        destinations[source] = path
    class API:
        def model_info(self, source, **options):
            assert options['files_metadata']
            return SimpleNamespace(sha='resolved-revision', siblings=[SimpleNamespace(rfilename='model.safetensors',size=100)])
    monkeypatch.setitem(sys.modules, 'huggingface_hub', SimpleNamespace(HfApi=API))
    downloads = []
    def resolve(source, **options):
        downloads.append((source,options))
        return destinations[source]
    storage.resolve_model = resolve
    settings = installer.Settings(huggingface_cache=installer.PROJECT_ROOT / 'cache')
    installer.model_downloads(settings, storage, automatic=True)
    assert len(downloads) == 2
    assert all(options == {'revision':'resolved-revision','cache_dir':settings.huggingface_cache} for source,options in downloads)
    assert settings.offline and settings.model_revision == settings.vae_revision == 'resolved-revision'


def test_failed_download_does_not_save_settings(installation, monkeypatch):
    repository, storage, calls = installation
    store = installer.SettingsStore(installer.PROJECT_ROOT / 'data/settings.json')
    store.save(installer.Settings(offline=True))
    before = store.path.read_bytes()
    def fail(*arguments, **options):
        raise OSError('Interrupted model download')
    monkeypatch.setattr(installer, 'model_downloads', fail)
    with pytest.raises(OSError):
        installer.main(['--upstream',str(repository),'--yes','--download-models'])
    assert store.path.read_bytes() == before


def test_cache_cannot_write_inside_existing_source(installation):
    repository, storage, calls = installation
    with pytest.raises(ValueError, match='cache cannot'):
        installer.main(['--upstream',str(repository),'--cache-directory',str(repository / 'cache'),'--yes'])
    assert not calls


def test_application_only_never_changes_settings_or_clones(installation):
    repository, storage, calls = installation
    assert installer.main(['--application-only','--yes']) == 0
    assert not calls
    assert not (installer.PROJECT_ROOT / 'data/settings.json').exists()


def test_existing_managed_checkout_is_never_reset(installation, monkeypatch):
    repository, storage, calls = installation
    monkeypatch.setattr(installer.subprocess, 'check_output', lambda *arguments, **options:'modified\n')
    before = (repository / 'pyproject.toml').read_bytes()
    with pytest.raises(ValueError, match='left unchanged'):
        installer.acquire_checkout(repository)
    assert not calls and (repository / 'pyproject.toml').read_bytes() == before


def test_storage_helper_never_writes_into_external_checkout(installation):
    repository, storage, calls = installation
    specification = util.spec_from_file_location('installer_for_storage_test', SCRIPT_PATH)
    independent = util.module_from_spec(specification)
    specification.loader.exec_module(independent)
    independent.load_storage(repository)
    assert not list(repository.rglob('*.pyc'))


def test_managed_checkout_is_pinned_before_atomic_publication(installation, monkeypatch):
    import shutil
    repository, storage, calls = installation
    destination = installer.PROJECT_ROOT / '.runtime/repositories/YuE'
    def clone(arguments, **options):
        calls.append(arguments)
        if arguments[1] == 'clone':
            shutil.copytree(repository, arguments[-1])
    monkeypatch.setattr(installer, 'run', clone)
    assert installer.acquire_checkout(destination) == destination
    assert calls[1][-2:] == ['--detach', installer.UPSTREAM_COMMIT]
    assert (destination / 'src/yue2/storage.py').is_file()
    assert not list(destination.parent.glob('yue-download-*'))


def test_linux_bootstrap_reuses_prerequisites_and_preserves_arguments(tmp_path):
    import os
    import shutil
    root = tmp_path / 'Studio with spaces'
    (root / 'scripts').mkdir(parents=True)
    source_root = SCRIPT_PATH.parents[1]
    for name in ['install-linux.sh','scripts/runtime-env.sh']:
        shutil.copyfile(source_root / name, root / name)
    (root / 'scripts/setup.sh').write_text('echo foundation >> "$RECORD"\n')
    binaries = root / 'fake-tools'
    binaries.mkdir()
    (root / '.venv/bin').mkdir(parents=True)
    python_wrapper = root / '.venv/bin/python'
    python_wrapper.write_text('#!/usr/bin/env bash\nif [[ "$1" == -c && "$2" == *connect_ex* ]]; then exit 0; elif [[ "$1" == scripts/install.py ]]; then printf "%s\\n" "$@" >> "$RECORD"; else exec "$REAL_PYTHON" "$@"; fi\n')
    node = binaries / 'node'
    node.write_text('#!/usr/bin/env bash\nif [[ "$1" == -p ]]; then echo linux; else echo v22.12.0; fi\n')
    npm = binaries / 'npm'
    npm.write_text('#!/usr/bin/env bash\nexit 0\n')
    curl = binaries / 'curl'
    curl.write_text('#!/usr/bin/env bash\necho Unexpected network request >&2; exit 99\n')
    for executable in [python_wrapper,node,npm,curl]:
        executable.chmod(0o755)
    record = root / 'calls.txt'
    environment = dict(os.environ, PATH=str(binaries)+':'+os.environ['PATH'], REAL_PYTHON=sys.executable, RECORD=str(record))
    result = subprocess.run(['bash',str(root / 'install-linux.sh'),'--yes','--upstream',str(root / 'existing source'),'--no-download-models'],cwd=tmp_path,env=environment,capture_output=True,text=True)
    assert result.returncode == 0, result.stderr
    assert record.read_text().splitlines() == ['foundation','scripts/install.py','--yes','--upstream',str(root / 'existing source'),'--no-download-models']
    assert not (root / '.runtime').exists()


def test_running_server_blocks_inference_installation(installation, monkeypatch):
    repository, storage, calls = installation
    class ActivePort:
        def __enter__(self): return self
        def __exit__(self, *arguments): pass
        def connect_ex(self, address): return 0
    monkeypatch.setattr(installer, 'socket', SimpleNamespace(socket=ActivePort))
    with pytest.raises(ValueError, match='Stop the Studio server'):
        installer.main(['--upstream',str(repository),'--yes'])
    assert not calls and not (installer.PROJECT_ROOT / 'data/settings.json').exists()
