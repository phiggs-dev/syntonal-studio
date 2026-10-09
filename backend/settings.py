"""Local configuration paths use the backend OS; credentials remain environment-only."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, field_validator


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    upstream_repository: Path | None = None
    projects_directory: Path = Path("data/projects")
    outputs_directory: Path = Path("data/outputs")
    huggingface_cache: Path | None = None
    model: str = "m-a-p/YuE2-3B"
    vae: str = "m-a-p/YuE2-Vae"
    model_revision: str | None = None
    vae_revision: str | None = None
    offline: bool = False
    sheetsage_python: Path | None = None
    sheetsage_model: str | None = None
    ffmpeg: str = "ffmpeg"

    @field_validator("upstream_repository", "projects_directory", "outputs_directory", "huggingface_cache", "sheetsage_python", mode="before")
    @classmethod
    def parse_path(cls, value: object) -> object:
        if isinstance(value, str):
            if not value.strip():
                raise ValueError("Paths must not be empty; use null for optional paths")
            return Path(value).expanduser()
        return value.expanduser() if isinstance(value, Path) else value

    @field_validator("model", "vae", "ffmpeg", "model_revision", "vae_revision", "sheetsage_model")
    @classmethod
    def nonempty_text(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Value must not be empty; use null for optional values")
        return value


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Settings:
        if not self.path.exists():
            return Settings()
        return Settings.model_validate(json.loads(self.path.read_text(encoding="utf-8")))

    def save(self, settings: Settings) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=".settings-", suffix=".tmp", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                json.dump(settings.model_dump(mode="json"), temporary, indent=2)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
