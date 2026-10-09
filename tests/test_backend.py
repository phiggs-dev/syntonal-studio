"""Foundation tests use fake inference and local diagnostic probes."""
import subprocess
from types import SimpleNamespace
import sys
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from backend.main import create_app
from backend.settings import Settings, SettingsStore
from backend.services import diagnostics
from backend.services.yue2_service import YuE2Service, pipeline_loader


@pytest.fixture(autouse=True)
def isolated_working_directory(tmp_path, monkeypatch):
    """Default relative storage must never discover the developer's live job receipts."""
    monkeypatch.chdir(tmp_path)

def test_settings_roundtrip_and_invalid_values(tmp_path):
    store = SettingsStore(tmp_path / 'nested/settings.json')
    original = Settings(upstream_repository='/tmp/YuE', model_revision='abc', offline=True)
    store.save(original)
    assert store.load() == original
    assert not list(store.path.parent.glob('*.tmp'))
    for invalid in ({'unknown': 1}, {'model': ' '}, {'outputs_directory': ''}, {'offline': 'false'}):
        with pytest.raises(ValidationError):
            Settings(**invalid)


def test_failed_atomic_save_preserves_original(tmp_path, monkeypatch):
    store = SettingsStore(tmp_path / 'settings.json')
    store.save(Settings())
    def fail(*arguments):
        raise PermissionError('denied')
    monkeypatch.setattr('backend.settings.os.replace', fail)
    with pytest.raises(PermissionError):
        store.save(Settings(offline=True))
    assert not store.load().offline
    assert not list(tmp_path.glob('*.tmp'))


@pytest.mark.parametrize('settings_source', ['default', 'legacy', 'preferred', 'both', 'explicit'])
def test_settings_path_environment_compatibility(tmp_path, monkeypatch, settings_source):
    monkeypatch.delenv('SYNTONAL_STUDIO_SETTINGS', raising=False)
    monkeypatch.delenv('YUE2_STUDIO_SETTINGS', raising=False)
    paths = {name: tmp_path / f'{name}.json' for name in ('default', 'legacy', 'preferred', 'explicit')}
    paths['default'] = tmp_path / 'data/settings.json'
    for name, path in paths.items():
        SettingsStore(path).save(Settings(model=f'test/{name}', outputs_directory=tmp_path / 'outputs', projects_directory=tmp_path / 'projects'))
    if settings_source in {'legacy', 'both', 'explicit'}:
        monkeypatch.setenv('YUE2_STUDIO_SETTINGS', str(paths['legacy']))
    if settings_source in {'preferred', 'both', 'explicit'}:
        monkeypatch.setenv('SYNTONAL_STUDIO_SETTINGS', str(paths['preferred']))
    app = create_app(paths['explicit'] if settings_source == 'explicit' else None)
    expected_source = 'preferred' if settings_source == 'both' else settings_source
    with TestClient(app, base_url='http://127.0.0.1:8675') as client:
        assert client.get('/api/settings').json()['model'] == f'test/{expected_source}'


def test_lazy_service_forwards_controls_and_closes():
    calls = []
    class Pipeline:
        def __call__(self, **request):
            return request
        def close(self):
            calls.append('close')
    def factory(repository):
        calls.append(repository)
        def load(*arguments, **options):
            calls.append((arguments, options))
            return Pipeline()
        return load
    service = YuE2Service(Settings(model_revision='model-hash', vae_revision='vae-hash', huggingface_cache='cache', offline=True), factory)
    assert calls == []
    assert service.generate(style='piano', lyrics='exact\r\ntext') == {'style': 'piano', 'lyrics': 'exact\r\ntext'}
    assert calls[1] == (('m-a-p/YuE2-3B',), dict(vae='m-a-p/YuE2-Vae', revision='model-hash', vae_revision='vae-hash', cache_dir='cache', local_files_only=True))
    service.load()
    assert len(calls) == 2
    service.close()
    service.close()
    assert calls.count('close') == 1


def test_source_loader_rejects_stale_module(tmp_path, monkeypatch):
    package = tmp_path / 'src/yue2'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    monkeypatch.setitem(sys.modules, 'yue2', SimpleNamespace(__file__='/different/yue2/__init__.py'))
    with pytest.raises(RuntimeError, match='different YuE2'):
        pipeline_loader(tmp_path)


