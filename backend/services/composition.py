"""Immutable score drafts and bounded exact-plan snapshots, separate from native inference."""
from __future__ import annotations
import hashlib
import io
import json
from pathlib import Path
from typing import Any
from uuid import uuid4
from backend.composition_models import ScoreInput, ScoreVersion, PlanRenderInput
from backend.generation_models import GenerationRequest
from backend.services.jobs import JOB_ID, contained_file, reject_symlinks, timestamp, write_json
from backend.services.library import Library, read_json

PLAN_FILES = {"plan.json", "abc_tokens.npy", "prefix.npy", "score.abc"}
PLAN_LIMIT = 8_000_000


def inspect_plan(directory: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    try:
        return _inspect_plan(directory)
    except ImportError as exception:
        raise ValueError("Install Studio's inference environment to verify saved plan token arrays") from exception
    except (EOFError, OverflowError, TypeError, KeyError, UnicodeError) as exception:
        raise ValueError("Malformed saved plan; inspect original artifacts") from exception


def _inspect_plan(directory: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Validate native hashes and arrays without importing YuE2 or loading a model."""
    import numpy as np
    snapshot: dict[str, bytes] = {}
    manifest_path = contained_file(directory, "plan_manifest.json")
    if manifest_path.stat().st_size > 16384:
        raise ValueError("Plan manifest is too large")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict) or not {"plan.json", "abc_tokens.npy", "prefix.npy", "score.abc"} <= manifest.keys() or set(manifest) - PLAN_FILES:
        raise ValueError("Incomplete or invalid saved plan manifest")
    snapshot["plan_manifest.json"] = manifest_bytes
    for name, expected in manifest.items():
        path = contained_file(directory, name)
        if path.stat().st_size > PLAN_LIMIT:
            raise ValueError("Plan artifact exceeds the supported size limit")
        contents = path.read_bytes()
        if hashlib.sha256(contents).hexdigest() != expected:
            raise ValueError("Saved plan changed; save edited ABC as a new score version")
        snapshot[name] = contents
    data = json.loads(snapshot["plan.json"])
    if not isinstance(data, dict) or not isinstance(data.get("abc"), str) or not data["abc"].strip() or len(data["abc"]) > 100_000:
        raise ValueError("Saved plan has no supported ABC text")
    if snapshot["score.abc"] != data["abc"].encode("utf-8"):
        raise ValueError("Saved ABC text mismatch")
    request = data.get("request")
    if not isinstance(request, dict) or set(request) != {"id", "style", "lyrics", "cot", "seed", "abc", "cfg_scale"}:
        raise ValueError("Unsupported native plan request fields")
    GenerationRequest(style=request["style"], lyrics=request["lyrics"], cot=request["cot"], seed=str(request["seed"]), abc=request["abc"], cfg_scale=request["cfg_scale"])
    if request["cot"] == "off" or not isinstance(request["id"], str):
        raise ValueError("Exact plan requires a full or melody request")
    for field, filename in (("abc_ids", "abc_tokens.npy"), ("prefix", "prefix.npy")):
        stream = io.BytesIO(snapshot[filename])
        version = np.lib.format.read_magic(stream)
        if version not in {(1, 0), (2, 0)}:
            raise ValueError("Unsupported saved plan array format")
        reader = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
        shape, _, dtype = reader(stream)
        if len(shape) != 1 or shape[0] < 0 or dtype.kind not in "iu" or shape[0] * dtype.itemsize != len(snapshot[filename]) - stream.tell():
            raise ValueError("Saved plan array size or type mismatch")
        array = np.load(io.BytesIO(snapshot[filename]), allow_pickle=False)
        if not isinstance(array, np.ndarray) or array.ndim != 1 or array.dtype.kind not in "iu" or array.tolist() != data.get(field):
            raise ValueError("Saved plan token array mismatch")
    return data, snapshot


class Composition:
    def __init__(self, library: Library):
        self.library = library
        self.lock = library.lock

    def _summary(self, identifier: str, catalog: dict[str, Any]):
        entry, directory, job = self.library._lookup(identifier, catalog)
        if job.status != "complete" or job.request.cot == "off":
            raise ValueError("Select a completed full or melody plan")
        summary = dict(id=identifier, title=entry.get("display_name", job.title), project_id=entry.get("project_id"),
                       created_at=job.created_at, cot=job.request.cot, seed=job.request.seed,
                       truncated=bool(read_json(contained_file(directory, "artifacts/plan.json")).get("truncated", False)), operation=job.request.operation)
        return summary, directory, job

    def plans(self):
        with self.lock:
            catalog, warnings = self.library._refresh()
            plans = []
            for identifier in catalog["generations"]:
                try:
                    summary, directory, job = self._summary(identifier, catalog)
                    score = contained_file(directory, "artifacts/score.abc")
                    if score.is_file() and score.stat().st_size <= 400_000:
                        plans.append(summary)
                except (OSError, ValueError):
                    continue
            return {"plans": sorted(plans, key=lambda item: item["created_at"], reverse=True), "warnings": warnings}

    def plan(self, identifier: str):
        with self.lock:
            catalog, warnings = self.library._refresh()
            summary, directory, job = self._summary(identifier, catalog)
            score = contained_file(directory, "artifacts/score.abc")
            if score.stat().st_size > 400_000:
                raise ValueError("ABC artifact exceeds supported size")
            abc = score.read_bytes().decode("utf-8")
            ready = True
            try:
                inspect_plan(contained_file(directory, "artifacts"))
            except (ValueError, OSError, KeyError, TypeError) as exception:
                ready = False
                warnings.append(f"Exact plan unavailable: {exception}")
            return {"plan": summary, "request": job.request, "abc": abc, "can_reuse_exact": ready, "warnings": warnings}

    def render_plan(self, identifier: str, options: PlanRenderInput):
        with self.lock:
            catalog, _ = self.library._refresh()
            summary, directory, job = self._summary(identifier, catalog)
            data, snapshot = inspect_plan(contained_file(directory, "artifacts"))
            native = data["request"]
            # The native request ID stays in the saved plan; the new UUID is only Studio storage identity.
            request = GenerationRequest(title=options.title or summary["title"], style=native["style"], lyrics=native["lyrics"],
                cot=native["cot"], seed=str(native["seed"]), cfg_scale=native["cfg_scale"], abc=native["abc"],
                operation="exact_plan", source_plan_id=identifier, parent_generation_id=identifier,
                project_id=options.project_id if "project_id" in options.model_fields_set else summary["project_id"])
            return self.library.submit(request, relation="exact_plan", plan_snapshot=snapshot)

    def _scores_root(self):
        root = self.library._root() / "scores"
        reject_symlinks(root)
        return root

    def score(self, identifier: str) -> ScoreVersion:
        with self.lock:
            if not JOB_ID.fullmatch(identifier):
                raise KeyError(identifier)
            directory = self._scores_root() / identifier
            metadata = contained_file(directory, "score.json")
            if not metadata.is_file():
                raise KeyError(identifier)
            score = ScoreVersion.model_validate(read_json(metadata))
            if score.id != identifier or hashlib.sha256(score.abc.encode("utf-8")).hexdigest() != score.sha256:
                raise ValueError("Score version is corrupt; original files were preserved")
            abc_path = contained_file(directory, "score.abc")
            if abc_path.stat().st_size > 400_000 or abc_path.read_bytes() != score.abc.encode("utf-8"):
                raise ValueError("Score text differs from its immutable version")
            return score

    def scores(self):
        with self.lock:
            root = self._scores_root()
            scores, warnings = [], []
            for directory in root.iterdir() if root.is_dir() else []:
                if JOB_ID.fullmatch(directory.name):
                    try:
                        scores.append(self.score(directory.name))
                    except (ValueError, OSError, KeyError) as exception:
                        warnings.append(f"Unavailable score {directory.name}: {exception}")
            return {"scores": sorted(scores, key=lambda score: score.created_at, reverse=True), "warnings": warnings}

    def save_score(self, request: ScoreInput):
        with self.lock:
            catalog, _ = self.library._refresh()
            if request.project_id is not None and request.project_id not in catalog["projects"]:
                raise ValueError("Unknown project")
            if request.source_generation_id is not None:
                self.library._lookup(request.source_generation_id, catalog)
            if request.parent_score_id is not None:
                self.score(request.parent_score_id)
            score = ScoreVersion(**request.model_dump(), id=uuid4().hex, created_at=timestamp(), sha256=hashlib.sha256(request.abc.encode("utf-8")).hexdigest())
            root = self._scores_root()
            root.mkdir(parents=True, exist_ok=True)
            directory = root / score.id
            directory.mkdir(exist_ok=False)
            with (directory / "score.abc").open("xb") as stream:
                stream.write(score.abc.encode("utf-8"))
            write_json(directory / "score.json", score.model_dump(mode="json"))
            return score

    def score_file(self, identifier: str):
        self.score(identifier)
        return contained_file(self._scores_root() / identifier, "score.abc")

    def render_score(self, identifier: str, request: GenerationRequest):
        from backend.services.abc_service import ABCService
        with self.lock:
            score = self.score(identifier)
            if request.cot == "off":
                raise ValueError("Score conditioning requires full or melody mode")
            if request.abc is not None and request.abc != score.abc:
                raise ValueError("Request ABC differs from the selected saved score")
            validation = ABCService(self.library.manager.settings.upstream_repository).validate(score.abc)
            if not validation["valid"]:
                raise ValueError("Saved score is outside the supported YuE2 ABC subset: " + "; ".join(validation["errors"]))
            values = request.model_dump()
            values.update(operation="song", abc=score.abc, score_version_id=identifier,
                          source_plan_id=None, parent_generation_id=score.source_generation_id)
            return self.library.submit(GenerationRequest.model_validate(values), relation="score_version")
