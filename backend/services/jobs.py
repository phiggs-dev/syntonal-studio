"""Single-worker generation queue; native artifacts are immutable children of job receipts."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
import traceback
from typing import Any, Callable
from uuid import uuid4

from backend.generation_models import GenerationJob, GenerationRequest, JobList, JobStage, JobProgress
from backend.settings import Settings
from backend.services.job_logging import capture_worker_stderr, redact_secrets
from backend.services.provenance import collect_provenance

LOGGER = logging.getLogger(__name__)
TERMINAL_STATUSES = {"complete", "failed", "cancelled"}
JOB_ID = re.compile(r"[0-9a-f]{32}")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def reject_symlinks(path: Path) -> None:
    """Check lexical ancestors too, before resolve can hide a symlink."""
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("Job storage must not contain symlinks")


def storage_root(settings: Settings) -> Path:
    root = settings.outputs_directory.absolute()
    reject_symlinks(root)
    root = root.resolve()
    if settings.upstream_repository is not None and root.is_relative_to(settings.upstream_repository.resolve()):
        raise ValueError("Output storage cannot be inside the read-only upstream repository")
    return root


def contained_file(directory: Path, relative: str) -> Path:
    target = directory / relative
    reject_symlinks(target)
    if not target.resolve().is_relative_to(directory.resolve()):
        raise ValueError("Artifact escapes its job directory")
    return target


def write_json(path: Path, payload: dict[str, Any]) -> None:
    reject_symlinks(path)
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass
class JobRecord:
    job: GenerationJob
    settings: Settings
    directory: Path
    cancelled: threading.Event = field(default_factory=threading.Event)
    last_token_update: float = 0
    service_override: Any = None
    plan_snapshot: dict[str, bytes] | None = None


class JobManager:
    def __init__(self, settings: Settings, service: Any):
        self.settings = settings.model_copy(deep=True)
        self.service = service
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.records: dict[str, JobRecord] = {}
        self.queue: deque[str] = deque()
        self.revision = 0
        self.stopping = False
        self.worker: threading.Thread | None = None

    def start(self) -> None:
        with self.lock:
            self._recover()
            self.worker = threading.Thread(target=self._run, name="yue2-generation", daemon=True)
            self.worker.start()

    def _recover(self) -> None:
        try:
            root = storage_root(self.settings)
            if not root.is_dir():
                return
            for directory in root.iterdir():
                if not JOB_ID.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                    continue
                try:
                    receipt = contained_file(directory, "job.json")
                    if receipt.stat().st_size > 2_000_000:
                        continue
                    job = GenerationJob.model_validate_json(receipt.read_text(encoding="utf-8"))
                    if job.id != directory.name or Path(job.output_directory) != directory:
                        continue
                    record = JobRecord(job, self.settings.model_copy(deep=True), directory)
                    self.records[job.id] = record
                    if job.status not in TERMINAL_STATUSES:
                        job.status = job.stage = "failed"
                        job.finished_at = timestamp()
                        job.error = "Studio stopped before this job finished. Interrupted generation cannot be resumed; submit a new job."
                        job.audio_url = None
                        self._log(record, job.error)
                        self._publish(record)
                    elif job.status == "complete":
                        audio = contained_file(directory, "artifacts/audio.flac")
                        job.audio_url = f"/api/jobs/{job.id}/audio" if audio.is_file() else None
                    else:
                        job.audio_url = None
                except (OSError, ValueError):
                    self.records.pop(directory.name, None)
                    LOGGER.warning("Ignored invalid generation receipt: %s", directory.name)
        except (OSError, ValueError):
            LOGGER.warning("Job recovery skipped: configured output root is unavailable or unsafe")

    def has_pending(self) -> bool:
        return any(record.job.status not in TERMINAL_STATUSES for record in self.records.values())

    def replace_service(self, settings: Settings, service: Any) -> None:
        # Caller holds this same lock while checking pending jobs and saving settings.
        self.service.close()
        self.service = service
        self.settings = settings.model_copy(deep=True)

    def submit(self, request: GenerationRequest, *, saved_settings: Settings | None = None, service_override: Any = None, on_reserved: Callable[[GenerationJob], None] | None = None, plan_snapshot: dict[str, bytes] | None = None) -> GenerationJob:
        with self.condition:
            if self.stopping:
                raise RuntimeError("Studio is shutting down")
            snapshot = (saved_settings or self.settings).model_copy(deep=True)
            root = storage_root(snapshot)
            root.mkdir(parents=True, exist_ok=True)
            identifier = uuid4().hex
            directory = root / identifier
            directory.mkdir(exist_ok=False)
            job = GenerationJob(id=identifier, title=request.title, created_at=timestamp(), request=request.model_copy(deep=True), output_directory=str(directory))
            record = JobRecord(job, snapshot, directory, service_override=service_override, plan_snapshot=plan_snapshot)
            if plan_snapshot is not None:
                source = directory / "source_plan"
                source.mkdir(exist_ok=False)
                for name, contents in plan_snapshot.items():
                    with contained_file(source, name).open("xb") as stream:
                        stream.write(contents)
            write_json(directory / "request.json", request.model_dump(mode="json"))
            write_json(directory / "settings.json", snapshot.model_dump(mode="json"))
            self._log(record, "Queued. Cancellation is cooperative and interrupted work is not resumable.")
            self._publish(record)
            self.records[identifier] = record
            if on_reserved is not None:
                try:
                    on_reserved(job)
                except Exception:
                    job.status = job.stage = "failed"
                    job.finished_at = timestamp()
                    job.error = "Library registration failed before inference. Check project storage permissions."
                    self._publish(record)
                    raise
            self.queue.append(identifier)
            self.condition.notify()
            return self.get(identifier)

    def snapshot(self) -> tuple[int, JobList]:
        with self.lock:
            jobs = sorted((self.get(identifier) for identifier in self.records), key=lambda job: job.created_at, reverse=True)
            return self.revision, JobList(jobs=jobs)

    def get(self, identifier: str) -> GenerationJob:
        with self.lock:
            job = self.records[identifier].job.model_copy(deep=True)
            waiting = [key for key in self.queue if self.records[key].job.status == "queued"]
            job.queue_position = waiting.index(identifier) + 1 if job.status == "queued" and identifier in waiting else None
            return job

    def cancel(self, identifier: str) -> GenerationJob:
        with self.condition:
            record = self.records[identifier]
            if record.job.status not in TERMINAL_STATUSES:
                record.cancelled.set()
                record.job.cancel_requested = True
                if record.job.status == "queued":
                    record.job.status = record.job.stage = "cancelled"
                    record.job.finished_at = timestamp()
                self._log(record, "Cancellation requested; active native stages stop at their next supported boundary.")
                self._publish(record)
            return self.get(identifier)

    def file(self, identifier: str, *, audio: bool) -> Path:
        with self.lock:
            record = self.records[identifier]
            if audio and (record.job.status != "complete" or record.job.audio_url is None):
                raise FileNotFoundError("No completed audio for this job")
            target = contained_file(record.directory, "artifacts/audio.flac" if audio else "job.log")
            if not target.is_file():
                raise FileNotFoundError("Artifact not found")
            return target

    def shutdown(self, timeout: float = 5) -> None:
        with self.condition:
            self.stopping = True
            for identifier in self.records:
                if self.records[identifier].job.status not in TERMINAL_STATUSES:
                    try:
                        self.cancel(identifier)
                    except OSError:
                        LOGGER.exception("Could not persist cancellation during shutdown")
            self.condition.notify_all()
        if self.worker is not None:
            self.worker.join(timeout)
        # The worker owns model cleanup: never close a model concurrently with inference.

    def _publish(self, record: JobRecord) -> None:
        write_json(contained_file(record.directory, "job.json"), record.job.model_dump(mode="json"))
        self.revision += 1

    def _log(self, record: JobRecord, message: str) -> None:
        with contained_file(record.directory, "job.log").open("a", encoding="utf-8") as stream:
            stream.write(f"{timestamp()} {redact_secrets(message)}\n")

    def _stage(self, record: JobRecord, stage: JobStage) -> None:
        with self.lock:
            record.job.stage = stage
            record.job.stage_started_at = timestamp()
            record.job.progress = None
            record.job.progress_revision += 1
            self._log(record, f"Stage: {stage}")
            self._publish(record)

    def _token(self, record: JobRecord, phase: str, token: int) -> None:
        with self.lock:
            record.job.token_count += 1
            label = "Planning score" if phase == "abc" else "Generating song"
            progress = record.job.progress
            count = progress.completed + 1 if progress and progress.label == label and progress.unit == "tokens" else 1
            record.job.progress = JobProgress(label=label, completed=count, unit="tokens")
            record.job.progress_revision += 1
            now = time.monotonic()
            if now - record.last_token_update >= 0.5:
                record.last_token_update = now
                self._publish(record)

    def _progress(self, record: JobRecord, progress: JobProgress) -> None:
        with self.lock:
            if record.job.status != "running":
                return
            previous = record.job.progress
            changed_activity = previous is None or previous.label != progress.label
            if previous and not changed_activity and progress.completed < previous.completed:
                return
            record.job.progress = progress.model_copy(deep=True)
            record.job.progress_revision += 1
            now = time.monotonic()
            if changed_activity or progress.finished or now - record.last_token_update >= 0.5:
                record.last_token_update = now
                try:
                    self._publish(record)
                except OSError:
                    LOGGER.warning("Could not persist supplementary progress", exc_info=True)

    def _run(self) -> None:
        try:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.stopping or bool(self.queue))
                    if self.stopping:
                        return
                    record = self.records[self.queue.popleft()]
                    if record.job.status != "queued":
                        continue
                    record.job.status = "running"
                    record.job.started_at = timestamp()
                with capture_worker_stderr(lambda message: self._log(record, message)):
                    self._execute(record)
        finally:
            try:
                self.service.close()
            except Exception:
                LOGGER.exception("Could not release YuE2 model on worker shutdown")

    def _execute(self, record: JobRecord) -> None:
        execution_service = record.service_override or self.service
        try:
            if record.service_override is not None:
                self.service.close()
            self._log(record, f"Model: {record.settings.model}; decoder: {record.settings.vae}; outputs: {record.directory}")
            self._stage(record, "loading")
            write_json(contained_file(record.directory, "runtime.json"), collect_provenance(record.settings))
            request = record.job.request
            callbacks = dict(cancelled=record.cancelled.is_set,
                             on_token=lambda phase, token: self._token(record, phase, token),
                             on_stage=lambda stage: self._stage(record, stage),
                             on_progress=lambda progress: self._progress(record, progress))
            if request.operation == "exact_plan":
                self._log(record, "Reusing exact saved planning tokens and historical planning timing/truncation; semantic generation and rendering use current configured models.")
                from backend.services.composition import inspect_plan
                source = contained_file(record.directory, "source_plan")
                inspect_plan(source)
                for name, content in (record.plan_snapshot or {}).items():
                    if contained_file(source, name).read_bytes() != content:
                        raise ValueError("Queued exact-plan snapshot changed")
                result = execution_service.generate_exact(source, **callbacks)
            else:
                method = execution_service.plan if request.operation == "plan" else execution_service.generate
                native = dict(style=request.style, lyrics=request.lyrics, cot=request.cot,
                              seed=int(request.seed), cfg_scale=request.cfg_scale, id=record.job.id)
                if request.abc is not None:
                    native["abc"] = request.abc
                result = method(**native, **callbacks)
            # A native result returned after decode is retained even if cancellation arrived late.
            self._stage(record, "saving")
            artifacts = contained_file(record.directory, "artifacts")
            artifacts.mkdir(exist_ok=False)
            metadata = result.save_artifacts(artifacts)
            audio = contained_file(record.directory, "artifacts/audio.flac")
            if request.operation != "plan" and not audio.is_file():
                raise RuntimeError("YuE2 did not save the expected audio.flac artifact")
            with self.lock:
                if request.operation == "plan":
                    record.job.truncated = bool(metadata["truncated"])
                else:
                    record.job.sample_rate = int(result.sample_rate)
                    record.job.channels = int(result.audio.shape[1]) if result.audio.ndim == 2 else 1
                    record.job.duration_seconds = float(metadata["audio_seconds"])
                    record.job.truncated = any(metadata["truncated"].values())
                    record.job.audio_url = f"/api/jobs/{record.job.id}/audio"
                record.job.status = record.job.stage = "complete"
                record.job.finished_at = timestamp()
                self._log(record, "Complete. Original native artifacts saved." + (" Output is truncated." if record.job.truncated else ""))
                self._publish(record)
        except Exception as exception:
            failed_stage = record.job.stage
            details = traceback.format_exc()
            cancelled = isinstance(exception, InterruptedError) and record.cancelled.is_set()
            suggestion = "See the job log for technical details; check model paths and runtime diagnostics."
            error_text = redact_secrets(str(exception))
            if "out of memory" in error_text.lower():
                suggestion = "GPU memory was exhausted. Close other GPU applications and check available VRAM; Studio has preserved the upstream settings."
            elif isinstance(exception, (ImportError, ModuleNotFoundError)):
                suggestion = "Install Studio's inference environment with scripts/setup-inference.sh, then restart Studio."
            elif isinstance(exception, FileNotFoundError) or "local_files_only" in error_text:
                suggestion = "Check model/cache paths and offline availability in Settings and System."
            try:
                execution_service.close()
            except Exception:
                LOGGER.exception("Could not release YuE2 after failed generation")
            with self.lock:
                record.job.status = record.job.stage = "cancelled" if cancelled else "failed"
                record.job.finished_at = timestamp()
                record.job.audio_url = None
                record.job.error = f"{failed_stage}: {type(exception).__name__}: {error_text}. {suggestion}"
                try:
                    self._log(record, details + "\n" + record.job.error)
                    self._publish(record)
                except (OSError, ValueError):
                    self.revision += 1
                    LOGGER.exception("Could not persist failed job receipt")





        finally:
            if record.service_override is not None:
                try:
                    execution_service.close()
                except Exception:
                    LOGGER.exception("Could not release saved-configuration pipeline")
