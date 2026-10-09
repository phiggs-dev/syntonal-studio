"""Job HTTP schemas; decimal seed strings preserve all 63 bits in JavaScript."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class GenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(default="", max_length=200)
    style: str = Field(max_length=100_000)
    lyrics: str = Field(max_length=100_000)
    cot: Literal["full", "melody", "off"] = "full"
    seed: str = "831001"
    project_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    parent_generation_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    cfg_scale: float | None = Field(default=None, ge=0, le=20, allow_inf_nan=False)

    operation: Literal["song", "plan", "exact_plan"] = "song"
    abc: str | None = Field(default=None, min_length=1, max_length=100_000)
    source_plan_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    score_version_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")

    @model_validator(mode="after")
    def valid_composition(self):
        if self.abc is not None and (not self.abc.strip() or self.cot == "off"):
            raise ValueError("ABC requires nonempty text and full or melody mode")
        if self.operation == "plan" and (self.cot == "off" or self.abc is not None):
            raise ValueError("Plan generation requires full or melody mode without external ABC")
        return self

    @field_validator("seed")
    @classmethod
    def valid_seed(cls, value: str) -> str:
        if not value.isascii() or not value.isdecimal() or len(value) > 19 or int(value) >= 2**63:
            raise ValueError("Seed must be a decimal string from 0 through 9223372036854775807")
        return value


JobStatus = Literal["queued", "running", "complete", "failed", "cancelled"]
JobStage = Literal["queued", "loading", "planning", "semantic", "synthesizing", "decoding", "saving", "complete", "failed", "cancelled"]


class JobProgress(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str
    completed: int = Field(default=0, ge=0)
    total: int | None = Field(default=None, ge=0)
    unit: Literal["tokens", "steps", "chunks"] | None = None
    finished: bool = False


class GenerationJob(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    title: str
    status: JobStatus = "queued"
    stage: JobStage = "queued"
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    request: GenerationRequest
    output_directory: str
    error: str | None = None
    audio_url: str | None = None
    sample_rate: int | None = None
    channels: int | None = None
    duration_seconds: float | None = None
    truncated: bool = False
    token_count: int = 0
    stage_started_at: str | None = None
    progress: JobProgress | None = None
    progress_revision: int = Field(default=0, ge=0)
    queue_position: int | None = Field(default=None, ge=1)
    cancel_requested: bool = False


class JobList(BaseModel):
    jobs: list[GenerationJob]
