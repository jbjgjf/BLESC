"""The extraction gold set: its format, its matching rules, and the #88 rule.

The rule that matters most here is the one easiest to erode: drafted labels
never reach a confirmatory number. Every item in `gold.json` was drafted by a
model and says `labelled_by: "draft"`. The tests below construct small gold
sets in memory — including items marked `human`, which no person labelled; they
exist only to exercise the split — and pin that a draft cannot move the
confirmatory result in either direction.
"""

from __future__ import annotations

import copy
import warnings

import pytest

from app.evaluation import extraction_gold as eg
from app.evaluation.extraction_gold import (
    EXTRACTORS,
    GOLD_DIR,
    align,
    evaluate,
    load_gold,
    node_matches,
    score_item,
    validate_gold,
)


@pytest.fixture(scope="module")
def gold() -> dict:
    return load_gold()


def _node(node_id, category, label, terms=(), evidence=None):
    return {"id": node_id, "category": category, "label": label, "match_terms": list(terms), "evidence": evidence or label}


def _item(item_id, text, nodes, relations=(), labelled_by="draft", **extra):
    return {
        "id": item_id, "text": text, "labelled_by": labelled_by, "author": "test-fixture",
        "nodes": nodes, "relations": [dict(zip(("source", "target", "type"), r)) for r in relations], **extra,
    }


HUMAN = {"labeller": "rater-test", "labelled_on": "2026-10-10"}

#: Two-item gold set: one item marked human (fixture only), one draft.
MIXED = {
    "synthetic": True,
    "items": [
        _item("h1", "テストが不安だ", [_node("a", "Trigger", "テスト"), _node("b", "State", "不安")],
              [("a", "b", "causes")], labelled_by="human", **HUMAN),
        _item("d1", "散歩した", [_node("x", "Protective", "散歩")]),
    ],
}


def _extractor_for(answers):
    """An extractor that returns a fixed extraction per text."""
    return lambda text: answers.get(text, {"nodes": [], "relations": []})


PERFECT_H1 = {
    "nodes": [{"id": "p1", "category": "Trigger", "label": "テスト"}, {"id": "p2", "category": "State", "label": "不安"}],
    "relations": [{"source_id": "p1", "target_id": "p2", "type": "causes"}],
}


# ── the file ─────────────────────────────────────────────────────────────────


def test_gold_file_is_well_formed(gold):
    assert validate_gold(gold) == []


def test_gold_stays_inside_the_ontology_and_says_what_it_does_not_cover(gold):
    # Outside the vocabulary is an error (validate_gold also says so). A
    # vocabulary term with no gold item has no recall to report, which is
    # worth seeing — but as a warning: the ontology is owned elsewhere, and
    # widening it must not turn this suite red.
    from app.ontology.schema import VALID_CATEGORIES, VALID_RELATIONS

    categories = {node["category"] for item in gold["items"] for node in item["nodes"]}
    relations = {rel["type"] for item in gold["items"] for rel in item["relations"]}
    assert categories <= set(VALID_CATEGORIES)
    assert relations <= set(VALID_RELATIONS)
    uncovered = sorted((set(VALID_CATEGORIES) - categories) | (set(VALID_RELATIONS) - relations))
    if uncovered:
        warnings.warn(f"extraction gold has no item for {uncovered}; their recall is not measured")


def test_readme_states_the_draft_rule_and_the_labelling_procedure():
    readme = (GOLD_DIR / "README.md").read_text(encoding="utf-8")
    assert 'labelled_by: "draft"' in readme
    assert "#88" in readme
    assert "ラベル付けの手順" in readme


def test_a_model_cannot_be_recorded_as_the_human_labeller():
    gold = copy.deepcopy(MIXED)
    gold["items"][0]["labeller"] = "model:claude-opus-5.5"
    assert any("a model cannot be the labeller" in error for error in validate_gold(gold))


def test_a_human_label_needs_a_labeller_and_a_date():
    gold = copy.deepcopy(MIXED)
    del gold["items"][0]["labelled_on"]
    assert any("needs labeller and labelled_on" in error for error in validate_gold(gold))


def test_evidence_must_be_quoted_from_the_text():
    gold = copy.deepcopy(MIXED)
    gold["items"][1]["nodes"][0]["evidence"] = "走った"
    assert any("verbatim span" in error for error in validate_gold(gold))


# ── the #88 rule ─────────────────────────────────────────────────────────────


def test_drafts_never_enter_the_confirmatory_numbers():
    result = evaluate(MIXED, _extractor_for({"テストが不安だ": PERFECT_H1}))
    assert result["human_labelled_count"] == 1
    assert result["drafted_count"] == 1
    assert result["confirmatory"]["items"] == 1
    assert result["confirmatory"]["nodes"]["recall"] == 1.0
    assert result["confirmatory"]["relations"]["recall"] == 1.0
    # The draft was missed entirely; that shows up only in the preliminary block.
    assert result["preliminary"]["nodes"]["recall"] == 0.0


def test_changing_a_draft_cannot_move_the_confirmatory_result():
    extractor = _extractor_for({"テストが不安だ": PERFECT_H1})
    before = evaluate(MIXED, extractor)["confirmatory"]

    edited = copy.deepcopy(MIXED)
    edited["items"][1]["nodes"].append(_node("y", "Event", "散歩"))
    edited["items"].append(_item("d2", "テストが不安だった", [_node("z", "State", "不安")]))
    after = evaluate(edited, extractor)["confirmatory"]
    assert after == before


