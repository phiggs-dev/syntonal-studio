"""Serial public YuE2 adapter; no model imports or downloads until explicit load."""
from __future__ import annotations

import importlib
import sys
import threading
from pathlib import Path
from typing import Any, Callable

from backend.settings import Settings

_import_lock = threading.Lock()
_configured_source: Path | None = None
# Prevent bytecode writes to the read-only upstream during all lazy imports.
sys.dont_write_bytecode = True


def pipeline_loader(repository: Path | None) -> Callable[..., Any]:
    global _configured_source
    with _import_lock:
        source = (repository.expanduser() / "src").resolve() if repository is not None else None
        if source is None and _configured_source is not None:
            raise RuntimeError('Restart Studio to switch from a configured checkout to the installed package')
        if source is not None:
            if not (source / "yue2" / "__init__.py").is_file():
                raise RuntimeError(f"Configured repository has no src/yue2 package: {repository}")
            for name, module in tuple(sys.modules.items()):
                if name == "yue2" or name.startswith("yue2."):
                    filename = getattr(module, "__file__", None)
                    if filename and not Path(filename).resolve().is_relative_to(source):
                        raise RuntimeError("A different YuE2 checkout is already imported; restart Studio after changing its repository")
            sys.path.insert(0, str(source))
        try:
            module = importlib.import_module("yue2")
            if source is not None and not Path(module.__file__).resolve().is_relative_to(source):
                raise RuntimeError("Imported YuE2 does not match the configured checkout")
            if source is not None:
                _configured_source = source
            class ObservedPipeline(module.YuE2Pipeline):
                """Observe public stage entry without altering upstream inference or results."""

                stage_callback: Callable[[str], None] | None = None
                exact_plan: Any = None

                def report_stage(self, stage: str) -> None:
                    if self.stage_callback is not None:
                        self.stage_callback(stage)

                def plan(self, *args: Any, **kwargs: Any) -> Any:
                    request = kwargs.get("request")
                    if request is None or request.cot != "off":
                        self.report_stage("planning")
                    if self.exact_plan is not None:
                        if request is None or request.to_dict() != self.exact_plan.request.to_dict():
                            raise ValueError("Exact plan request differs from the native render request")
                        saved_plan = self.exact_plan
                        self.exact_plan = None
                        return saved_plan
                    return super().plan(*args, **kwargs)

                def generate_semantic(self, *args: Any, **kwargs: Any) -> Any:
                    self.report_stage("semantic")
                    return super().generate_semantic(*args, **kwargs)

                def synthesize(self, *args: Any, **kwargs: Any) -> Any:
                    self.report_stage("synthesizing")
                    return super().synthesize(*args, **kwargs)

                def decode(self, *args: Any, **kwargs: Any) -> Any:
                    self.report_stage("decoding")
                    return super().decode(*args, **kwargs)

            return ObservedPipeline.from_pretrained
        finally:
            if source is not None:
                sys.path.remove(str(source))


