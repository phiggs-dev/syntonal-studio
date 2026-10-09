"""Progress observations preserve native results, queue order, and old receipts."""
from contextlib import contextmanager
import json
from types import SimpleNamespace
import sys

import pytest

from backend.generation_models import GenerationJob, GenerationRequest, JobProgress
from backend.services.generation_progress import ProgressObserver
from backend.services.jobs import JobManager
from backend.services.yue2_service import YuE2Service
from backend.settings import Settings


class Reporter:
    def __init__(self, label, total=None, unit=None):
        self.label, self.total, self.unit = label, total, unit
        self.completed = 0
        self.finished = False

    def update(self, completed, total=None):
        self.completed = completed
        if total is not None:
            self.total = total

    def advance(self, count=1):
        self.completed += count

    def finish(self, **kwargs):
        self.finished = True


def manager_at(tmp_path):
    return JobManager(Settings(outputs_directory=tmp_path / "outputs", upstream_repository=tmp_path / "upstream"), object())


def test_fifo_positions_exclude_cancelled_jobs_and_running_work(tmp_path):
    manager = manager_at(tmp_path)
    first, second, third = [manager.submit(GenerationRequest(style="piano", lyrics="line")) for _ in range(3)]
    assert [manager.get(job.id).queue_position for job in (first, second, third)] == [1, 2, 3]
    manager.queue.popleft()
    manager.records[first.id].job.status = "running"
    manager._stage(manager.records[first.id], "semantic")
    assert manager.get(first.id).queue_position is None
    assert manager.get(second.id).queue_position == 1
    manager.cancel(second.id)
    assert manager.get(second.id).queue_position is None
    assert manager.get(third.id).queue_position == 1
    listed = {job.id: job.queue_position for job in manager.snapshot()[1].jobs}
    assert listed[third.id] == 1


def test_progress_is_stage_specific_throttled_and_resets_for_decoder_loading(tmp_path, monkeypatch):
    manager = manager_at(tmp_path)
    job = manager.submit(GenerationRequest(style="piano", lyrics="line"))
    record = manager.records[job.id]
    record.job.status = "running"
    manager._stage(record, "planning")
    assert record.job.stage_started_at
    for token in range(3): manager._token(record, "abc", token)
    assert (record.job.token_count, record.job.progress.completed) == (3, 3)
    manager._stage(record, "semantic")
    assert record.job.progress is None
    manager._token(record, "semantic", 1)
    assert (record.job.token_count, record.job.progress.completed) == (4, 1)
    manager._stage(record, "synthesizing")
    monkeypatch.setattr("backend.services.jobs.time.monotonic", lambda: 100)
    manager._progress(record, JobProgress(label="Synthesizing audio", completed=1, total=96, unit="steps"))
    revision = manager.revision
    for count in range(2, 49):
        manager._progress(record, JobProgress(label="Synthesizing audio", completed=count, total=96, unit="steps"))
    assert manager.revision == revision  # Counts are observable without writing every callback to disk.
    assert manager.get(job.id).progress.completed == 48
    assert manager.get(job.id).progress_revision > 48
    manager._progress(record, JobProgress(label="Synthesizing audio", completed=96, total=96, unit="steps", finished=True))
    assert manager.revision == revision + 1
    assert manager.get(job.id).stage == "synthesizing"  # Work count cannot complete the native method/job.
    manager._stage(record, "decoding")
    manager._progress(record, JobProgress(label="Loading audio decoder"))
    assert manager.get(job.id).progress.total is None
    manager._progress(record, JobProgress(label="Decoding audio", completed=0, total=8, unit="chunks"))
    assert manager.get(job.id).progress.total == 8
    record.job.status = "complete"
    manager._progress(record, JobProgress(label="Decoding audio", completed=4, total=8, unit="chunks"))
    assert record.job.progress.completed == 0


def test_old_receipts_load_with_unknown_progress(tmp_path):
    manager = manager_at(tmp_path)
    job = manager.submit(GenerationRequest(style="piano", lyrics="line"))
    payload = job.model_dump(mode="json")
    for field in ("progress", "progress_revision", "queue_position", "stage_started_at"):
        payload.pop(field)
    restored = GenerationJob.model_validate(payload)
    assert restored.progress is None and restored.progress_revision == 0


def test_unknown_reporter_shape_and_telemetry_sink_failure_are_safe():
    assert not ProgressObserver.compatible(object())
    assert not ProgressObserver.compatible(SimpleNamespace(label="new", completed=0, total=None, unit=[]))
    reporter = Reporter("Synthesizing audio", total=32, unit="steps")
    def broken_sink(progress): raise OSError("unavailable telemetry sink")
    observed = ProgressObserver(reporter, broken_sink)
    observed.update(4)
    assert reporter.completed == 4
    observed.report(finished=True)


