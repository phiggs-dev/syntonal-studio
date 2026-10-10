"""Composition boundaries; score versions preserve exact UTF-8 text and ancestry."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, model_serializer

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

class SyllableAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=200)
    first_note: int | None = Field(default=None, ge=0, le=100_000)
    last_note: int | None = Field(default=None, ge=0, le=100_000)

    @model_validator(mode="after")
    def ordered_notes(self):
        if (self.first_note is None) != (self.last_note is None):
            raise ValueError("Both note endpoints must be assigned or unassigned")
        if self.first_note is not None and self.last_note < self.first_note:
            raise ValueError("Syllable note range must be ordered")
        return self

class AlignmentLine(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    section: int = Field(ge=0, le=100_000)
    line: int = Field(ge=0, le=100_000)
    text: str = Field(min_length=1, max_length=10_000)
    syllables: list[SyllableAssignment] = Field(min_length=1, max_length=500)

class LyricAlignment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    abc: str = Field(max_length=100_000)
    lyrics: str = Field(max_length=100_000)
    lines: list[AlignmentLine] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def unique_lines(self):
        positions = [(line.section, line.line) for line in self.lines]
        if len(set(positions)) != len(positions):
            raise ValueError("Alignment lines must be unique within each section")
        return self

class EditorMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    lyrics: str = Field(max_length=100_000)
    phrases: list[LyricPhrase] = Field(default_factory=list, max_length=2000)
    alignment: LyricAlignment | None = None
    working_lyrics: str | None = Field(default=None, max_length=100_000)

    @model_serializer(mode="wrap")
    def serialize_metadata(self, handler):
        # Legacy metadata keeps its original shape when no alignment is present.
        value = handler(self)
        if self.alignment is None:
            value.pop("alignment", None)
        if self.working_lyrics is None:
            value.pop("working_lyrics", None)
        return value

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
