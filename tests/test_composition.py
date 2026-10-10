"""Phase 4 acceptance: exact plan tokens, immutable drafts, and queue isolation without GPU."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import numpy as np
import pytest
from fastapi.testclient import TestClient
from backend.services.composition import inspect_plan
from backend.services.jobs import write_json
from backend.services.yue2_service import PlannedResult, YuE2Service
from backend.settings import Settings
from test_generation import FakeService, FakeResult, configured_app, wait_for_job, submit

ABC = 'X:1\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\nV:Vocal\nCDEF GABc|\n'

class FixturePlan:
    def __init__(self, request):
        self.request = SimpleNamespace(to_dict=lambda: request)
        self.abc = ABC
        self.abc_ids = [12, 34]
        self.prefix = [99, 12, 34]
        self.timing = {"seconds": 1.25}
        self.truncated = False

    def save(self, directory):
        (directory / "score.abc").write_bytes(self.abc.encode())
        np.save(directory / "abc_tokens.npy", np.asarray(self.abc_ids, dtype=np.int32))
        np.save(directory / "prefix.npy", np.asarray(self.prefix, dtype=np.int32))
        write_json(directory / "plan.json", dict(request=self.request.to_dict(), abc=self.abc, abc_ids=self.abc_ids, prefix=self.prefix, timing=self.timing, truncated=self.truncated))
        write_json(directory / "plan_manifest.json", {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in ("plan.json", "score.abc", "abc_tokens.npy", "prefix.npy")})

class CompositionService(FakeService):
    def plan(self, **request):
        self.requests.append(request)
        request["on_stage"]("planning")
        native = {key: value for key, value in request.items() if key in {"id", "style", "lyrics", "cot", "seed", "cfg_scale"}}
        native["abc"] = None
        return PlannedResult(FixturePlan(native), {"generation": "unchanged"}, {"mot": "fixture"})

    def generate_exact(self, directory, **request):
        data, _ = inspect_plan(directory)
        self.exact_request = data["request"]
        self.exact_tokens = data["abc_ids"]
        request["on_stage"]("semantic")
        return FakeResult()


def plan_job(client):
    response = client.post('/api/compose/plans', json={"style": " exact style ", "lyrics": " exact lyrics\r\n", "seed": "9223372036854775807", "title": "Plan"})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "complete", job
    return job


def test_plan_only_queue_metadata_history_and_exact_snapshot(tmp_path):
    app = configured_app(tmp_path, CompositionService)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        original = plan_job(client)
        assert original["request"]["operation"] == "plan"
        assert original["audio_url"] is original["duration_seconds"] is original["sample_rate"] is None
        directory = Path(original["output_directory"]) / "artifacts"
        assert not (directory / "audio.flac").exists()
        assert json.loads((directory / "plan_result.json").read_text())["kind"] == "plan"
        detail = client.get('/api/compose/plans/' + original["id"]).json()
        assert detail["can_reuse_exact"] and detail["abc"] == ABC
        assert client.get('/api/compose/plans').json()["plans"][0]["id"] == original["id"]
        manifest = client.get(f'/api/history/{original["id"]}/reproduction').json()
        assert manifest["weights"] == {"mot": "fixture"}
        assert not any("result.json" in warning for warning in manifest["warnings"])
        artifacts = client.get(f'/api/history/{original["id"]}/artifacts').json()["artifacts"]
        assert all(item["name"] != "artifacts/audio.flac" for item in artifacts)
        assert next(item for item in artifacts if item["name"] == "artifacts/plan.json")["integrity"] == "verified"
        response = client.post(f'/api/compose/plans/{original["id"]}/render', json={"title": "Rendered plan"})
        assert response.status_code == 202, response.text
        child = wait_for_job(client, response.json()["id"])
        assert child["status"] == "complete", child
        assert child["request"]["source_plan_id"] == original["id"]
        assert child["id"] != original["id"]
        assert app.state.job_manager.service.exact_request["id"] == original["id"]
        assert app.state.job_manager.service.exact_tokens == [12, 34]
        assert (Path(child["output_directory"]) / "source_plan/plan.json").read_bytes() == (directory / "plan.json").read_bytes()
        assert client.get(f'/api/history/{child["id"]}/reuse').status_code == 422


def test_changed_and_symlinked_plan_rejected_before_reservation(tmp_path):
    with TestClient(configured_app(tmp_path, CompositionService), base_url="http://127.0.0.1") as client:
        job = plan_job(client)
        score = Path(job["output_directory"]) / "artifacts/score.abc"
        before = score.read_bytes()
        score.write_bytes(before + b'changed')
        detail = client.get('/api/compose/plans/' + job["id"]).json()
        assert not detail["can_reuse_exact"]
        assert client.post(f'/api/compose/plans/{job["id"]}/render', json={}).status_code == 422
        assert len(client.get('/api/jobs').json()["jobs"]) == 1
        score.unlink()
        score.symlink_to(tmp_path / 'settings.json')
        assert client.post(f'/api/compose/plans/{job["id"]}/render', json={}).status_code == 422


def test_immutable_score_versions_exact_text_hash_download_and_references(tmp_path):
    with TestClient(configured_app(tmp_path, CompositionService), base_url="http://127.0.0.1") as client:
        job = plan_job(client)
        original = '  unsupported draft\r\n café\n'
        response = client.post('/api/compose/scores', json={"title": "Draft", "abc": original, "source_generation_id": job["id"]})
        assert response.status_code == 201, response.text
        first = response.json()
        assert first["sha256"] == hashlib.sha256(original.encode()).hexdigest()
        second = client.post('/api/compose/scores', json={"title": "Edited", "abc": ABC, "parent_score_id": first["id"]}).json()
        assert second["id"] != first["id"]
        assert client.get(f'/api/compose/scores/{first["id"]}/abc').content == original.encode()
        assert client.get(f'/api/compose/scores/{first["id"]}').json() == first
        for field in ('project_id', 'parent_score_id', 'source_generation_id'):
            assert client.post('/api/compose/scores', json={"abc": ABC, field: 'a' * 32}).status_code in (404, 422)
        path = tmp_path / 'projects/scores' / first["id"] / 'score.abc'
        path.write_text('changed')
        assert client.get(f'/api/compose/scores/{first["id"]}').status_code == 422
        listing = client.get('/api/compose/scores').json()
        assert len(listing["scores"]) == 1 and listing["warnings"]
        assert client.patch(f'/api/compose/scores/{second["id"]}', json={"abc": "overwrite"}).status_code == 405


def test_score_render_forwards_saved_text_and_preserves_lineage(tmp_path, monkeypatch):
    monkeypatch.setattr('backend.services.abc_service.ABCService.validate', lambda self, abc: {"valid": True, "errors": []})
    app = configured_app(tmp_path, CompositionService)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        parent = plan_job(client)
        score = client.post('/api/compose/scores', json={"abc": ABC, "source_generation_id": parent["id"], "editor_metadata": {"lyrics": "Words", "phrases": [{"section": 0, "line": 0, "text": "Words", "first_bar": 1, "last_bar": 1}], "alignment": {"abc": ABC, "lyrics": "Words", "lines": [{"section": 0, "line": 0, "text": "Words", "syllables": [{"text": "Words", "first_note": 0, "last_note": 0}]}]}}}).json()
        payload = {"style": "piano", "lyrics": "Words", "cot": "melody", "seed": "123"}
        response = client.post(f'/api/compose/scores/{score["id"]}/render', json=payload)
        assert response.status_code == 202, response.text
        child = wait_for_job(client, response.json()["id"])
        assert child["status"] == "complete"
        native = app.state.job_manager.service.requests[-1]
        assert native["abc"] == ABC and native["seed"] == 123
        assert "score_version_id" not in native and "operation" not in native and "editor_metadata" not in native
        assert child["request"]["score_version_id"] == score["id"]
        lineage = json.loads((Path(child["output_directory"]) / 'lineage.json').read_text())
        assert lineage["source_plan_id"] is None and lineage["parent_generation_id"] == parent["id"]
        for extra in ({"cot": "off"}, {"abc": "different"}):
            assert client.post(f'/api/compose/scores/{score["id"]}/render', json={**payload, **extra}).status_code == 422


@pytest.mark.parametrize('extra', [{"operation": "exact_plan"}, {"operation": "plan", "cot": "off"}, {"operation": "plan", "abc": ABC}, {"abc": ABC, "cot": "off"}, {"score_version_id": 'a'*32}, {"source_plan_id": 'a'*32}])
def test_invalid_composition_request_fails_without_reserving_job(tmp_path, extra):
    with TestClient(configured_app(tmp_path), base_url="http://127.0.0.1") as client:
        assert client.post('/api/jobs', json={"style": "piano", "lyrics": "Words", **extra}).status_code == 422
        assert client.get('/api/jobs').json() == {"jobs": []}


def test_public_exact_plan_override_clears_after_success_and_failure(tmp_path, monkeypatch):
    package = tmp_path / 'src/yue2'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    request = {"id": "native-id", "style": "original", "lyrics": "words", "seed": 123, "cot": "full", "abc": None, "cfg_scale": None}
    loaded = FixturePlan(request)
    class NativePipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()
        def plan(self, **kwargs):
            return 'new plan'
        def __call__(self, **kwargs):
            native_request = SimpleNamespace(cot='full', to_dict=lambda: kwargs)
            return self.plan(request=native_request)
        def close(self):
            pass
    monkeypatch.setattr('backend.services.yue2_service._configured_source', None)
    monkeypatch.setitem(sys.modules, 'yue2', SimpleNamespace(__file__=str(package / '__init__.py'), YuE2Pipeline=NativePipeline))
    monkeypatch.setitem(sys.modules, 'yue2.pipeline', SimpleNamespace(SymbolicPlan=SimpleNamespace(load=lambda directory: loaded)))
    service = YuE2Service(Settings(upstream_repository=tmp_path))
    assert service.generate_exact(tmp_path) is loaded
    assert service._pipeline.exact_plan is None
    assert service.generate(**request) == 'new plan'
    def failure(**kwargs):
        raise RuntimeError('native failure')
    monkeypatch.setattr(NativePipeline, '__call__', lambda self, **kwargs: failure(**kwargs))
    with pytest.raises(RuntimeError, match='native failure'):
        service.generate_exact(tmp_path)
    assert service._pipeline.exact_plan is None and service._pipeline.stage_callback is None


def test_plan_adapter_does_not_call_song_pipeline(tmp_path):
    calls = []
    plan = FixturePlan({})
    class Pipeline:
        weights = {"mot": "same"}
        def plan(self, **request):
            calls.append(request)
            return plan
        def effective_config(self, request):
            return {"unchanged": True}
        def __call__(self, **kwargs):
            pytest.fail('Plan-only must not execute the song pipeline')
    service = YuE2Service(Settings(), lambda repository: lambda *args, **kwargs: Pipeline())
    result = service.plan(style=' exact ', lyrics='words')
    assert result.plan is plan and calls == [{"style": ' exact ', "lyrics": 'words'}]
    assert service._pipeline.stage_callback is None


def test_actual_upstream_call_reuses_loaded_plan_without_planner_or_gpu(tmp_path):
    """Exercise the installed checkout's real __call__ orchestration with bounded stage stubs."""
    import os
    import subprocess
    repository = Path(__file__).resolve().parents[2] / 'YuE'
    if not (repository / 'src/yue2/pipeline.py').is_file():
        pytest.skip('Sibling upstream checkout is unavailable for integration test')
    from importlib.util import find_spec
    missing = [module for module in ('torch', 'soundfile') if find_spec(module) is None]
    if missing:
        pytest.skip('Native orchestration integration requires optional inference dependencies: ' + ', '.join(missing) + '; install scripts/setup-inference.sh to enable it')
    script = r'''
import sys
from pathlib import Path
import numpy as np
from backend.services.yue2_service import YuE2Service, pipeline_loader
from backend.settings import Settings
repository, directory = Path(sys.argv[1]), Path(sys.argv[2])
Observed = pipeline_loader(repository).__self__
from yue2.pipeline import SymbolicPlan, SemanticResult
from yue2.protocol import SongRequest
request = SongRequest(id='original-native-id', style=' exact ', lyrics='words\n', seed=123, cot='full')
original = SymbolicPlan(request, 'X:1\nK:C\nC|', [5, 6], [10, 20, 5, 6], {'seconds': 9}, False)
original.save(directory)
seen = []
class BoundedPipeline(Observed):
    def effective_config(self, request, *args):
        return {'fixture': True}
    def generate_semantic(self, plan, **kwargs):
        seen.append(('semantic', plan))
        assert plan.request.to_dict() == request.to_dict()
        assert plan.abc_ids == [5, 6] and plan.prefix == [10, 20, 5, 6]
        return SemanticResult(plan, [1, 2], {'seconds': 0}, False)
    def synthesize(self, semantic, **kwargs):
        seen.append(('synthesize', semantic.plan))
        return np.zeros((2, 64), dtype=np.float32)
    def decode(self, latents):
        seen.append(('decode', None))
        return np.zeros((480, 2), dtype=np.float32)
pipeline = object.__new__(BoundedPipeline)
pipeline.weights = {'mot': 'fixture'}
pipeline.load_timing = {}
pipeline.progress = False
service = YuE2Service(Settings(), lambda repository: lambda *args, **kwargs: pipeline)
result = service.generate_exact(directory)
assert result.semantic.plan.request.id == 'original-native-id'
assert result.semantic.plan.abc_ids == [5, 6]
assert result.sample_rate == 48000
assert result.timing['abc'] == {'seconds': 9}
assert [stage for stage, _ in seen] == ['semantic', 'synthesize', 'decode']
assert pipeline.exact_plan is None and pipeline.stage_callback is None
result.save_artifacts(directory / 'rendered')
assert SymbolicPlan.load(directory / 'rendered').prefix == original.prefix
print('Native orchestration, original request ID, exact tokens, timing and artifacts verified; no model loaded.')
'''
    result = subprocess.run([sys.executable, '-c', script, str(repository), str(tmp_path / 'plan')], cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'no model loaded' in result.stdout


def test_saved_plan_configuration_drift_rejected_before_planning(monkeypatch):
    monkeypatch.setitem(sys.modules, 'yue2.protocol', SimpleNamespace(SongRequest=lambda **kwargs: kwargs))
    pipeline = SimpleNamespace(weights={'mot': 'current'}, effective_config=lambda request: {'steps': 32}, plan=lambda **kwargs: pytest.fail('Must reject drift before planning'))
    service = YuE2Service(Settings(), lambda repository: lambda *args, **kwargs: pipeline)
    service.expected_reproduction = {'config': {'steps': 16}, 'weights': {'mot': 'saved'}}
    with pytest.raises(ValueError, match='Saved configuration or weights differ'):
        service.plan(style='x', lyrics='y')

def test_score_phrase_metadata_roundtrip_and_legacy_versions(tmp_path):
    from backend.composition_models import ScoreInput
    with TestClient(configured_app(tmp_path, CompositionService), base_url="http://127.0.0.1") as client:
        legacy = client.post('/api/compose/scores', json={"abc": ABC, "title": "Legacy"})
        assert legacy.status_code == 201, legacy.text
        assert legacy.json()["editor_metadata"] is None
        metadata = {"lyrics": "[Verse]\nFirst line\n", "phrases": [
            {"section": 0, "line": 0, "text": "First line", "first_bar": 1, "last_bar": 2}
        ]}
        saved = client.post('/api/compose/scores', json={"abc": ABC, "editor_metadata": metadata, "parent_score_id": legacy.json()["id"]})
        assert saved.status_code == 201, saved.text
        assert saved.json()["sha256"] == legacy.json()["sha256"]
        assert saved.json()["id"] != legacy.json()["id"]
        restored = client.get('/api/compose/scores/' + saved.json()["id"]).json()
        assert restored["editor_metadata"] == metadata
        assert client.get('/api/compose/scores/' + legacy.json()["id"]).json()["editor_metadata"] is None
        # Existing on-disk metadata without the optional field remains readable.
        metadata_path = tmp_path / "projects" / "scores" / legacy.json()["id"] / "score.json"
        legacy_metadata = json.loads(metadata_path.read_text())
        legacy_metadata.pop("editor_metadata")
        metadata_path.write_text(json.dumps(legacy_metadata))
        assert client.get('/api/compose/scores/' + legacy.json()["id"]).json()["editor_metadata"] is None
        assert ScoreInput.model_validate({"abc": ABC}).editor_metadata is None
        bad = {**metadata, "phrases": [{"section": 0, "line": 0, "text": "Line", "first_bar": 3, "last_bar": 1}]}
        assert client.post('/api/compose/scores', json={"abc": ABC, "editor_metadata": bad}).status_code == 422
        assert client.post('/api/compose/scores', json={"abc": ABC, "editor_metadata": {**metadata, "unexpected": True}}).status_code == 422


def test_manual_syllable_alignment_is_versioned_sidecar_and_preserves_stale_snapshots(tmp_path):
    import copy
    metadata = {"lyrics": "[Verse]\nGolden hour", "phrases": [], "alignment": {
        "abc": ABC, "lyrics": "[Verse]\nGolden hour", "lines": [{
            "section": 0, "line": 0, "text": "Golden hour", "syllables": [
                {"text": "Gold", "first_note": 0, "last_note": 1},
                {"text": "en", "first_note": None, "last_note": None}]}]}}
    with TestClient(configured_app(tmp_path, CompositionService), base_url="http://127.0.0.1") as client:
        original = client.post('/api/compose/scores', json={"abc": ABC}).json()
        saved = client.post('/api/compose/scores', json={"abc": ABC, "parent_score_id": original["id"], "editor_metadata": metadata})
        assert saved.status_code == 201, saved.text
        assert saved.json()["sha256"] == original["sha256"]
        assert client.get('/api/compose/scores/' + saved.json()["id"]).json()["editor_metadata"] == metadata
        assert client.get('/api/compose/scores/' + original["id"]).json()["editor_metadata"] is None
        stale_metadata = {**metadata, "working_lyrics": "[Verse]\nChanged words"}
        stale = client.post('/api/compose/scores', json={"abc": ABC + "\n", "editor_metadata": stale_metadata})
        assert stale.status_code == 201
        assert stale.json()["editor_metadata"] == stale_metadata
        for first, last in [(1, 0), (0, None), (-1, 0), (0, 100001), (True, 1)]:
            bad = copy.deepcopy(metadata)
            bad["alignment"]["lines"][0]["syllables"][0].update(first_note=first, last_note=last)
            assert client.post('/api/compose/scores', json={"abc": ABC, "editor_metadata": bad}).status_code == 422
        bad = copy.deepcopy(metadata)
        bad["alignment"]["lines"].append(bad["alignment"]["lines"][0])
        assert client.post('/api/compose/scores', json={"abc": ABC, "editor_metadata": bad}).status_code == 422
