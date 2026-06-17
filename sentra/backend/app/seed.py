import logging
from datetime import datetime, timedelta, date
from sqlmodel import Session, select, func
from .database import engine
from .schemas.entry import Entry
from .schemas.extraction import Extraction
from .schemas.structured import GraphSnapshot, HybridExplanation
from .schemas.analytics import AnomalyResult
from .analytics.graph_features import build_graph_summary, build_temporal_graph_diff, summarize_temporal_diff

logger = logging.getLogger(__name__)

def seed_data():
    with Session(engine) as session:
        # Check if already seeded
        existing_entries = session.exec(select(Entry)).first()
        if existing_entries:
            logger.info("Database already contains data, skipping seed.")
            return

        logger.info("Seeding database with complex default data...")
        
        user_id = "demo_user"
        base_date = datetime.utcnow() - timedelta(days=7)

        # Day 1: Normal State
        nodes_d1 = [
            {"id": "work", "category": "Behavior", "label": "Work", "intensity": 0.6},
            {"id": "home", "category": "State", "label": "Home Life", "intensity": 0.5},
            {"id": "sleep", "category": "Behavior", "label": "Sleep", "intensity": 0.8},
            {"id": "exercise", "category": "Protective", "label": "Morning Run", "intensity": 0.7},
        ]
        relations_d1 = [
            {"source_id": "exercise", "target_id": "sleep", "type": "buffers", "confidence": 0.9},
            {"source_id": "work", "target_id": "home", "type": "co_occurs", "confidence": 0.5},
        ]
        
        # Day 3: Stress increases
        nodes_d3 = nodes_d1 + [
            {"id": "deadline", "category": "Event", "label": "Project Deadline", "intensity": 0.9},
            {"id": "stress", "category": "State", "label": "Stress", "intensity": 0.8},
            {"id": "anxiety", "category": "State", "label": "Anxiety", "intensity": 0.6},
        ]
        relations_d3 = relations_d1 + [
            {"source_id": "deadline", "target_id": "stress", "type": "causes", "confidence": 1.0},
            {"source_id": "stress", "target_id": "anxiety", "type": "escalates", "confidence": 0.8},
            {"source_id": "stress", "target_id": "sleep", "type": "escalates", "confidence": 0.7},
        ]

        # Day 7: Peak Stress & Intervention
        nodes_d7 = nodes_d3 + [
            {"id": "insomnia", "category": "Behavior", "label": "Insomnia", "intensity": 0.9},
            {"id": "therapy", "category": "Protective", "label": "Therapy Session", "intensity": 0.8},
            {"id": "meditation", "category": "Protective", "label": "Meditation", "intensity": 0.6},
        ]
        relations_d7 = relations_d3 + [
            {"source_id": "insomnia", "target_id": "stress", "type": "escalates", "confidence": 0.9},
            {"source_id": "therapy", "target_id": "anxiety", "type": "buffers", "confidence": 0.8},
            {"source_id": "meditation", "target_id": "stress", "type": "buffers", "confidence": 0.7},
            {"source_id": "deadline", "target_id": "insomnia", "type": "causes", "confidence": 0.8},
        ]

        days_data = [
            (base_date, "I had a normal day, went for a run and slept well.", nodes_d1, relations_d1),
            (base_date + timedelta(days=2), "The new project deadline is approaching. I feel quite stressed and my sleep is getting worse.", nodes_d3, relations_d3),
            (base_date + timedelta(days=6), "I can't sleep at all because of the deadline. I started meditation and had a therapy session which helped a bit with the anxiety, but the stress is still high.", nodes_d7, relations_d7),
        ]

        previous_snapshot = None
        for day_dt, text, nodes, relations in days_data:
            entry = Entry(
                user_id=user_id,
                raw_text=text,
                created_at=day_dt,
                is_masked=True
            )
            session.add(entry)
            session.commit()
            session.refresh(entry)

            extraction = Extraction(
                entry_id=entry.id,
                nodes_json=nodes,
                relations_json=relations,
                temporal_summary="recent",
                created_at=day_dt
            )
            session.add(extraction)

            graph_summary = build_graph_summary(nodes, relations)
            
            if previous_snapshot:
                diff = build_temporal_graph_diff(nodes, relations, previous_snapshot.nodes_json, previous_snapshot.relations_json)
                temporal_diff = summarize_temporal_diff(diff, graph_summary, previous_snapshot.graph_summary_json)
            else:
                temporal_diff = {"added_nodes": nodes, "added_relations": relations}

            snapshot = GraphSnapshot(
                entry_id=entry.id,
                user_id=user_id,
                day=day_dt.date(),
                nodes_json=nodes,
                relations_json=relations,
                graph_summary_json=graph_summary,
                temporal_diff_json=temporal_diff,
                created_at=day_dt
            )
            session.add(snapshot)
            session.commit()
            session.refresh(snapshot)
            previous_snapshot = snapshot

            # Add a dummy anomaly result to make it look active
            anomaly = AnomalyResult(
                user_id=user_id,
                day=day_dt.date(),
                score=0.2 if day_dt == base_date else (0.8 if day_dt == base_date + timedelta(days=6) else 0.5),
                is_anomaly=day_dt == base_date + timedelta(days=6),
                created_at=day_dt
            )
            session.add(anomaly)
            session.commit()

        logger.info("Successfully seeded database.")
