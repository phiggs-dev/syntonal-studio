"""Versioned library catalog; generation directories and native artifacts remain immutable."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Callable
from uuid import uuid4
from backend.generation_models import GenerationJob, GenerationRequest
from backend.library_models import Artifact, HistoryEntry, HistoryPatch, Project, ProjectInput, ProjectPatch
from backend.services.jobs import JOB_ID, TERMINAL_STATUSES, JobManager, contained_file, reject_symlinks, storage_root, timestamp, write_json
from backend.services.provenance import upstream_identity
from backend.settings import Settings

NATIVE_NAMES = ("audio.flac", "score.abc", "plan.json", "plan_manifest.json", "abc_tokens.npy", "prefix.npy", "semantic.npy", "latent.npy", "request.json", "config.json", "result.json", "plan_result.json")
ARTIFACT_NAMES = tuple("artifacts/" + name for name in NATIVE_NAMES) + ("request.json", "settings.json", "runtime.json", "job.log", "job.json", "lineage.json")
JSON_LIMIT = 4_000_000

class LibraryError(ValueError):
    """An unsafe or damaged library requires attention, never replacement."""


def read_json(path: Path) -> dict[str, Any]:
    reject_symlinks(path)
    if path.stat().st_size > JSON_LIMIT:
        raise ValueError(f"JSON document is too large: {path.name}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path.name}")
    return value


def digest_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Library:
    def __init__(self, manager: JobManager, service_factory: Callable):
        self.manager = manager
        self.service_factory = service_factory
        self.lock = manager.lock

    def _root(self, settings: Settings | None = None) -> Path:
        settings = settings or self.manager.settings
        root = settings.projects_directory.absolute()
        reject_symlinks(root)
        if settings.upstream_repository and root.resolve().is_relative_to(settings.upstream_repository.resolve()):
            raise LibraryError("Projects directory cannot be inside the read-only upstream repository")
        return root.resolve()

    def validate_settings(self, settings: Settings) -> None:
        self._load(settings)

    def _load(self, settings: Settings | None = None) -> dict[str, Any]:
        path = self._root(settings) / "catalog.json"
        reject_symlinks(path)
        if not path.exists():
            return {"schema_version": 1, "projects": {}, "generations": {}}
        try:
            catalog = read_json(path)
            if set(catalog) != {"schema_version", "projects", "generations"} or catalog["schema_version"] != 1:
                raise ValueError("Unrecognized catalog schema")
            if not isinstance(catalog["projects"], dict) or not isinstance(catalog["generations"], dict):
                raise ValueError("Invalid catalog collections")
            for identifier, value in catalog["projects"].items():
                if not JOB_ID.fullmatch(identifier) or Project.model_validate(value).id != identifier:
                    raise ValueError("Invalid project ID")
            for identifier, value in catalog["generations"].items():
                if not JOB_ID.fullmatch(identifier) or not isinstance(value, dict) or not isinstance(value.get("directory"), str):
                    raise ValueError("Invalid generation reference")
                HistoryPatch.model_validate({key: value[key] for key in ("project_id", "display_name", "favorite", "notes") if key in value})
                if value.get("project_id") is not None and value["project_id"] not in catalog["projects"]:
                    raise ValueError("Unknown project reference")
            return catalog
        except (OSError, ValueError, TypeError) as exception:
            raise LibraryError("Library catalog is damaged or unavailable; restore catalog.json or choose another projects directory. Original files were preserved.") from exception

    def _save(self, catalog: dict[str, Any]) -> None:
        root = self._root()
        root.mkdir(parents=True, exist_ok=True)
        write_json(root / "catalog.json", catalog)

    def _receipt(self, identifier: str, directory: Path) -> GenerationJob:
        if not JOB_ID.fullmatch(identifier) or directory.name != identifier or not directory.is_absolute():
            raise ValueError("Invalid generation directory")
        reject_symlinks(directory)
        upstream = self.manager.settings.upstream_repository
        if upstream and directory.resolve().is_relative_to(upstream.resolve()):
            raise ValueError("Generation reference points inside upstream")
        job = GenerationJob.model_validate(read_json(contained_file(directory, "job.json")))
        if job.id != identifier or Path(job.output_directory) != directory:
            raise ValueError("Generation receipt does not match catalog reference")
        return job

    def _refresh(self) -> tuple[dict[str, Any], list[str]]:
        catalog = self._load()
        warnings: list[str] = []
        changed = False
        try:
            root = storage_root(self.manager.settings)
            directories = list(root.iterdir()) if root.is_dir() else []
        except (OSError, ValueError) as exception:
            directories = []
            warnings.append(f"Output discovery unavailable: {exception}")
        for directory in directories:
            if not JOB_ID.fullmatch(directory.name):
                continue
            try:
                job = self._receipt(directory.name, directory)
                if job.id not in catalog["generations"]:
                    catalog["generations"][job.id] = {"directory": str(directory), "project_id": None, "display_name": job.title, "favorite": False, "notes": ""}
                    changed = True
                elif catalog["generations"][job.id]["directory"] != str(directory):
                    warnings.append(f"Duplicate generation ID {job.id}; original catalog reference retained.")
            except (OSError, ValueError) as exception:
                warnings.append(f"Skipped invalid generation {directory.name}: {exception}")
        if changed:
            self._save(catalog)
        return catalog, warnings

    def _lookup(self, identifier: str, catalog: dict[str, Any]) -> tuple[dict[str, Any], Path, GenerationJob]:
        if not JOB_ID.fullmatch(identifier) or identifier not in catalog["generations"]:
            raise KeyError(identifier)
        entry = catalog["generations"][identifier]
        directory = Path(entry["directory"])
        return entry, directory, self._receipt(identifier, directory)

    def _optional(self, directory: Path, name: str, warnings: list[str]) -> dict[str, Any] | None:
        try:
            return read_json(contained_file(directory, name))
        except (OSError, ValueError) as exception:
            warnings.append(f"Missing or invalid {name}: {type(exception).__name__}")
            return None

    def _entry(self, identifier: str, catalog: dict[str, Any], warnings: list[str]) -> HistoryEntry:
        metadata, directory, job = self._lookup(identifier, catalog)
        if job.status not in TERMINAL_STATUSES and identifier not in self.manager.records:
            job.status = job.stage = "failed"
            job.error = "Studio is no longer running this saved job. Interrupted work cannot be resumed; create a new generation."
            job.audio_url = None
            warnings.append(f"Interrupted historical generation {identifier}; original receipt preserved.")
        saved = self._optional(directory, "settings.json", warnings) or {}
        lineage = {}
        if (directory / "lineage.json").exists():
            lineage = self._optional(directory, "lineage.json", warnings) or {}
        if job.status == "complete":
            try:
                audio = contained_file(directory, "artifacts/audio.flac")
                job.audio_url = f"/api/history/{identifier}/files/artifacts/audio.flac" if audio.is_file() else None
            except ValueError:
                job.audio_url = None
                warnings.append(f"Unsafe audio artifact for {identifier}")
        seconds = None
        result_path = contained_file(directory, "artifacts/result.json")
        if result_path.is_file():
            result = self._optional(directory, "artifacts/result.json", warnings) or {}
            timing = result.get("timing")
            native_seconds = timing.get("e2e_seconds") if isinstance(timing, dict) else None
            if isinstance(native_seconds, (int, float)) and native_seconds >= 0:
                seconds = float(native_seconds)
        return HistoryEntry(job=job, project_id=metadata.get("project_id"), display_name=metadata.get("display_name", job.title), favorite=metadata.get("favorite", False), notes=metadata.get("notes", ""), model=saved.get("model"), decoder=saved.get("vae"), model_revision=saved.get("model_revision"), decoder_revision=saved.get("vae_revision"), parent_generation_id=lineage.get("parent_generation_id", job.request.parent_generation_id), relation=lineage.get("relation"), generation_seconds=seconds)

    def projects(self) -> list[Project]:
        with self.lock:
            catalog = self._load()
            return sorted((Project.model_validate(value) for value in catalog["projects"].values()), key=lambda project: project.updated_at, reverse=True)

    def create_project(self, request: ProjectInput) -> Project:
        with self.lock:
            catalog = self._load()
            now = timestamp()
            project = Project(**request.model_dump(), id=uuid4().hex, created_at=now, updated_at=now)
            catalog["projects"][project.id] = project.model_dump()
            self._save(catalog)
            return project

    def update_project(self, identifier: str, patch: ProjectPatch) -> Project:
        with self.lock:
            catalog = self._load()
            original = catalog["projects"][identifier]
            project = Project.model_validate({**original, **patch.model_dump(exclude_unset=True), "updated_at": timestamp()})
            catalog["projects"][identifier] = project.model_dump()
            self._save(catalog)
            return project

    def history(self, **filters: Any) -> dict[str, Any]:
        with self.lock:
            catalog, warnings = self._refresh()
            entries = []
            for identifier in catalog["generations"]:
                try:
                    entry = self._entry(identifier, catalog, warnings)
                except (OSError, ValueError) as exception:
                    warnings.append(f"Unavailable generation {identifier}: {exception}")
                    continue
                request = entry.job.request
                exact = {"project_id": entry.project_id or "unassigned", "cot": request.cot, "seed": request.seed, "model": entry.model, "decoder": entry.decoder, "favorite": entry.favorite}
                if any(filters.get(key) is not None and filters[key] != value for key, value in exact.items()):
                    continue
                if filters.get("q") and filters["q"].casefold() not in "\n".join((entry.display_name, entry.notes, request.style, request.lyrics, entry.job.id)).casefold():
                    continue
                if filters.get("date_from") and entry.job.created_at[:10] < filters["date_from"]:
                    continue
                if filters.get("date_to") and entry.job.created_at[:10] > filters["date_to"]:
                    continue
                entries.append(entry)
            entries.sort(key=lambda entry: entry.job.created_at, reverse=True)
            return {"generations": entries, "warnings": warnings}

    def update_history(self, identifier: str, patch: HistoryPatch) -> HistoryEntry:
        with self.lock:
            catalog, warnings = self._refresh()
            metadata, _, _ = self._lookup(identifier, catalog)
            changes = patch.model_dump(exclude_unset=True)
            if any(value is None for key, value in changes.items() if key != "project_id"):
                raise ValueError("Only project_id may be null")
            if changes.get("project_id") is not None and changes["project_id"] not in catalog["projects"]:
                raise ValueError("Unknown project")
            metadata.update(changes)
            self._save(catalog)
            return self._entry(identifier, catalog, warnings)

    def export_project(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            catalog, warnings = self._refresh()
            return {"schema_version": 1, "project": catalog["projects"][identifier], "generations": {key: value for key, value in catalog["generations"].items() if value.get("project_id") == identifier}, "warnings": warnings, "note": "References only; native artifact files have not been copied or modified."}

    def submit(self, request: GenerationRequest, *, relation: str = "derived", saved_settings: Settings | None = None, service_override: Any = None, plan_snapshot: dict[str, bytes] | None = None) -> GenerationJob:
        with self.lock:
            catalog, _ = self._refresh()
            if request.project_id is not None and request.project_id not in catalog["projects"]:
                raise ValueError("Unknown project; select an existing project or unassigned")
            if request.parent_generation_id is not None:
                self._lookup(request.parent_generation_id, catalog)
            def register(job: GenerationJob) -> None:
                directory = Path(job.output_directory)
                if request.parent_generation_id or request.source_plan_id or request.score_version_id:
                    write_json(directory / "lineage.json", {"schema_version": 1, "parent_generation_id": request.parent_generation_id, "relation": relation, "source_plan_id": request.source_plan_id, "score_version_id": request.score_version_id, "operation": request.operation})
                catalog["generations"][job.id] = {"directory": str(directory), "project_id": request.project_id, "display_name": request.title, "favorite": False, "notes": ""}
                self._save(catalog)
            return self.manager.submit(request, saved_settings=saved_settings, service_override=service_override, on_reserved=register, plan_snapshot=plan_snapshot)

    def file(self, identifier: str, name: str) -> Path:
        with self.lock:
            if name not in ARTIFACT_NAMES:
                raise KeyError(name)
            catalog, _ = self._refresh()
            _, directory, _ = self._lookup(identifier, catalog)
            path = contained_file(directory, name)
            if not path.is_file():
                raise FileNotFoundError(name)
            return path

    def artifacts(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            catalog, warnings = self._refresh()
            _, directory, job = self._lookup(identifier, catalog)
            result_name = "plan_result.json" if job.request.operation == "plan" else "result.json"
            result = self._optional(directory, f"artifacts/{result_name}", warnings) or {}
            expected = result.get("artifacts", {})
            if not isinstance(expected, dict):
                expected = {}
                warnings.append("Invalid native artifact manifest")
            artifacts = []
            for name in ARTIFACT_NAMES:
                if job.request.operation == "plan" and name in {"artifacts/audio.flac", "artifacts/semantic.npy", "artifacts/latent.npy", "artifacts/result.json"}:
                    continue
                if job.request.operation != "plan" and name == "artifacts/plan_result.json":
                    continue
                item = Artifact(name=name)
                try:
                    path = contained_file(directory, name)
                    if not path.is_file():
                        item.integrity = "missing"
                    else:
                        item.bytes = path.stat().st_size
                        item.sha256 = digest_file(path)
                        native = expected.get(name.removeprefix("artifacts/")) if name.startswith("artifacts/") else None
                        if isinstance(native, dict):
                            item.integrity = "verified" if native.get("bytes") == item.bytes and native.get("sha256") == item.sha256 else "mismatch"
                        if path.suffix in {".json", ".abc", ".log"}:
                            with path.open("rb") as stream:
                                item.text_preview = stream.read(16384).decode("utf-8", errors="replace")
                        item.download_url = f"/api/history/{identifier}/files/{name}"
                except (OSError, ValueError) as exception:
                    item.integrity = "missing"
                    warnings.append(f"Cannot inspect {name}: {exception}")
                if item.integrity == "mismatch":
                    warnings.append(f"Artifact hash or size mismatch: {name}")
                artifacts.append(item)
            return {"artifacts": artifacts, "warnings": warnings}

    def reproduction(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            catalog, warnings = self._refresh()
            entry = self._entry(identifier, catalog, warnings)
            _, directory, _ = self._lookup(identifier, catalog)
            request = self._optional(directory, "request.json", warnings)
            settings = self._optional(directory, "settings.json", warnings)
            runtime = self._optional(directory, "runtime.json", warnings)
            config = self._optional(directory, "artifacts/config.json", warnings)
            result = self._optional(directory, "artifacts/plan_result.json" if entry.job.request.operation == "plan" else "artifacts/result.json", warnings)
            upstream = (runtime or {}).get("upstream")
            if not isinstance(upstream, dict) or not upstream.get("commit"):
                warnings.append("Original upstream commit is unknown; it cannot be reconstructed from current settings.")
            return {"schema_version": 1, "generation": entry.model_dump(mode="json"), "request": request, "settings": settings, "runtime": runtime, "effective_config": config, "weights": (result or {}).get("weights"), "timing": (result or {}).get("timing"), "hashes": (result or {}).get("artifacts"), "lineage": {"parent_generation_id": entry.parent_generation_id, "relation": entry.relation, "source_plan_id": entry.job.request.source_plan_id, "score_version_id": entry.job.request.score_version_id, "operation": entry.job.request.operation}, "warnings": warnings, "note": "Recorded inputs and identities do not guarantee bit-identical audio across runtime or hardware changes."}

    def reuse(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            catalog, warnings = self._refresh()
            entry = self._entry(identifier, catalog, warnings)
            _, directory, job = self._lookup(identifier, catalog)
            request = GenerationRequest.model_validate(read_json(contained_file(directory, "request.json")))
            if request.operation == "exact_plan":
                raise ValueError("Exact-plan jobs must be reused through Compose so original tokens and native request identity are preserved")
            native_path = contained_file(directory, "artifacts/request.json")
            if native_path.exists():
                native = read_json(native_path)
                if native.get("abc") != request.abc:
                    raise ValueError("Native ABC input differs from saved Studio inputs; inspect original artifacts before reuse")
                allowed = {"id", "style", "lyrics", "cot", "seed", "abc", "cfg_scale"}
                if set(native) - allowed:
                    raise ValueError("Unsupported imported native request; refusing to discard inputs")
                expected_request = {"id": identifier, "style": request.style, "lyrics": request.lyrics, "cot": request.cot, "seed": int(request.seed), "abc": request.abc, "cfg_scale": request.cfg_scale}
                if native != expected_request:
                    raise ValueError("Native request differs from saved Studio inputs; inspect original artifacts before reuse")
                result_path = contained_file(directory, "artifacts/result.json")
                if result_path.is_file():
                    expected_hash = read_json(result_path).get("artifacts", {}).get("request.json")
                    if expected_hash and (expected_hash.get("sha256") != digest_file(native_path) or expected_hash.get("bytes") != native_path.stat().st_size):
                        raise ValueError("Native request integrity mismatch; refusing to reuse modified inputs")
            if request != job.request:
                raise ValueError("Saved request differs from the generation receipt; inspect original files before reuse")
            request.project_id = entry.project_id
            request.parent_generation_id = identifier
            warnings.append("Loading inputs uses current settings when submitted; use saved-configuration rerun to preserve the recorded environment.")
            return {"request": request, "parent_generation_id": identifier, "project_id": entry.project_id, "warnings": warnings}

    def rerun(self, identifier: str) -> GenerationJob:
        with self.lock:
            manifest = self.reproduction(identifier)
            if manifest["generation"]["job"]["status"] not in TERMINAL_STATUSES:
                raise LibraryError("Wait for the original generation to finish before rerunning it")
            saved = manifest["runtime"] or {}
            identity = saved.get("upstream")
            if not isinstance(identity, dict):
                identity = {}
            settings = Settings.model_validate(manifest["settings"] or {})
            current = upstream_identity(settings.upstream_repository)
            if not identity.get("commit") or identity.get("dirty") is not False or current.get("dirty") is not False or current.get("commit") != identity["commit"]:
                raise LibraryError("Saved upstream commit is missing, modified, or different. Use Reuse inputs for an intentional current-environment generation.")
            inspection = self.artifacts(identifier)
            if any(item.integrity == "mismatch" for item in inspection["artifacts"]):
                raise LibraryError("Saved artifacts have changed; inspect integrity warnings before rerunning.")
            config, weights = manifest["effective_config"], manifest["weights"]
            if not isinstance(config, dict) or not config or not isinstance(weights, dict) or not weights:
                raise LibraryError("Effective configuration or weight identity is missing. Use Reuse inputs instead.")
            # Immutable Hub snapshots also pin tokenizer and pipeline.json, which weight-only hashes omit.
            import os
            cache = settings.huggingface_cache or Path(os.environ.get("HF_HUB_CACHE", os.environ.get("HUGGINGFACE_HUB_CACHE", str(Path(os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))) / "hub"))))
            for model, revision, role in ((settings.model, settings.model_revision, "mot"), (settings.vae, settings.vae_revision, "vae")):
                if Path(model).exists() or not revision or not re.fullmatch(r"[0-9a-f]{40}", revision):
                    raise LibraryError("Saved rerun requires immutable model and decoder snapshot revisions. Use Reuse inputs instead.")
                snapshot = cache / ("models--" + model.replace("/", "--")) / "snapshots" / revision
                if not snapshot.is_dir() or not (snapshot / "config.json").is_file() or not any(snapshot.glob("*.safetensors")) or (role == "mot" and not (snapshot / "qwen.tiktoken").is_file()):
                    raise LibraryError("Saved model or decoder snapshot is unavailable in its original cache. Restore it or use Reuse inputs.")
            reused = self.reuse(identifier)
            request = reused["request"]
            # New files follow today's output root; all inference settings remain the saved values.
            settings.outputs_directory = self.manager.settings.outputs_directory
            settings.projects_directory = self.manager.settings.projects_directory
            service = self.service_factory(settings)
            service.expected_reproduction = {"config": config, "weights": weights}
            return self.submit(request, relation="rerun", saved_settings=settings, service_override=service)