def test_with_no_human_labels_there_is_no_confirmatory_number():
    drafts_only = {"synthetic": True, "items": [MIXED["items"][1]]}
    result = evaluate(drafts_only, _extractor_for({}))
    # None, never 0: "not measured" is not "measured and bad".
    assert result["confirmatory"] is None
    assert result["labelling_status"].startswith("drafted, not human-labelled")
    assert any("has not been measured" in warning for warning in result["warnings"])


def test_promoting_a_draft_is_what_makes_it_count():
    promoted = copy.deepcopy(MIXED)
    promoted["items"][1].update(labelled_by="human", **HUMAN)
    result = evaluate(promoted, _extractor_for({"テストが不安だ": PERFECT_H1}))
    assert result["human_labelled_count"] == 2
    assert result["confirmatory"]["nodes"] == {
        "tp": 2, "predicted": 2, "gold": 3, "precision": 1.0, "recall": 0.6667, "f1": 0.8,
    }


# ── matching ─────────────────────────────────────────────────────────────────


def test_category_must_match_even_when_the_label_does():
    gold_node = _node("t", "Trigger", "テスト", ["テスト"])
    assert node_matches({"category": "Trigger", "label": "数学のテスト"}, gold_node)
    assert not node_matches({"category": "Event", "label": "数学のテスト"}, gold_node)


def test_a_label_matches_by_a_core_term_and_width_is_folded():
    gold_node = _node("s", "State", "眠れない", ["眠", "睡眠"], evidence="眠れなかった")
    assert node_matches({"category": "State", "label": "眠りの乱れ"}, gold_node)
    assert node_matches({"category": "State", "label": "睡眠不足"}, gold_node)
    assert not node_matches({"category": "State", "label": "疲れ"}, gold_node)
    width = _node("w", "State", "イライラ", ["イライラ"])
    assert node_matches({"category": "State", "label": "ｲﾗｲﾗ"}, width)


def test_a_grounded_extractor_matches_by_evidence():
    gold_node = _node("s", "State", "眠れない", [], evidence="夜なかなか眠れなかった")
    predicted = {"category": "State", "label": "sleep onset problem", "evidence_text": "眠れなかった"}
    assert node_matches(predicted, gold_node)


def test_alignment_is_one_to_one():
    gold_nodes = [_node("s", "State", "不安", ["不安"])]
    predicted = [{"id": "a", "category": "State", "label": "不安"}, {"id": "b", "category": "State", "label": "強い不安"}]
    assert len(align(predicted, gold_nodes)) == 1


def test_alignment_is_maximum_whatever_the_emission_order():
    gold_nodes = [_node("g1", "State", "不安", ["不安"]), _node("g2", "State", "緊張", ["緊張"])]
    first = {"id": "a", "category": "State", "label": "不安と緊張"}
    second = {"id": "b", "category": "State", "label": "不安"}
    assert len(align([first, second], gold_nodes)) == 2
    assert len(align([second, first], gold_nodes)) == 2


def test_co_occurs_is_undirected_and_other_relations_are_not():
    item = _item("r", "x", [_node("a", "State", "不安"), _node("b", "Behavior", "ゲーム")], [("a", "b", "co_occurs")])
    nodes = [{"id": "p", "category": "State", "label": "不安"}, {"id": "q", "category": "Behavior", "label": "ゲーム"}]
    reversed_co = {"nodes": nodes, "relations": [{"source_id": "q", "target_id": "p", "type": "co_occurs"}]}
    assert score_item(item, reversed_co)["relations"]["tp"] == 1

    directed = copy.deepcopy(item)
    directed["relations"][0]["type"] = "causes"
    reversed_causes = {"nodes": nodes, "relations": [{"source_id": "q", "target_id": "p", "type": "causes"}]}
    score = score_item(directed, reversed_causes)
    assert score["relations"]["tp"] == 0
    # The link was found; only its direction was wrong.
    assert score["relations_untyped"]["tp"] == 1


def test_an_extractor_that_emits_nothing_has_no_precision():
    result = evaluate({"synthetic": True, "items": [MIXED["items"][0]]}, _extractor_for({}))
    nodes = result["confirmatory"]["nodes"]
    assert nodes["precision"] is None
    assert nodes["recall"] == 0.0
    assert nodes["f1"] is None


# ── the no-model extractors on the shared gold set ───────────────────────────


@pytest.mark.parametrize("name", sorted(EXTRACTORS))
def test_no_model_extractors_score_end_to_end(gold, name):
    result = evaluate(gold, EXTRACTORS[name])
    assert (result["confirmatory"] is None) == (result["human_labelled_count"] == 0)
    for block in (result["confirmatory"], result["preliminary"]):
        if block is None:
            continue
        for key in ("nodes", "relations", "relations_untyped"):
            for rate in ("precision", "recall", "f1"):
                value = block[key][rate]
                assert value is None or 0.0 <= value <= 1.0


def test_the_fallback_finds_nothing(gold):
    # The empty graph stored on failure. Its recall is the floor every other
    # extractor is read against.
    block = evaluate(gold, EXTRACTORS["fallback"])["preliminary"]
    assert block["nodes"]["recall"] == 0.0
    assert block["nodes"]["predicted"] == 0


def test_the_mock_refuses_to_run_against_a_real_model(monkeypatch):
    from app.services import llm_adapter as adapter_module

    monkeypatch.setattr(adapter_module.llm_adapter, "use_mock", False)
    monkeypatch.setattr(adapter_module.llm_adapter, "provider", "openai")

    def explode(*_args, **_kwargs):  # pragma: no cover - reaching it is the failure
        raise AssertionError("extract_structure was called on a non-mock adapter")

    monkeypatch.setattr(adapter_module.llm_adapter, "extract_structure", explode)
    with pytest.raises(RuntimeError, match="must never make a paid call"):
        eg.mock_extraction("テストが不安だ")