def test_api_lifecycle_security_and_static_routing(tmp_path):
    services = []
    class Service:
        def __init__(self, settings):
            self.closed = False
            services.append(self)
        def close(self):
            self.closed = True
    frontend = tmp_path / 'dist'
    frontend.mkdir()
    (frontend / 'index.html').write_text('studio frontend')
    SettingsStore(tmp_path / 'settings.json').save(Settings(outputs_directory=tmp_path / 'outputs', projects_directory=tmp_path / 'projects'))
    app = create_app(tmp_path / 'settings.json', service_factory=Service, diagnostics=lambda settings: {'collected_at': 'now', 'checks': []}, frontend_directory=frontend)
    with TestClient(app, base_url='http://127.0.0.1:8675') as client:
        assert client.get('/api/health').json() == {'status': 'ok', 'phase': 4}
        payload = client.get('/api/settings').json()
        payload['offline'] = True
        for origin in ('http://evil.example', 'null'):
            assert client.put('/api/settings', json=payload, headers={'Origin': origin}).status_code == 403
        assert client.put('/api/settings', json=payload, headers={'Origin': 'http://127.0.0.1:5173'}).status_code == 200
        assert services[0].closed
        assert SettingsStore(tmp_path / 'settings.json').load().offline
        assert client.put('/api/settings', json={'secret': 'no'}).status_code == 422
        assert client.put('/api/settings', json={'offline': False}).status_code == 422
        assert client.get('/api/system').json()['checks'] == []
        assert client.get('/api/missing').status_code == 404
        assert client.get('/settings').text == 'studio frontend'
        assert client.get('/missing.js').status_code == 404
        assert client.get('/%2e%2e/settings.json').status_code == 404
        assert client.get('/api/health', headers={'host': 'evil.example'}).status_code == 400
    assert services[-1].closed


def test_diagnostics_probe_failures_remain_actionable(tmp_path, monkeypatch):
    def timeout(arguments, timeout=10):
        raise subprocess.TimeoutExpired(arguments, timeout)
    monkeypatch.setattr(diagnostics, 'run_probe', timeout)
    monkeypatch.setattr(diagnostics.shutil, 'which', lambda executable: None)
    settings = Settings(outputs_directory=tmp_path, projects_directory=tmp_path, huggingface_cache=tmp_path / 'cache', sheetsage_python=tmp_path / 'missing-python')
    checks = {check['id']: check for check in diagnostics.collect_diagnostics(settings)['checks']}
    assert checks['gpu']['status'] == 'warning'
    assert 'TimeoutExpired' in checks['gpu']['detail']
    assert checks['sheetsage']['status'] == 'warning'
    assert checks['model']['status'] == 'warning'
    assert checks['outputs']['status'] == 'pass'


def test_diagnostics_never_probes_upstream_for_write(tmp_path, monkeypatch):
    def probe(arguments, timeout=10):
        return subprocess.CompletedProcess(arguments, 1, '', '')
    monkeypatch.setattr(diagnostics, 'run_probe', probe)
    def forbidden(*args, **kwargs):
        pytest.fail('Attempted a write probe in read-only upstream')
    monkeypatch.setattr(diagnostics.tempfile, 'TemporaryFile', forbidden)
    settings = Settings(upstream_repository=tmp_path, projects_directory=tmp_path / 'projects', outputs_directory=tmp_path / 'outputs')
    checks = {check['id']: check for check in diagnostics.collect_diagnostics(settings)['checks']}
    assert checks['outputs']['status'] == 'fail'
    assert checks['projects']['status'] == 'fail'
    assert 'read-only upstream' in checks['outputs']['detail']


def test_api_rejects_malformed_origin(tmp_path):
    SettingsStore(tmp_path / 'settings.json').save(Settings(outputs_directory=tmp_path / 'outputs', projects_directory=tmp_path / 'projects'))
    with TestClient(create_app(tmp_path / 'settings.json'), base_url='http://127.0.0.1') as client:
        assert client.put('/api/settings', json={}, headers={'Origin': 'http://['}).status_code == 403


def test_settings_expand_home_for_string_and_path_inputs(monkeypatch, tmp_path):
    from pathlib import Path
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    settings = Settings(upstream_repository="~/YuE", huggingface_cache=Path("~/cache"), sheetsage_python="~/sheet/bin/python")
    assert settings.upstream_repository == tmp_path / "YuE"
    assert settings.huggingface_cache == tmp_path / "cache"
    assert settings.sheetsage_python == tmp_path / "sheet/bin/python"



