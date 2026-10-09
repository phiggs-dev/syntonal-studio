"""Generation acceptance tests use deterministic fake inference, never torch or model weights."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from backend.generation_models import GenerationRequest
from backend.main import create_app
from backend.services.jobs import JobManager
from backend.services.job_logging import capture_worker_stderr
from backend.services.yue2_service import YuE2Service, pipeline_loader
from backend.settings import Settings, SettingsStore


class FakeResult:
    sample_rate = 48000
    audio = SimpleNamespace(shape=(48000, 2), ndim=2)

    def save_artifacts(self, directory):
        assert not list(directory.iterdir())
        (directory / "audio.flac").write_bytes(b"fLaC0123456789")
        metadata = {"audio_seconds": 1.0, "truncated": {"abc": False, "semantic": True}}
        (directory / "result.json").write_text(json.dumps(metadata))
        return metadata


class FakeService:
    def __init__(self, settings, *, gate=None):
        self.settings = settings
        self.gate = gate
        self.entered = threading.Event()
        self.requests = []
        self.closes = 0
        self.active = 0
        self.maximum_active = 0

    def generate(self, **request):
        self.requests.append(request)
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        self.entered.set()
        try:
            request["on_stage"]("semantic")
            if self.gate is not None:
                while not self.gate.wait(0.01):
                    if request["cancelled"]():
                        raise InterruptedError("Cancelled fake inference")
            if request["style"] == "fail":
                raise RuntimeError("CUDA out of memory")
            if request["style"] == "missing":
                raise ModuleNotFoundError("No module named torch")
            for index in range(100):
                request["on_token"]("semantic", index)
            request["on_stage"]("decoding")
            return FakeResult()
        finally:
            self.active -= 1

    def close(self):
        assert self.active == 0, "Model cleanup must never race inference"
        self.closes += 1


def configured_app(tmp_path, service_factory=FakeService):
    path = tmp_path / "settings.json"
    SettingsStore(path).save(Settings(outputs_directory=tmp_path / "outputs", projects_directory=tmp_path / "projects", upstream_repository=tmp_path / "upstream"))
    return create_app(path, service_factory=service_factory)


def wait_for_job(client, identifier, statuses=("complete", "failed", "cancelled")):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{identifier}").json()
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    pytest.fail(f"Job did not reach {statuses}: {job}")


def submit(client, **changes):
    response = client.post("/api/jobs", json={"style": "piano", "lyrics": "[Verse]\nExact lyrics", **changes})
    assert response.status_code == 202, response.text
    return response.json()


@pytest.mark.parametrize("changes", [
    {"seed": -1}, {"seed": 1}, {"seed": "9223372036854775808"}, {"seed": "1.0"},
    {"seed": "-1"}, {"seed": "１２"}, {"seed": ""}, {"cfg_scale": -1},
    {"cfg_scale": 21}, {"cfg_scale": float("nan")}, {"cfg_scale": True},
    {"cot": "other"}, {"bpm": 120}, {"lyrics": 123},
])
def test_request_rejects_invalid_or_invented_controls(changes):
    with pytest.raises(ValidationError):
        GenerationRequest.model_validate({"style": "piano", "lyrics": "text", **changes})


def test_exact_request_native_artifacts_and_range_audio(tmp_path):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        submitted = submit(client, title="A / song", style="  piano\r\n", lyrics="[Verse]\r\n café \n", seed="9223372036854775807", cfg_scale=None)
        job = wait_for_job(client, submitted["id"])
        assert job["status"] == "complete"
        assert job["token_count"] == 100
        assert job["truncated"] is True
        assert (job["sample_rate"], job["channels"], job["duration_seconds"]) == (48000, 2, 1)
        request = app.state.job_manager.service.requests[0]
        assert request["seed"] == 2**63 - 1
        assert request["id"] == job["id"]
        assert "title" not in request
        assert request["style"] == "  piano\r\n"
        assert request["lyrics"] == "[Verse]\r\n café \n"
        directory = Path(job["output_directory"])
        saved = json.loads((directory / "request.json").read_text())
        assert saved == submitted["request"]
        assert saved["seed"] == "9223372036854775807"
        assert (directory / "settings.json").is_file()
        runtime = json.loads((directory / "runtime.json").read_text())
        assert runtime["runtime"]["python_version"]
        assert runtime["upstream"]["status"] == "unknown"  # Test checkout deliberately does not exist.
        assert not (directory / "artifacts/runtime.json").exists()
        assert not list(directory.glob("*.tmp"))
        response = client.get(job["audio_url"], headers={"Range": "bytes=4-7"})
        assert response.status_code == 206
        assert response.content == b"0123"
        assert response.headers["content-range"] == "bytes 4-7/14"
        assert response.headers["content-type"] == "audio/flac"
        assert "semantic" in client.get(f"/api/jobs/{job['id']}/log").text
        assert client.get("/api/jobs").json()["jobs"][0] == job
        assert client.get("/api/jobs/unknown").status_code == 404
        assert client.get("/api/jobs/unknown/audio").status_code == 404
        assert client.post("/api/jobs/unknown/cancel").status_code == 404
        assert client.post("/api/jobs", json={"style": "x", "lyrics": "y", "reference_audio": "z"}).status_code == 422
        complete_cancel = client.post(f"/api/jobs/{job['id']}/cancel").json()
        assert complete_cancel["status"] == "complete"
        assert complete_cancel["cancel_requested"] is False


def test_fifo_serialization_queued_cancel_and_settings_conflict(tmp_path):
    gate = threading.Event()
    app = configured_app(tmp_path, lambda settings: FakeService(settings, gate=gate))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        first = submit(client)
        service = app.state.job_manager.service
        assert service.entered.wait(2)
        second = submit(client)
        third = submit(client)
        settings = client.get("/api/settings").json()
        settings["offline"] = True
        assert client.put("/api/settings", json=settings).status_code == 409
        assert client.post(f"/api/jobs/{second['id']}/cancel").json()["status"] == "cancelled"
        gate.set()
        assert wait_for_job(client, first["id"])["status"] == "complete"
        assert wait_for_job(client, third["id"])["status"] == "complete"
        assert [request["id"] for request in service.requests] == [first["id"], third["id"]]
        assert service.maximum_active == 1
        assert client.put("/api/settings", json=settings).status_code == 200
        assert service.closes == 1


def test_active_cancel_closes_model_and_allows_next_job(tmp_path):
    gate = threading.Event()
    app = configured_app(tmp_path, lambda settings: FakeService(settings, gate=gate))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        first = submit(client)
        service = app.state.job_manager.service
        assert service.entered.wait(2)
        cancelled = client.post(f"/api/jobs/{first['id']}/cancel").json()
        assert cancelled["cancel_requested"] is True
        assert wait_for_job(client, first["id"])["status"] == "cancelled"
        assert service.closes == 1
        assert client.get(f"/api/jobs/{first['id']}/audio").status_code == 404
        gate.set()
        assert wait_for_job(client, submit(client)["id"])["status"] == "complete"


@pytest.mark.parametrize("style,suggestion", [("fail", "GPU memory was exhausted"), ("missing", "setup-inference.sh")])
def test_failure_preserves_request_and_traceback_and_queue_continues(tmp_path, style, suggestion):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        job = wait_for_job(client, submit(client, style=style)["id"])
        assert job["status"] == "failed"
        assert job["error"].startswith("semantic:")
        assert suggestion in job["error"]
        assert "Traceback" in client.get(f"/api/jobs/{job['id']}/log").text
        assert Path(job["output_directory"], "request.json").is_file()
        assert app.state.job_manager.service.closes == 1
        assert wait_for_job(client, submit(client)["id"])["status"] == "complete"


def test_restart_recovers_interrupted_and_complete_jobs_ignores_unsafe_receipts(tmp_path):
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        complete = wait_for_job(client, submit(client)["id"])
    manager = app.state.job_manager
    interrupted = manager.get(complete["id"])
    interrupted.id = "a" * 32
    interrupted.status = "running"
    interrupted.stage = "semantic"
    interrupted.output_directory = str(tmp_path / "outputs" / interrupted.id)
    interrupted.audio_url = None
    directory = Path(interrupted.output_directory)
    directory.mkdir()
    (directory / "job.json").write_text(interrupted.model_dump_json())
    corrupt = tmp_path / "outputs" / ("b" * 32)
    corrupt.mkdir()
    (corrupt / "job.json").write_text("{}")
    forged = tmp_path / "outputs" / ("c" * 32)
    forged.mkdir()
    (forged / "job.json").write_text(json.dumps({**complete, "id": "c" * 32, "output_directory": str(tmp_path)}))
    recovered = configured_app(tmp_path)
    with TestClient(recovered, base_url="http://127.0.0.1") as client:
        jobs = client.get("/api/jobs").json()["jobs"]
        assert len(jobs) == 2
        job = client.get(f"/api/jobs/{interrupted.id}").json()
        assert job["status"] == "failed"
        assert "cannot be resumed" in job["error"]
        assert client.get(complete["audio_url"]).status_code == 200


def test_unsafe_output_cache_and_artifact_symlinks_are_rejected(tmp_path):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    service = FakeService(Settings())
    manager = JobManager(Settings(upstream_repository=upstream, outputs_directory=upstream / "outputs"), service)
    with pytest.raises(ValueError, match="read-only upstream"):
        manager.submit(GenerationRequest(style="x", lyrics="y"))
    assert not (upstream / "outputs").exists()
    lazy = YuE2Service(Settings(upstream_repository=upstream, huggingface_cache=upstream / "cache"), lambda repository: pytest.fail("Must not import YuE2"))
    with pytest.raises(ValueError, match="read-only upstream"):
        lazy.load()
    app = configured_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        job = wait_for_job(client, submit(client)["id"])
        audio = Path(job["output_directory"]) / "artifacts/audio.flac"
        audio.rename(audio.with_name("original.flac"))
        audio.symlink_to(tmp_path / "settings.json")
        assert client.get(job["audio_url"]).status_code == 404
        log = Path(job["output_directory"]) / "job.log"
        log.unlink()
        log.symlink_to(tmp_path / "settings.json")
        assert client.get(f"/api/jobs/{job['id']}/log").status_code == 404
        assert client.get("/api/jobs/..%2Fsettings.json/audio").status_code == 404


def test_shutdown_is_bounded_and_never_closes_active_pipeline(tmp_path):
    class UninterruptibleService(FakeService):
        def generate(self, **request):
            self.active = 1
            self.entered.set()
            self.gate.wait(3)
            self.active = 0
            return FakeResult()
    gate = threading.Event()
    settings = Settings(outputs_directory=tmp_path / "outputs")
    service = UninterruptibleService(settings, gate=gate)
    manager = JobManager(settings, service)
    manager.start()
    first = manager.submit(GenerationRequest(style="x", lyrics="y"))
    assert service.entered.wait(2)
    second = manager.submit(GenerationRequest(style="x", lyrics="y"))
    started = time.monotonic()
    manager.shutdown(timeout=0.05)
    assert time.monotonic() - started < 0.5
    assert service.closes == 0
    assert manager.get(second.id).status == "cancelled"
    gate.set()
    manager.worker.join(3)
    assert not manager.worker.is_alive()
    assert service.closes == 1
    assert manager.get(first.id).status == "complete"  # Decode cancellation arrived too late.
    assert manager.get(first.id).cancel_requested is True


def test_sse_initial_event_and_updated_snapshot(tmp_path):
    app = configured_app(tmp_path)
    endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/api/jobs/events")
    class ConnectedRequest:
        async def is_disconnected(self):
            return False
    async def read_events():
        response = await endpoint(ConnectedRequest())
        iterator = response.body_iterator
        first = await anext(iterator)
        assert first.startswith("event: jobs\ndata: ")
        assert json.loads(first.split("data: ")[1])["jobs"] == []
        job = app.state.job_manager.submit(GenerationRequest(style="x", lyrics="y"))
        second = await anext(iterator)
        assert json.loads(second.split("data: ")[1])["jobs"][0]["id"] == job.id
        await iterator.aclose()
    asyncio.run(read_events())


def test_thread_scoped_logs_redact_credentials(monkeypatch, capsys):
    monkeypatch.setenv("HF_TOKEN", "hf_123456789secret")
    lines = []
    with capture_worker_stderr(lines.append):
        print("worker hf_123456789secret", file=sys.stderr)
        other = threading.Thread(target=lambda: print("other thread", file=sys.stderr))
        other.start()
        other.join()
    assert "worker [REDACTED]" in lines
    assert "other thread" not in "\n".join(lines)
    assert "hf_123456789secret" not in "\n".join(lines)


def test_public_observer_preserves_native_call_and_default_loader_arguments(tmp_path, monkeypatch):
    package = tmp_path / "src/yue2"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    stages = []
    native_result = object()
    class NativePipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()
        def plan(self, *args, **kwargs):
            return "plan"
        def generate_semantic(self, *args, **kwargs):
            return "semantic"
        def synthesize(self, *args, **kwargs):
            return "latents"
        def decode(self, *args, **kwargs):
            return "audio"
        def __call__(self, **kwargs):
            assert kwargs == {"style": "exact", "lyrics": "exact", "seed": 42}
            assert self.plan(request=SimpleNamespace(cot="full")) == "plan"
            assert self.generate_semantic("plan") == "semantic"
            assert self.synthesize("semantic") == "latents"
            assert self.decode("latents") == "audio"
            return native_result
    monkeypatch.setattr("backend.services.yue2_service._configured_source", None)
    monkeypatch.setitem(sys.modules, "yue2", SimpleNamespace(__file__=str(package / "__init__.py"), YuE2Pipeline=NativePipeline))
    service = YuE2Service(Settings(upstream_repository=tmp_path))
    assert service.generate(style="exact", lyrics="exact", seed=42, on_stage=stages.append) is native_result
    assert stages == ["planning", "semantic", "synthesizing", "decoding"]
    assert service._pipeline.stage_callback is None


@pytest.mark.parametrize("ending", ["\n", ""])
def test_stderr_sink_failure_does_not_escape_write_or_finalization(ending, capsys):
    attempts = []
    original = sys.stderr
    def unavailable_sink(message):
        attempts.append(message)
        raise OSError("Disk full")
    with capture_worker_stderr(unavailable_sink):
        sys.stderr.write("supplementary progress" + ending)
    assert sys.stderr is original
    assert attempts == ["supplementary progress"]


def test_stderr_finalization_failure_does_not_stop_next_job(tmp_path, monkeypatch):
    class ProgressService(FakeService):
        def generate(self, **request):
            result = super().generate(**request)
            sys.stderr.write("unterminated progress")
            return result
    app = configured_app(tmp_path, ProgressService)
    manager = app.state.job_manager
    original_log = manager._log
    failures = []
    def selective_log_failure(record, message):
        if message == "unterminated progress":
            failures.append(record.job.id)
            raise OSError("Log storage temporarily unavailable")
        return original_log(record, message)
    monkeypatch.setattr(manager, "_log", selective_log_failure)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        first = wait_for_job(client, submit(client)["id"])
        second = wait_for_job(client, submit(client)["id"])
        assert first["status"] == second["status"] == "complete"
        assert manager.worker.is_alive()
    assert failures == [first["id"], second["id"]]

