"""HTTP response schemas; diagnostic status describes local readiness only."""
from typing import Literal

from pydantic import BaseModel, ConfigDict


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ok"] = "ok"
    phase: Literal[4] = 4


class DiagnosticCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    label: str
    status: Literal["pass", "warning", "fail"]
    detail: str


class SystemReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    collected_at: str
    checks: list[DiagnosticCheck]

