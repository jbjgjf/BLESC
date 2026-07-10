from pydantic import BaseModel, Field
from typing import List, Dict, Any, Literal

# Matches your "Input" schema screenshot


class SafetyAssessmentInput(BaseModel):
    reflection_id: str
    content: str
    extraction: Dict[str, Any] = Field(default_factory=dict)

# Matches your "Return" schema screenshot


class SafetyAssessmentReturn(BaseModel):
    risk_level: Literal["none", "low", "elevated", "crisis"]
    confidence: float
    escalation_required: bool
    reasons: List[str]
    safe_response: str
    policy_refs: List[str]