def test_observer_counts_tokens_only_through_public_callback():
    updates = []
    native = Reporter("Planning score", unit="tokens")
    observed = ProgressObserver(native, updates.append)
    observed.report()
    observed.advance()
    observed.advance()
    assert len(updates) == 1 and native.completed == 2
    observed.report(finished=True)
    assert updates[-1].completed == 2 and updates[-1].finished


@pytest.mark.parametrize("fail", [False, True])
def test_native_reporter_bridge_preserves_call_results_boundaries_and_cleanup(tmp_path, monkeypatch, fail):
    package = tmp_path / "src/yue2"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    updates, boundaries = [], []
    native_result = object()
    class NativePipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs): return cls()
        @contextmanager
        def _status(self, label, *, total=None, unit=None):
            reporter = Reporter(label, total, unit)
            yield reporter
            boundaries.append("native context finished")
        def synthesize(self, semantic):
            with self._status("Synthesizing audio", unit="steps") as reporter:
                reporter.update(1, total=2)
                reporter.update(2, total=2)
                assert not updates[-1].finished
                boundaries.append("native transfer finished")
                if fail: raise RuntimeError("native failure")
            return native_result
        def __call__(self, **request):
            assert request == {"style": "exact", "lyrics": "exact", "seed": 42}
            return self.synthesize("semantic")
    monkeypatch.setattr("backend.services.yue2_service._configured_source", None)
    monkeypatch.setitem(sys.modules, "yue2", SimpleNamespace(__file__=str(package / "__init__.py"), YuE2Pipeline=NativePipeline))
    service = YuE2Service(Settings(upstream_repository=tmp_path))
    if fail:
        with pytest.raises(RuntimeError, match="native failure"):
            service.generate(style="exact", lyrics="exact", seed=42, on_progress=updates.append)
        assert not any(update.finished for update in updates)
    else:
        assert service.generate(style="exact", lyrics="exact", seed=42, on_progress=updates.append) is native_result
        assert updates[-1].finished and updates[-1].completed == 2
        assert boundaries == ["native transfer finished", "native context finished"]
    assert service._pipeline.progress_callback is None


def test_http_and_sse_expose_worker_progress_before_native_result_returns(tmp_path):
    import asyncio
    import threading
    import time
    from fastapi.testclient import TestClient
    from backend.main import create_app
    from backend.settings import SettingsStore

    entered, release = threading.Event(), threading.Event()
    class Result:
        sample_rate = 48000
        audio = SimpleNamespace(shape=(48000, 2), ndim=2)
        def save_artifacts(self, directory):
            (directory / "audio.flac").write_bytes(b"fLaC0123456789")
            return {"audio_seconds": 1.0, "truncated": {"abc": False, "semantic": False}}
    class Service:
        def generate(self, **request):
            request["on_stage"]("synthesizing")
            request["on_progress"](JobProgress(label="Synthesizing audio", completed=48, total=96, unit="steps"))
            entered.set()
            assert release.wait(3)
            request["on_progress"](JobProgress(label="Synthesizing audio", completed=96, total=96, unit="steps", finished=True))
            return Result()
        def close(self): pass
    store = SettingsStore(tmp_path / "settings.json")
    store.save(Settings(outputs_directory=tmp_path / "outputs", projects_directory=tmp_path / "projects"))
    app = create_app(store.path, service_factory=lambda settings: Service())
    with TestClient(app, base_url="http://127.0.0.1") as client:
        try:
            response = client.post("/api/jobs", json={"style": "piano", "lyrics": "line"})
            assert response.status_code == 202
            identifier = response.json()["id"]
            assert entered.wait(2)
            job = client.get(f"/api/jobs/{identifier}").json()
            assert job["status"] == "running" and job["stage"] == "synthesizing"
            assert job["progress"]["completed"] == 48 and job["progress"]["total"] == 96
            assert job["progress_revision"] > 0 and job["stage_started_at"]
            endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/api/jobs/events")
            class Connected:
                async def is_disconnected(self): return False
            async def snapshot():
                stream = (await endpoint(Connected())).body_iterator
                event = await anext(stream)
                await stream.aclose()
                return json.loads(event.split("data: ")[1])["jobs"][0]
            assert asyncio.run(snapshot())["progress"]["completed"] == 48
        finally:
            release.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            finished = client.get(f"/api/jobs/{identifier}").json()
            if finished["status"] == "complete": break
            time.sleep(.01)
        assert finished["status"] == "complete" and finished["audio_url"]
        assert finished["progress"] is None  # Saving is a different stage with no known total.
