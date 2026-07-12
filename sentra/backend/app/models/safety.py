from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field


class SafetyAssessmentInput(BaseModel):
    reflection_id: str
    content: str
    extraction: Dict[str, Any] = Field(default_factory=dict)

class SafetyAssessmentReturn(BaseModel):
    risk_level: Literal["none", "low", "elevated", "crisis"]
    confidence: float = Field(ge=0.0, le=1.0)
    escalation_required: bool
    reasons: List[str]
    safe_response: str
    policy_refs: List[str]