class YuE2Service:
    def __init__(self, settings: Settings, loader_factory: Callable = pipeline_loader):
        self.settings = settings.model_copy(deep=True)
        self._loader_factory = loader_factory
        self._pipeline: Any = None
        self.expected_reproduction: dict[str, Any] | None = None
        self._lock = threading.RLock()

    def load(self) -> Any:
        with self._lock:
            if self._pipeline is None:
                if self.settings.upstream_repository is not None:
                    import os
                    upstream = self.settings.upstream_repository.resolve()
                    cache = self.settings.huggingface_cache
                    if cache is None:
                        cache = Path(os.environ.get("HF_HUB_CACHE", os.environ.get("HUGGINGFACE_HUB_CACHE", str(Path(os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))) / "hub"))))
                    if cache.resolve().is_relative_to(upstream):
                        raise ValueError("Hugging Face cache cannot be inside the read-only upstream repository")
                loader = self._loader_factory(self.settings.upstream_repository)
                self._pipeline = loader(
                    self.settings.model, vae=self.settings.vae,
                    revision=self.settings.model_revision, vae_revision=self.settings.vae_revision,
                    cache_dir=str(self.settings.huggingface_cache) if self.settings.huggingface_cache else None,
                    local_files_only=self.settings.offline,
                )
            return self._pipeline

    def generate(self, *, on_stage: Callable[[str], None] | None = None, **request: Any) -> Any:
        with self._lock:
            pipeline = self.load()
            if self.expected_reproduction is not None:
                protocol = importlib.import_module("yue2.protocol")
                native_request = protocol.SongRequest(**{key: value for key, value in request.items() if key in {"id", "style", "lyrics", "cot", "seed", "abc", "cfg_scale"}})
                actual_config = pipeline.effective_config(native_request, None, None)
                if actual_config != self.expected_reproduction["config"] or pipeline.weights != self.expected_reproduction["weights"]:
                    raise ValueError("Saved configuration or weights differ from the loaded pipeline. Use Reuse inputs for an intentional current-environment generation.")
            if on_stage is not None:
                pipeline.stage_callback = on_stage
            try:
                return pipeline(**request)
            finally:
                if on_stage is not None:
                    pipeline.stage_callback = None

    def plan(self, *, on_stage: Callable[[str], None] | None = None, **request: Any) -> Any:
        """Call only the public planner, preserving its exact native output."""
        with self._lock:
            pipeline = self.load()
            if self.expected_reproduction is not None:
                protocol = importlib.import_module("yue2.protocol")
                native_request = protocol.SongRequest(**{key: value for key, value in request.items() if key in {"id", "style", "lyrics", "cot", "seed", "abc", "cfg_scale"}})
                if pipeline.effective_config(native_request) != self.expected_reproduction["config"] or pipeline.weights != self.expected_reproduction["weights"]:
                    raise ValueError("Saved configuration or weights differ from the loaded planner. Reuse inputs for an intentional current-environment plan.")
            pipeline.stage_callback = on_stage
            try:
                plan = pipeline.plan(**request)
                return PlannedResult(plan, pipeline.effective_config(plan.request), pipeline.weights)
            finally:
                pipeline.stage_callback = None

    def generate_exact(self, directory: Path, *, on_stage: Callable[[str], None] | None = None, **callbacks: Any) -> Any:
        """One native __call__ with an exact saved public SymbolicPlan, never retokenized."""
        with self._lock:
            pipeline = self.load()
            native = importlib.import_module("yue2.pipeline")
            plan = native.SymbolicPlan.load(directory)
            pipeline.exact_plan = plan
            pipeline.stage_callback = on_stage
            try:
                return pipeline(**plan.request.to_dict(), **callbacks)
            finally:
                pipeline.exact_plan = None
                pipeline.stage_callback = None

    def close(self) -> None:
        with self._lock:
            if self._pipeline is not None:
                self._pipeline.close()
                self._pipeline = None





class PlannedResult:
    """Studio metadata envelope for a native plan; deliberately has no audio fields."""
    def __init__(self, plan: Any, config: dict[str, Any], weights: dict[str, Any]):
        self.plan, self.config, self.weights = plan, config, weights

    def save_artifacts(self, directory: Path) -> dict[str, Any]:
        from backend.services.jobs import write_json
        from backend.services.library import digest_file
        self.plan.save(directory)
        write_json(directory / "request.json", self.plan.request.to_dict())
        write_json(directory / "config.json", self.config)
        artifacts = {path.name: {"bytes": path.stat().st_size, "sha256": digest_file(path)} for path in directory.iterdir() if path.is_file()}
        metadata = {"kind": "plan", "status": "complete", "truncated": self.plan.truncated,
                    "weights": self.weights, "effective_config": self.config,
                    "timing": self.plan.timing, "artifacts": artifacts}
        write_json(directory / "plan_result.json", metadata)
        return metadata
