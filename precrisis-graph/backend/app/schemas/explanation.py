from datetime import datetime
from typing import Optional, List, Dict, Any
from sqlmodel import Field, SQLModel, JSON, Column

class ExplanationPayload(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    day: datetime = Field(index=True)
    rule_contributions: List[Dict[str, Any]] = Field(sa_column=Column(JSON))
    feature_zscores: Dict[str, float] = Field(sa_column=Column(JSON))
    top_features: List[str] = Field(sa_column=Column(JSON))
    uncertainty_summary: str = ""
    evidence_summaries: List[str] = Field(sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
