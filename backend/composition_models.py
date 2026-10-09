"""Composition boundaries; score versions preserve exact UTF-8 text and ancestry."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class ScoreInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(default="", max_length=200)
    abc: str = Field(min_length=1, max_length=100_000)
    project_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    parent_score_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    source_generation_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")

class ScoreVersion(ScoreInput):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    created_at: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

class PlanRenderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(default="", max_length=200)
    project_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")

class ABCInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    abc: str = Field(max_length=100_000)

class StripInput(ABCInput):
    keep_voice: Literal["both", "Vocal", "Ins"] = "both"

class CompareInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    before: str = Field(max_length=100_000)
    after: str = Field(max_length=100_000)
    voices: Literal["both", "Vocal", "Ins"] = "both"
    allow_tempo_change: bool = False
