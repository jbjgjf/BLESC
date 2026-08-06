"""D-06: out-of-vocabulary categories and relations were coerced silently.

Every unrecognised category became a State and every unrecognised relation
became co_occurs, indistinguishable from the model genuinely choosing them —
so schema adherence could not be measured, and neither could the share of any
graph that was actually extracted.
"""

import logging

from app.ontology.validator import validate_extraction


def _node(node_id, **overrides):
    return {"node_id": node_id, "label": node_id, **overrides}


class TestCoercionIsRecorded:
    def test_clean_extraction_records_none(self):
        result = validate_extraction({
            "nodes": [_node("a", **{"class": "State"}), _node("b", **{"class": "Trigger"})],
            "relations": [{"source_id": "a", "target_id": "b", "type": "causes"}],
        })
        assert result["coercion_count"] == 0
        assert result["coerced_fields"] == []
        assert result["coercion_rate"] == 0.0

    def test_invalid_category_is_counted_and_kept_working(self):
        result = validate_extraction({"nodes": [_node("a", **{"class": "Vibe"})]})
        assert result["coercion_count"] == 1
        assert result["nodes"][0]["category"] == "State"  # still repaired
        entry = result["coerced_fields"][0]
        assert entry == {
            "element_id": "a",
            "field": "category",
            "original": "Vibe",
            "replacement": "State",
            "reason": "invalid",
        }

    def test_missing_and_invalid_are_distinguished(self):
        # They call for different fixes: an omitted field is a prompt problem,
        # an invented value is a vocabulary problem.
        missing = validate_extraction({"nodes": [_node("a")]})
        invalid = validate_extraction({"nodes": [_node("a", **{"class": "Vibe"})]})
        assert missing["coerced_fields"][0]["reason"] == "missing"
        assert invalid["coerced_fields"][0]["reason"] == "invalid"

    def test_invalid_relation_is_counted(self):
        result = validate_extraction({
            "nodes": [_node("a", **{"class": "State"}), _node("b", **{"class": "State"})],
            "relations": [{"source_id": "a", "target_id": "b", "type": "vibes_with"}],
        })
        assert result["coercion_count"] == 1
        assert result["relations"][0]["type"] == "co_occurs"
        assert result["coerced_fields"][0]["element_id"] == "a->b"

    def test_rate_is_over_surviving_elements(self):
        result = validate_extraction({
            "nodes": [_node("a", **{"class": "Vibe"}), _node("b", **{"class": "State"})],
            "relations": [{"source_id": "a", "target_id": "b", "type": "causes"}],
        })
        assert result["coercion_count"] == 1
        assert result["coercion_rate"] == round(1 / 3, 6)

    def test_coercion_is_logged(self, caplog):
        with caplog.at_level(logging.WARNING, logger="app.ontology.validator"):
            validate_extraction({"nodes": [_node("a", **{"class": "Vibe"})]})
        assert any("ontology coercion" in record.getMessage() for record in caplog.records)
