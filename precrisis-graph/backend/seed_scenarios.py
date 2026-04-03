import sys
import os
from datetime import date, timedelta, datetime
from sqlmodel import Session, SQLModel, create_engine

# Add parent dir to path to import app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, create_db_and_tables
from app.schemas.entry import Entry
from app.schemas.extraction import Extraction
from app.schemas.structured import GraphSnapshot
from app.analytics.graph_features import build_graph_summary, build_temporal_graph_diff, summarize_temporal_diff
from app.ontology.validator import validate_extraction
from app.services.inference_orchestrator import InferenceOrchestrator

def seed_data():
    create_db_and_tables()
    
    with Session(engine) as session:
        user_id = "research_user_01"
        orchestrator = InferenceOrchestrator(session)
        
        start_date = date.today() - timedelta(days=14)
        
        print(f"Seeding scenario data for {user_id}...")
        
        # Scenario 1: Baseline (Days 0-7)
        # Stable routine, supportive contacts, good sleep.
        for i in range(8):
            current_date = start_date + timedelta(days=i)
            dt = datetime.combine(current_date, datetime.min.time()) + timedelta(hours=10)
            
            entry = Entry(user_id=user_id, raw_text=f"Day {i}: Had a productive day. Went for a run and met a friend for coffee. Slept well.", created_at=dt)
            session.add(entry)
            session.commit()
            session.refresh(entry)
            
            # Manual extraction to ensure stable baseline
            extraction = Extraction(
                entry_id=entry.id,
                nodes_json=[
                    {"id": "run_1", "category": "Protective", "label": "routine", "intensity": 0.8},
                    {"id": "friend_1", "category": "Protective", "label": "support_person", "intensity": 0.9},
                    {"id": "sleep_1", "category": "State", "label": "good_sleep", "intensity": 0.8}
                ],
                relations_json=[],
                created_at=dt
            )
            session.add(extraction)
            session.commit()
            validated = validate_extraction(
                {
                    "nodes": extraction.nodes_json,
                    "relations": extraction.relations_json,
                    "temporal": {"recency": "recent"},
                }
            )
            graph_summary = build_graph_summary(validated["nodes"], validated["relations"])
            graph_diff = summarize_temporal_diff(
                build_temporal_graph_diff(validated["nodes"], validated["relations"], [], []),
                graph_summary,
                None,
            )
            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=user_id,
                    day=current_date,
                    nodes_json=validated["nodes"],
                    relations_json=validated["relations"],
                    graph_summary_json=graph_summary,
                    temporal_diff_json=graph_diff,
                    created_at=dt,
                )
            )
            session.commit()
            orchestrator.process_day(user_id, current_date)

        # Scenario 2: Drift (Days 8-11)
        # Increasing sleep issues and rumination.
        for i in range(8, 12):
            current_date = start_date + timedelta(days=i)
            dt = datetime.combine(current_date, datetime.min.time()) + timedelta(hours=10)
            
            entry = Entry(user_id=user_id, raw_text=f"Day {i}: Feeling a bit tired. Thinking too much about work deadlines. Sleep was okay but short.", created_at=dt)
            session.add(entry)
            session.commit()
            session.refresh(entry)
            
            extraction = Extraction(
                entry_id=entry.id,
                nodes_json=[
                    {"id": "sleep_issue", "category": "State", "label": "sleep_issue", "intensity": 0.4 + (i-8)*0.2},
                    {"id": "rumination", "category": "State", "label": "rumination", "intensity": 0.5},
                    {"id": "deadline", "category": "Trigger", "label": "deadline", "intensity": 0.6}
                ],
                relations_json=[],
                created_at=dt
            )
            session.add(extraction)
            session.commit()
            validated = validate_extraction(
                {
                    "nodes": extraction.nodes_json,
                    "relations": extraction.relations_json,
                    "temporal": {"recency": "ongoing"},
                }
            )
            graph_summary = build_graph_summary(validated["nodes"], validated["relations"])
            graph_diff = summarize_temporal_diff(
                build_temporal_graph_diff(validated["nodes"], validated["relations"], [], []),
                graph_summary,
                None,
            )
            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=user_id,
                    day=current_date,
                    nodes_json=validated["nodes"],
                    relations_json=validated["relations"],
                    graph_summary_json=graph_summary,
                    temporal_diff_json=graph_diff,
                    created_at=dt,
                )
            )
            session.commit()
            orchestrator.process_day(user_id, current_date)

        # Scenario 3: Anomaly (Day 12-13)
        # Significant isolation and total loss of protective factors.
        for i in range(12, 14):
            current_date = start_date + timedelta(days=i)
            dt = datetime.combine(current_date, datetime.min.time()) + timedelta(hours=10)
            
            entry = Entry(user_id=user_id, raw_text=f"Day {i}: Stayed in all day. Didn't want to talk to anyone. Cancelled my plans. Everything feels heavy.", created_at=dt)
            session.add(entry)
            session.commit()
            session.refresh(entry)
            
            extraction = Extraction(
                entry_id=entry.id,
                nodes_json=[
                    {"id": "isolation_1", "category": "Behavior", "label": "isolation", "intensity": 1.0},
                    {"id": "low_efficacy", "category": "State", "label": "low_self_efficacy", "intensity": 0.9},
                    {"id": "agitation_1", "category": "State", "label": "agitation", "intensity": 0.8}
                ],
                relations_json=[],
                created_at=dt
            )
            session.add(extraction)
            session.commit()
            validated = validate_extraction(
                {
                    "nodes": extraction.nodes_json,
                    "relations": extraction.relations_json,
                    "temporal": {"recency": "past"},
                }
            )
            graph_summary = build_graph_summary(validated["nodes"], validated["relations"])
            graph_diff = summarize_temporal_diff(
                build_temporal_graph_diff(validated["nodes"], validated["relations"], [], []),
                graph_summary,
                None,
            )
            session.add(
                GraphSnapshot(
                    entry_id=entry.id,
                    user_id=user_id,
                    day=current_date,
                    nodes_json=validated["nodes"],
                    relations_json=validated["relations"],
                    graph_summary_json=graph_summary,
                    temporal_diff_json=graph_diff,
                    created_at=dt,
                )
            )
            session.commit()
            orchestrator.process_day(user_id, current_date)

    print("Success: Data seeded.")

if __name__ == "__main__":
    seed_data()
