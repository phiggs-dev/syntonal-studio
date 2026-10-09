"""Composition boundaries; score versions preserve exact UTF-8 text and ancestry."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class LyricPhrase(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    section: int = Field(ge=0, le=100_000)
    line: int = Field(ge=0, le=100_000)
    text: str = Field(min_length=1, max_length=10_000)
    first_bar: int = Field(ge=1, le=100_000)
    last_bar: int = Field(ge=1, le=100_000)

    @model_validator(mode="after")
    def ordered_range(self):
        if self.last_bar < self.first_bar:
            raise ValueError("Phrase bar range must be ordered")
        return self

class EditorMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    lyrics: str = Field(max_length=100_000)
    phrases: list[LyricPhrase] = Field(default_factory=list, max_length=2000)

class ScoreInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    editor_metadata: EditorMetadata | None = None
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
