from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlmodel import Session, select

from app.analytics.graph_index import upsert_graph_index
from app.database import create_db_and_tables, engine
from app.schemas.research import GraphVersion
from app.services.research_pipeline import _embed_for_graph_index


def backfill(dry_run: bool = False, batch_size: int = 200) -> dict:
    """
    One-time, idempotent walk over existing graph_versions to populate the
    normalized graph_nodes/graph_edges index (see analytics/graph_index.py).
    Safe to re-run: upsert_graph_index keys on (node_key) / (source, target,
    type), so already-indexed entries are refreshed in place, not duplicated.

    Not part of the request path — run manually:
        python scripts/backfill_graph_nodes_edges.py [--dry-run]
    """
    create_db_and_tables()
    processed = 0
    touched_nodes = 0
    touched_edges = 0
    with Session(engine) as session:
        offset = 0
        while True:
            versions = session.exec(
                select(GraphVersion).order_by(GraphVersion.id.asc()).offset(offset).limit(batch_size)
            ).all()
            if not versions:
                break
            for version in versions:
                processed += 1
                if dry_run:
                    continue
                result = upsert_graph_index(
                    session,
                    user_id=version.user_id,
                    participant_code=version.participant_code,
                    nodes=version.nodes_json or [],
                    relations=version.relations_json or [],
                    day=version.created_at.date(),
                    embed_fn=_embed_for_graph_index,
                )
                touched_nodes += len(result["node_ids"])
                touched_edges += len(result["edge_ids"])
            offset += batch_size
    return {
        "processed_graph_versions": processed,
        "touched_node_rows": touched_nodes,
        "touched_edge_rows": touched_edges,
        "dry_run": dry_run,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill graph_nodes/graph_edges from existing graph_versions rows."
    )
    parser.add_argument("--dry-run", action="store_true", help="Count graph_versions rows without writing.")
    parser.add_argument("--batch-size", type=int, default=200)
    args = parser.parse_args()

    summary = backfill(dry_run=args.dry_run, batch_size=args.batch_size)
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
