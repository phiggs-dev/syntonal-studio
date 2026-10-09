"""Loopback HTTP API; inference runs in a serialized background worker."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Callable
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.responses import Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.settings import Settings, SettingsStore
from backend.models import HealthResponse, SystemReport
from backend.services.diagnostics import collect_diagnostics
from backend.services.yue2_service import YuE2Service
from backend.services.jobs import JobManager
from backend.services.library import Library, LibraryError
from backend.composition_models import ScoreInput, PlanRenderInput, ABCInput, StripInput, CompareInput
from backend.services.composition import Composition
from backend.services.abc_service import ABCService
from backend.library_models import ProjectInput, ProjectPatch, HistoryPatch
from backend.generation_models import GenerationRequest, GenerationJob, JobList


def create_app(settings_path: Path | None = None, *, service_factory: Callable = YuE2Service, diagnostics: Callable = collect_diagnostics, frontend_directory: Path | None = None) -> FastAPI:
    store = SettingsStore(settings_path or Path(os.environ.get("SYNTONAL_STUDIO_SETTINGS", os.environ.get("YUE2_STUDIO_SETTINGS", "data/settings.json"))))
    settings = store.load()

    service = service_factory(settings)
    manager = JobManager(settings, service)
    lock = manager.lock
    library = Library(manager, service_factory)
    composition = Composition(library)

    def library_call(operation, *args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except LibraryError as exception:
            raise HTTPException(409, str(exception)) from exception
        except KeyError as exception:
            raise HTTPException(404, "Unknown project or generation") from exception
        except ValueError as exception:
            raise HTTPException(422, str(exception)) from exception
        except OSError as exception:
            raise HTTPException(409, "Library files are missing or unavailable; check storage permissions and original output folders") from exception

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        manager.start()
        try:
            yield
        finally:
            from starlette.concurrency import run_in_threadpool
            await run_in_threadpool(manager.shutdown)

    app = FastAPI(title="Syntonal Studio", lifespan=lifespan)
    app.state.job_manager = manager
    app.state.library = library
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])

    @app.middleware("http")
    async def protect_mutations(request: Request, call_next: Callable) -> Response:
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin:
                try:
                    parsed = urlsplit(origin)
                except ValueError:
                    return JSONResponse({"detail": "Invalid origin"}, status_code=403)
                if parsed.scheme not in {"http", "https"} or (parsed.netloc != request.headers.get("host") and origin not in {"http://127.0.0.1:5173", "http://localhost:5173"}):
                    return JSONResponse({"detail": "Cross-origin mutation refused"}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "Cross-site mutation refused"}, status_code=403)
        return await call_next(request)

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/api/settings", response_model=Settings)
    def get_settings() -> Settings:
        with lock:
            return settings.model_copy(deep=True)

    @app.put("/api/settings", response_model=Settings)
    def put_settings(updated: Settings) -> Settings:
        nonlocal settings, service
        if updated.model_fields_set != set(Settings.model_fields):
            raise HTTPException(422, "PUT requires the complete settings object; GET current settings first")
        with lock:
            try:
                replacement = service_factory(updated)
                if manager.has_pending():
                    raise HTTPException(409, "Wait for queued/running jobs to finish or cancel them before changing settings")
                library_call(library.validate_settings, updated)
                if updated.projects_directory == settings.projects_directory:
                    library_call(library.history)  # Register known outputs before switching output roots.
                else:
                    # A corrupt old catalog must not prevent explicitly selecting another library.
                    try:
                        library.history()
                    except (ValueError, OSError):
                        pass
                store.save(updated)
                manager.replace_service(updated, replacement)
            except OSError as exception:
                raise HTTPException(500, "Settings could not be persisted; check file permissions") from exception
            settings, service = updated, replacement
            return settings

    @app.get("/api/system", response_model=SystemReport)
    def system() -> SystemReport:
        with lock:
            snapshot = settings.model_copy(deep=True)
        return SystemReport.model_validate(diagnostics(snapshot))

    @app.post("/api/jobs", response_model=GenerationJob, status_code=202)
    def submit_job(request: GenerationRequest) -> GenerationJob:
        try:
            if request.operation == "exact_plan" or request.source_plan_id is not None or request.score_version_id is not None:
                raise ValueError("Use the dedicated Compose render endpoint for plan or score references")
            return library_call(library.submit, request)
        except ValueError as exception:
            raise HTTPException(422, str(exception)) from exception
        except OSError as exception:
            raise HTTPException(500, "Cannot reserve job output; check output directory permissions and free disk space") from exception
        except RuntimeError as exception:
            raise HTTPException(503, str(exception)) from exception

    @app.get("/api/jobs", response_model=JobList)
    def list_jobs() -> JobList:
        return manager.snapshot()[1]

    @app.get("/api/jobs/events")
    async def job_events(request: Request) -> StreamingResponse:
        async def events() -> AsyncIterator[str]:
            revision = -1
            ticks = 0
            while not await request.is_disconnected():
                current, jobs = manager.snapshot()
                if current != revision:
                    revision = current
                    yield f"event: jobs\ndata: {jobs.model_dump_json()}\n\n"
                    ticks = 0
                elif ticks >= 30:
                    yield ": keepalive\n\n"
                    ticks = 0
                if manager.stopping:
                    return
                ticks += 1
                await asyncio.sleep(0.5)
        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/jobs/{identifier}", response_model=GenerationJob)
    def get_job(identifier: str) -> GenerationJob:
        try:
            return manager.get(identifier)
        except KeyError as exception:
            raise HTTPException(404, "Unknown job") from exception

    @app.post("/api/jobs/{identifier}/cancel", response_model=GenerationJob)
    def cancel_job(identifier: str) -> GenerationJob:
        try:
            return manager.cancel(identifier)
        except KeyError as exception:
            raise HTTPException(404, "Unknown job") from exception

    def job_file(identifier: str, audio: bool) -> FileResponse:
        try:
            path = manager.file(identifier, audio=audio)
            return FileResponse(path, media_type="audio/flac" if audio else "text/plain", filename=None)
        except (KeyError, FileNotFoundError, ValueError) as exception:
            raise HTTPException(404, "Job artifact not found") from exception

    @app.get("/api/jobs/{identifier}/audio")
    def job_audio(identifier: str) -> FileResponse:
        return job_file(identifier, True)

    @app.get("/api/jobs/{identifier}/log")
    def job_log(identifier: str) -> FileResponse:
        return job_file(identifier, False)

    @app.get("/api/projects")
    def list_projects():
        return {"projects": library_call(library.projects)}

    @app.post("/api/projects", status_code=201)
    def create_project(request: ProjectInput):
        return library_call(library.create_project, request)

    @app.patch("/api/projects/{identifier}")
    def update_project(identifier: str, request: ProjectPatch):
        return library_call(library.update_project, identifier, request)

    @app.get("/api/projects/{identifier}/export")
    def export_project(identifier: str):
        return JSONResponse(library_call(library.export_project, identifier), headers={"Content-Disposition": f'attachment; filename="project-{identifier}.json"'})

    @app.get("/api/history")
    def list_history(q: str | None = None, project_id: str | None = None, cot: str | None = None, seed: str | None = None, model: str | None = None, decoder: str | None = None, favorite: bool | None = None, date_from: str | None = None, date_to: str | None = None):
        return library_call(library.history, q=q, project_id=project_id, cot=cot, seed=seed, model=model, decoder=decoder, favorite=favorite, date_from=date_from, date_to=date_to)

    @app.patch("/api/history/{identifier}")
    def update_history(identifier: str, request: HistoryPatch):
        return library_call(library.update_history, identifier, request)

    @app.get("/api/history/{identifier}/artifacts")
    def history_artifacts(identifier: str):
        return library_call(library.artifacts, identifier)

    @app.get("/api/history/{identifier}/files/{name:path}")
    def history_file(identifier: str, name: str):
        try:
            path = library.file(identifier, name)
        except (KeyError, OSError, ValueError) as exception:
            raise HTTPException(404, "Known safe artifact not found") from exception
        return FileResponse(path, media_type="audio/flac" if name == "artifacts/audio.flac" else None, filename=None if name == "artifacts/audio.flac" else path.name)

    @app.get("/api/history/{identifier}/reproduction")
    def reproduction(identifier: str):
        return JSONResponse(library_call(library.reproduction, identifier), headers={"Content-Disposition": f'attachment; filename="reproduction-{identifier}.json"'})

    @app.get("/api/history/{identifier}/reuse")
    def reuse(identifier: str):
        return library_call(library.reuse, identifier)

    @app.post("/api/history/{identifier}/rerun", status_code=202, response_model=GenerationJob)
    def rerun(identifier: str):
        return library_call(library.rerun, identifier)

    @app.get("/api/compose/plans")
    def list_plans():
        return library_call(composition.plans)

    @app.get("/api/compose/plans/{identifier}")
    def get_plan(identifier: str):
        return library_call(composition.plan, identifier)

    @app.post("/api/compose/plans", status_code=202, response_model=GenerationJob)
    def submit_plan(request: GenerationRequest):
        values = request.model_dump()
        values.update(operation="plan", source_plan_id=None, score_version_id=None)
        return library_call(library.submit, library_call(GenerationRequest.model_validate, values))

    @app.post("/api/compose/plans/{identifier}/render", status_code=202, response_model=GenerationJob)
    def render_plan(identifier: str, request: PlanRenderInput):
        return library_call(composition.render_plan, identifier, request)

    @app.get("/api/compose/scores")
    def list_scores():
        return library_call(composition.scores)

    @app.post("/api/compose/scores", status_code=201)
    def save_score(request: ScoreInput):
        return library_call(composition.save_score, request)

    @app.get("/api/compose/scores/{identifier}")
    def get_score(identifier: str):
        return library_call(composition.score, identifier)

    @app.get("/api/compose/scores/{identifier}/abc")
    def score_file(identifier: str):
        return FileResponse(library_call(composition.score_file, identifier), media_type="text/plain; charset=utf-8", filename=f"score-{identifier}.abc")

    @app.post("/api/compose/scores/{identifier}/render", status_code=202, response_model=GenerationJob)
    def render_score(identifier: str, request: GenerationRequest):
        return library_call(composition.render_score, identifier, request)

    @app.post("/api/compose/validate")
    def validate_abc(request: ABCInput):
        return library_call(ABCService(settings.upstream_repository).validate, request.abc)

    @app.post("/api/compose/compare")
    def compare_abc(request: CompareInput):
        return library_call(ABCService(settings.upstream_repository).compare, request.before, request.after, voices=request.voices, allow_tempo_change=request.allow_tempo_change)

    @app.post("/api/compose/strip-chords")
    def strip_chords(request: StripInput):
        return library_call(ABCService(settings.upstream_repository).strip_chords, request.abc, keep_voice=request.keep_voice)

    frontend = (frontend_directory or Path(__file__).resolve().parents[1] / "frontend/dist").resolve()

    @app.get("/{asset_path:path}")
    def frontend_asset(asset_path: str) -> FileResponse:
        if asset_path == "api" or asset_path.startswith("api/"):
            raise HTTPException(404, "Unknown API route")
        target = (frontend / asset_path).resolve()
        if not target.is_relative_to(frontend):
            raise HTTPException(404, "Not found")
        if target.is_file():
            return FileResponse(target)
        if Path(asset_path).suffix:
            raise HTTPException(404, "Not found")
        index = frontend / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404, "Frontend is not built; start Vite or build the frontend")

    return app


app = create_app()



