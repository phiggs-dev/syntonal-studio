"""Studio project metadata; IDs and annotations never alter native generation inputs."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from backend.generation_models import GenerationJob

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

class ProjectInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=100000)
    tags: list[str] = Field(default_factory=list, max_length=100)
    @field_validator("name")
    @classmethod
    def meaningful_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Project name must not be blank")
        return value
    @field_validator("tags")
    @classmethod
    def valid_tags(cls, value: list[str]) -> list[str]:
        if any(not tag.strip() or len(tag) > 200 for tag in value):
            raise ValueError("Tags must contain 1 through 200 characters")
        return value

class Project(ProjectInput):
    id: str
    created_at: str
    updated_at: str

class ProjectPatch(StrictModel):
    name: str | None = None
    notes: str | None = None
    tags: list[str] | None = None

class HistoryPatch(StrictModel):
    project_id: str | None = None
    display_name: str | None = Field(default=None, max_length=200)
    favorite: bool | None = None
    notes: str | None = Field(default=None, max_length=100000)

class HistoryEntry(StrictModel):
    job: GenerationJob
    project_id: str | None = None
    display_name: str
    favorite: bool = False
    notes: str = ""
    model: str | None = None
    decoder: str | None = None
    model_revision: str | None = None
    decoder_revision: str | None = None
    parent_generation_id: str | None = None
    relation: str | None = None
    generation_seconds: float | None = None

class Artifact(StrictModel):
    name: str
    bytes: int | None = None
    sha256: str | None = None
    integrity: Literal["verified", "mismatch", "unverified", "missing"] = "unverified"
    text_preview: str | None = None
    download_url: str | None = None
