from datetime import datetime, timedelta
from typing import Optional
from sqlmodel import Field, SQLModel, Relationship

class Entry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    raw_text: Optional[str] = Field(default=None)  # TTL-bound
    is_masked: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = Field(default=None)
    provenance_hash: Optional[str] = Field(default=None)

    # Relationship to extractions
    extractions: list["Extraction"] = Relationship(back_populates="entry")
    embeddings: list["Embedding"] = Relationship(back_populates="entry")

# Default TTL: 30 days if raw_text is present
def get_default_expires_at():
    return datetime.utcnow() + timedelta(days=30)
