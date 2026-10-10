"""Where a relation's two endpoints are read from, in one place (#304).

A relation reaches the backend under two spellings of the same fact:

  * the extractor's own shape — `source_node_id` / `target_node_id` — which
    `llm_adapter.EXTRACTION_JSON_SCHEMA` requires and the mock extractor emits;
  * the validated shape — `source_id` / `target_id` — which
    `validator.validate_extraction` writes and `schemas.structured.GraphRelation`
    declares.

Each reader used to carry its own `or` chain. `supabase_writer` carried none
and read `source_id` alone, so a relation in the extractor's shape was keyed
`None:causes:None` in `graph_change_events` — every such relation in a version
collapsing onto one key. A third copy of the fallback in the writer would have
fixed that row and left the next reader to repeat the mistake, so the readers
that build change keys now go through these functions instead.

An endpoint that is under neither name is reported as missing (`""`), never
guessed. Callers that need a printable key substitute `UNRESOLVED_ENDPOINT`,
which says "this could not be resolved" rather than looking like a node id.
"""

from __future__ import annotations

from typing import Any, Mapping

#: Printed in place of an endpoint that is under neither key. Angle brackets
#: keep it out of the space of node ids, which are label-derived slugs, and it
#: contains neither `:` nor `|`, the separators the change keys use — so a key
#: built with it still splits into exactly three parts.
UNRESOLVED_ENDPOINT = "<unresolved>"

# Extractor-native name first: it is what the model is told to produce. The
# order only matters for a dict carrying both names with different values,
# which nothing in the backend writes.
_SOURCE_KEYS = ("source_node_id", "source_id")
_TARGET_KEYS = ("target_node_id", "target_id")


def _first_present(relation: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = relation.get(key)
        # `None` and "" both mean "not given under this name". A literal
        # "None" string would have to come from upstream str(None); it is not
        # treated specially here because hiding it would hide that bug too.
        if value is not None and value != "":
            return str(value)
    return ""


def relation_source_id(relation: Mapping[str, Any]) -> str:
    """The source endpoint under either spelling, or ``""`` if neither is set."""
    return _first_present(relation, _SOURCE_KEYS)


def relation_target_id(relation: Mapping[str, Any]) -> str:
    """The target endpoint under either spelling, or ``""`` if neither is set."""
    return _first_present(relation, _TARGET_KEYS)


def relation_source_or_unresolved(relation: Mapping[str, Any]) -> str:
    return relation_source_id(relation) or UNRESOLVED_ENDPOINT


def relation_target_or_unresolved(relation: Mapping[str, Any]) -> str:
    return relation_target_id(relation) or UNRESOLVED_ENDPOINT
