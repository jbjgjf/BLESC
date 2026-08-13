"""Ontology evolution: layers, revision, precedence, and the gate (#101).

Written against the acceptance criteria. The three synthetic scenarios #101
names have a section each and are the reason the module is shaped the way it is:

- a curated edge and a participant's own entry pointing opposite ways;
- bidirectional evidence, where A→B and B→A are both curated and both real;
- an erroneous high-confidence candidate, which must not reach the curated layer
  no matter how sure the model is.

The layer boundary is asserted structurally rather than by behaviour where it
can be: a policy table that permitted the wrong actor would fail here before any
code path that relies on it runs.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from pathlib import Path

import pytest

from app.ontology.evolution import (
    CONTRACT_VERSION,
    GENERAL,
    MUTATION_POLICY,
    NOT_IMPLEMENTED_HERE,
    Actor,
    CandidateEdge,
    CandidateStatus,
    CuratedEdge,
    EdgeLabel,
    GateThresholds,
    LabelledEdge,
    Layer,
    LayerViolation,
    ObservationRef,
    PersonalEdge,
    ReviewRequired,
    RevisionLog,
    RevisionOperation,
    curated_edges_from_seed,
    evaluate_proposals,
    find_contradictions,
    gate_summary,
    load_cases,
    participant_scope,
    personal_edges_from_graph,
    policy_table,
    precedence_rules,
    resolve,
    seed_attribution,
)
from app.ontology.schema import EvidenceStrength

BACKEND = Path(__file__).resolve().parents[1]
DAY = date(2026, 8, 1)
LATER = DAY + timedelta(days=30)
PARTICIPANT = "p-001"

BUFFERS = ("trusted_adult_contact", "depressed_mood", "buffers")
ESCALATES = ("trusted_adult_contact", "depressed_mood", "escalates")


def curated(edge_key=BUFFERS, strength=EvidenceStrength.ASSOCIATION, on=DAY, **kwargs) -> CuratedEdge:
    return CuratedEdge(
        edge_key=edge_key,
        evidence_strength=strength,
        source_refs=kwargs.pop("source_refs", ("who_mhgap",)),
        scope_note=kwargs.pop("scope_note", "population-level protective factor"),
        reviewed_by=kwargs.pop("reviewed_by", "curator-a"),
        reviewed_on=on,
        **kwargs,
    )


def observation(day=DAY, note="") -> ObservationRef:
    return ObservationRef(
        participant_id=PARTICIPANT, day=day, snapshot_id=f"s-{day.isoformat()}", entry_id="e-1", note=note
    )


def personal(edge_key=ESCALATES, days=(DAY,), **kwargs) -> PersonalEdge:
    return PersonalEdge(
        edge_key=edge_key,
        participant_id=PARTICIPANT,
        observations=tuple(observation(day) for day in days),
        first_observed=min(days),
        last_observed=max(days),
        **kwargs,
    )


def candidate(edge_key=BUFFERS, confidence=0.5, status=CandidateStatus.PROPOSED, **kwargs) -> CandidateEdge:
    return CandidateEdge(
        edge_key=edge_key,
        model_version=kwargs.pop("model_version", "structure-learner-v0"),
        data_version=kwargs.pop("data_version", "cohort-2026-08"),
        confidence=confidence,
        supporting_observations=kwargs.pop("supporting_observations", (observation(),)),
        counterevidence=kwargs.pop("counterevidence", ()),
        status=status,
        proposed_on=kwargs.pop("proposed_on", DAY),
        scope=kwargs.pop("scope", GENERAL),
        **kwargs,
    )


# ---- AC: each layer has a schema, owner, and mutation policy ---------------


def test_the_three_layers_have_distinct_owners_and_writers():
    table = policy_table()
    assert set(table["layers"]) == {"curated", "personal", "candidate"}
    assert table["contract_version"] == CONTRACT_VERSION

    owners = {layer: policy["owner"] for layer, policy in table["layers"].items()}
    assert len(set(owners.values())) == 3, "three layers, three owners"

    assert MUTATION_POLICY[Layer.CURATED].writers == (Actor.CURATOR,)
    assert MUTATION_POLICY[Layer.PERSONAL].writers == (Actor.PARTICIPANT,)
    assert Actor.MODEL in MUTATION_POLICY[Layer.CANDIDATE].writers


def test_the_three_edge_types_share_no_field_that_would_let_one_pass_for_another():
    """Structural, not conventional. A curated citation and a participant's entry
    cannot be moved into each other's records by a dict merge."""
    curated_fields = {f.name for f in dataclasses.fields(CuratedEdge)}
    personal_fields = {f.name for f in dataclasses.fields(PersonalEdge)}
    candidate_fields = {f.name for f in dataclasses.fields(CandidateEdge)}

    assert "source_refs" in curated_fields and "source_refs" not in personal_fields
    assert "evidence_strength" in curated_fields
    assert "evidence_strength" not in personal_fields and "evidence_strength" not in candidate_fields
    assert "observations" in personal_fields and "observations" not in curated_fields
    assert "model_version" in candidate_fields and "model_version" not in curated_fields
    assert personal_fields & candidate_fields <= {"edge_key", "scope"}


def test_a_curated_edge_cannot_exist_without_a_source_a_scope_note_and_a_reviewer():
    with pytest.raises(ValueError, match="source_refs"):
        curated(source_refs=())
    with pytest.raises(ValueError, match="scope_note"):
        curated(scope_note="   ")
    with pytest.raises(ValueError, match="reviewer"):
        curated(reviewed_by="")


def test_this_layer_declares_that_it_does_no_learning():
    joined = " ".join(NOT_IMPLEMENTED_HERE).lower()
    assert "graph structure learning" in joined
    assert "model confidence" in joined
    assert "causation" in joined


def test_documentation_separates_the_three_concepts():
    doc = BACKEND.parent / "docs" / "ontology_evolution.md"
    assert doc.exists(), f"documentation missing at {doc}"
    text = doc.read_text(encoding="utf-8").lower()
    for concept in ("ontology evolution", "belief revision", "graph structure learning"):
        assert concept in text, concept


# ---- AC: a personal observation never mutates the curated layer ------------


def test_a_participant_cannot_write_to_the_curated_layer():
    log = RevisionLog()
    with pytest.raises(LayerViolation) as raised:
        log._append(RevisionOperation.PROMOTE, Actor.PARTICIPANT, Layer.CURATED, BUFFERS, DAY)

    assert "may not promote in the curated layer" in str(raised.value)
    assert log.version == 0, "a refused write appends nothing"


def test_a_model_cannot_write_to_the_curated_layer_at_any_confidence():
    log = RevisionLog()
    log.add_candidate(candidate(confidence=1.0), at=DAY)

    with pytest.raises(LayerViolation):
        log.promote(
            BUFFERS,
            curated(),
            at=DAY,
            reviewer="curator-a",
            reason="the model was very sure",
            actor=Actor.MODEL,
        )
    assert log.state().curated == {}


def test_a_curator_cannot_edit_what_a_participant_wrote():
    """The rule runs both ways. The personal layer is a record of something that
    was said, and correcting it is not the curator's to do."""
    log = RevisionLog()
    for operation in (RevisionOperation.REJECT, RevisionOperation.SUPERSEDE, RevisionOperation.WEAKEN):
        with pytest.raises(LayerViolation):
            log._append(operation, Actor.CURATOR, Layer.PERSONAL, ESCALATES, DAY)


def test_an_observation_that_disagrees_with_curated_knowledge_changes_nothing():
    log = RevisionLog()
    log.promote(BUFFERS, curated(), at=DAY, reviewer="curator-a", reason="seed import")
    before = log.state().curated[BUFFERS]

    log.observe(personal(ESCALATES, days=(LATER,)), at=LATER)

    after = log.state()
    assert after.curated[BUFFERS] == before
    assert (PARTICIPANT, ESCALATES) in after.personal


# ---- AC: contradictions are retained as explicit revision events -----------


def test_a_curated_and_a_personal_claim_pointing_opposite_ways_are_both_kept():
    """#101's first named scenario.

    A guideline says a trusted adult buffers low mood. A participant reports that
    contact with the same adult makes it worse. Both are true statements about
    different things — a population and a person — and a system that resolved
    them would be choosing between a guideline and a student without being told
    how.
    """
    claims = [curated(BUFFERS), personal(ESCALATES, days=(LATER,))]
    contradictions = find_contradictions(claims, participant_id=PARTICIPANT)

    assert len(contradictions) == 1
    found = contradictions[0]
    assert set(found.as_dict()["layers"]) == {"curated", "personal"}
    assert "buffers" in found.detail and "escalates" in found.detail
    assert "not resolved" in found.as_dict()["resolution"]


def test_a_contradiction_is_recorded_as_an_event_that_changes_nothing():
    log = RevisionLog()
    log.promote(BUFFERS, curated(), at=DAY, reviewer="curator-a", reason="seed import")
    log.observe(personal(ESCALATES, days=(LATER,)), at=LATER)
    before = log.state()

    log.record_contradiction(
        BUFFERS,
        at=LATER,
        layers=(Layer.CURATED, Layer.PERSONAL),
        detail={"note": "participant reports the opposite direction"},
    )
    after = log.state()

    assert after.curated == before.curated
    assert after.personal == before.personal
    assert after.candidates == before.candidates
    event = log.events[-1]
    assert event.operation is RevisionOperation.RECORD_CONTRADICTION
    assert event.detail["layers_in_conflict"] == ["curated", "personal"]


def test_a_weak_relation_type_contradicts_nothing():
    """`co_occurs` and `precedes` assert no direction of influence."""
    claims = [
        curated(("a", "b", "co_occurs")),
        curated(("a", "b", "precedes"), on=LATER),
        personal(("a", "b", "causes")),
    ]
    assert find_contradictions(claims, participant_id=PARTICIPANT) == []


# ---- AC: the revision operations ------------------------------------------


def test_every_operation_the_issue_names_exists_and_is_recorded():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.weaken(BUFFERS, at=DAY, reason="counterexample found", confidence=0.2,
               counterevidence=(observation(note="contradicted"),))
    log.supersede(BUFFERS, ("trusted_adult_contact", "depressed_mood", "causes"), at=DAY, reason="better claim")
    log.reject(BUFFERS, at=DAY, reason="not supported")
    log.restore(BUFFERS, at=DAY, reason="new evidence")

    operations = [event.operation for event in log.events]
    assert operations == [
        RevisionOperation.ADD_CANDIDATE,
        RevisionOperation.WEAKEN,
        RevisionOperation.SUPERSEDE,
        RevisionOperation.REJECT,
        RevisionOperation.RESTORE,
    ]


def test_an_operation_that_lowers_a_claim_needs_a_recorded_reason():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    for call in (
        lambda: log.weaken(BUFFERS, at=DAY, reason="  "),
        lambda: log.reject(BUFFERS, at=DAY, reason=""),
        lambda: log.supersede(BUFFERS, ESCALATES, at=DAY, reason=""),
        lambda: log.restore(BUFFERS, at=DAY, reason=""),
    ):
        with pytest.raises(ValueError, match="recorded reason"):
            call()


def test_weakening_lowers_confidence_and_attaches_counterevidence():
    log = RevisionLog()
    log.add_candidate(candidate(confidence=0.9), at=DAY)
    log.weaken(BUFFERS, at=LATER, reason="two contradicting entries", confidence=0.3,
               counterevidence=(observation(LATER),))

    edge = log.state().candidates[BUFFERS]
    assert edge.status is CandidateStatus.WEAKENED
    assert edge.confidence == 0.3
    assert len(edge.counterevidence) == 1
    assert edge.counterevidence_is_informative, "having looked is now on the record"


def test_a_restored_candidate_comes_back_proposed_rather_than_at_its_old_confidence():
    """A restore is a decision to reconsider, not to reinstate a number nobody
    has re-examined."""
    log = RevisionLog()
    log.add_candidate(candidate(confidence=0.9), at=DAY)
    log.weaken(BUFFERS, at=DAY, reason="doubt", confidence=0.2)
    log.reject(BUFFERS, at=DAY, reason="ruled out")
    assert log.state().candidates[BUFFERS].status is CandidateStatus.REJECTED

    log.restore(BUFFERS, at=LATER, reason="new data")
    restored = log.state().candidates[BUFFERS]
    assert restored.status is CandidateStatus.PROPOSED
    assert restored.confidence == 0.2, "the weakened confidence stands until re-examined"


def test_a_candidate_enters_the_log_as_proposed():
    log = RevisionLog()
    with pytest.raises(ValueError, match="enters the log as `proposed`"):
        log.add_candidate(candidate(status=CandidateStatus.PROMOTED), at=DAY)


def test_a_candidate_names_the_model_and_data_that_produced_it():
    with pytest.raises(ValueError, match="model and the data"):
        candidate(model_version="")
    with pytest.raises(ValueError, match="confidence must be in"):
        candidate(confidence=1.5)


# ---- AC: human review before promotion ------------------------------------


def test_promotion_requires_a_named_reviewer():
    log = RevisionLog()
    log.add_candidate(candidate(confidence=0.99), at=DAY)

    with pytest.raises(ReviewRequired, match="named reviewer"):
        log.promote(BUFFERS, curated(), at=DAY, reviewer="   ", reason="looks right")
    assert log.state().curated == {}


def test_the_promotion_and_the_promoted_edge_must_name_the_same_reviewer():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    with pytest.raises(ReviewRequired, match="must be the same person"):
        log.promote(BUFFERS, curated(reviewed_by="curator-b"), at=DAY, reviewer="curator-a", reason="ok")


def test_a_promoted_candidate_stays_in_the_log_as_promoted():
    """Promotion does not consume the proposal. The claim and the decision to
    accept it are both auditable afterwards."""
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.promote(BUFFERS, curated(), at=LATER, reviewer="curator-a", reason="reviewed against NG134")

    state = log.state()
    assert state.curated[BUFFERS].reviewed_by == "curator-a"
    assert state.candidates[BUFFERS].status is CandidateStatus.PROMOTED
    assert [event.operation for event in log.events_for(BUFFERS)] == [
        RevisionOperation.ADD_CANDIDATE,
        RevisionOperation.PROMOTE,
    ]


# ---- AC: the audit log reconstructs every version -------------------------


def test_every_version_of_the_ontology_can_be_reconstructed():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.observe(personal(ESCALATES), at=DAY)
    log.weaken(BUFFERS, at=DAY, reason="doubt", confidence=0.1)
    log.promote(BUFFERS, curated(), at=LATER, reviewer="curator-a", reason="reviewed")

    assert log.version == 4
    assert log.state_at(0).curated == {} and log.state_at(0).candidates == {}
    assert log.state_at(1).candidates[BUFFERS].status is CandidateStatus.PROPOSED
    assert log.state_at(1).personal == {}
    assert (PARTICIPANT, ESCALATES) in log.state_at(2).personal
    assert log.state_at(3).candidates[BUFFERS].confidence == 0.1
    assert log.state_at(3).curated == {}, "not curated until version 4"
    assert BUFFERS in log.state_at(4).curated

    with pytest.raises(IndexError):
        log.state_at(5)


def test_replaying_the_same_log_twice_gives_the_same_state():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.reject(BUFFERS, at=LATER, reason="ruled out")
    assert log.state().as_dict() == log.state().as_dict()
    assert RevisionLog(log.events).state().as_dict() == log.state().as_dict()


def test_the_log_is_append_only_across_every_operation():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.weaken(BUFFERS, at=DAY, reason="doubt")
    log.reject(BUFFERS, at=DAY, reason="ruled out")
    log.restore(BUFFERS, at=DAY, reason="reconsidered")

    assert [event.index for event in log.events] == [0, 1, 2, 3]
    assert len({event.index for event in log.events}) == log.version
    earlier = log.state_at(2).as_dict()
    log.reject(BUFFERS, at=LATER, reason="ruled out again")
    assert log.state_at(2).as_dict() == earlier, "a later event cannot change an earlier version"


def test_an_operation_naming_an_unknown_edge_is_ignored_rather_than_raising():
    """A log loaded from a longer history may legitimately begin mid-story."""
    log = RevisionLog()
    log.reject(("unknown", "edge", "causes"), at=DAY, reason="not in this window")
    assert log.state().candidates == {}


# ---- AC: precedence -------------------------------------------------------


def test_precedence_answers_two_questions_rather_than_picking_one_winner():
    claims = [curated(BUFFERS), personal(BUFFERS, days=(LATER,))]
    resolution = resolve(claims, "trusted_adult_contact", "depressed_mood", participant_id=PARTICIPANT)

    assert resolution.general is not None and resolution.general.layer is Layer.CURATED
    assert resolution.about_participant is not None
    assert resolution.about_participant.layer is Layer.PERSONAL
    assert any("neither replaces the other" in warning for warning in resolution.warnings)


def test_one_participants_entries_are_not_evidence_about_people_in_general():
    resolution = resolve([personal(BUFFERS)], "trusted_adult_contact", "depressed_mood")

    assert resolution.general is None
    assert resolution.about_participant is None
    assert any("not evidence about people in general" in reason for _claim, reason in resolution.excluded)


def test_a_claim_about_another_participant_is_excluded():
    other = dataclasses.replace(personal(BUFFERS), participant_id="p-002")
    resolution = resolve([other], "trusted_adult_contact", "depressed_mood", participant_id=PARTICIPANT)
    assert resolution.ranked == ()
    assert any("different participant" in reason for _claim, reason in resolution.excluded)


def test_association_is_never_read_as_causation():
    """The single mistake #101 names. A `causes` edge resting on an observational
    source is the normal case and must not report causal support."""
    resolution = resolve(
        [curated(("a", "b", "causes"), strength=EvidenceStrength.ASSOCIATION)], "a", "b"
    )
    assert resolution.causal_support is False
    assert any("not a demonstrated cause" in warning for warning in resolution.warnings)

    causal = resolve([curated(("a", "b", "causes"), strength=EvidenceStrength.CAUSAL)], "a", "b")
    assert causal.causal_support is True


def test_neither_a_participant_nor_a_model_can_assert_causation():
    assert personal(("a", "b", "causes")).asserts_causation is False
    assert candidate(("a", "b", "causes"), confidence=1.0).asserts_causation is False
    assert resolve([candidate(("a", "b", "causes"), confidence=1.0)], "a", "b").causal_support is False


def test_a_candidate_is_ranked_but_never_authoritative():
    resolution = resolve([curated(BUFFERS), candidate(BUFFERS)], "trusted_adult_contact", "depressed_mood")

    assert len(resolution.ranked) == 2
    assert all(claim.layer is not Layer.CANDIDATE for claim in resolution.authoritative)
    assert any("not knowledge" in warning for warning in resolution.warnings)


def test_precedence_orders_by_evidence_strength_then_recency():
    weak_but_new = curated(BUFFERS, strength=EvidenceStrength.EXPERT_JUDGEMENT, on=LATER)
    strong_but_old = curated(BUFFERS, strength=EvidenceStrength.CAUSAL, on=DAY)
    resolution = resolve([weak_but_new, strong_but_old], "trusted_adult_contact", "depressed_mood")

    assert resolution.ranked[0][0] is strong_but_old, "strength outranks recency"

    older = curated(BUFFERS, on=DAY)
    newer = curated(BUFFERS, on=LATER)
    same_strength = resolve([older, newer], "trusted_adult_contact", "depressed_mood")
    assert same_strength.ranked[0][0] is newer, "recency breaks a tie within one strength"


def test_a_rejected_candidate_is_excluded_from_the_ranking_but_kept():
    log = RevisionLog()
    log.add_candidate(candidate(), at=DAY)
    log.reject(BUFFERS, at=LATER, reason="ruled out")
    rejected = log.state().candidates[BUFFERS]

    resolution = resolve([rejected], "trusted_adult_contact", "depressed_mood")
    assert resolution.ranked == ()
    assert any("not in play" in reason for _claim, reason in resolution.excluded)
    assert log.events_for(BUFFERS), "the decision is still in the log"


def test_the_precedence_rules_are_stated_as_data():
    rules = precedence_rules()
    assert rules["layer_rank"] == {"curated": 0, "personal": 1, "candidate": 2}
    assert rules["evidence_rank"]["causal"] < rules["evidence_rank"]["association"]
    assert "never inferred from the relation type" in rules["causation"]


# ---- AC: bidirectional evidence -------------------------------------------


def test_bidirectional_evidence_is_two_claims_not_a_conflict():
    """#101's second named scenario.

    `sleep_deprivation -> depressed_mood` and `depressed_mood ->
    sleep_deprivation` are both curated, both real, and both sourced. They are
    not a contradiction — a loop is a finding — and neither may suppress the
    other.
    """
    forward = curated(("sleep_deprivation", "depressed_mood", "causes"), source_refs=("nice_ng134",))
    backward = curated(("depressed_mood", "sleep_deprivation", "causes"), source_refs=("nice_ng134",))

    assert find_contradictions([forward, backward]) == [], "opposite directions, not opposite polarity"

    one_way = resolve([forward, backward], "sleep_deprivation", "depressed_mood")
    other_way = resolve([forward, backward], "depressed_mood", "sleep_deprivation")
    assert one_way.general is forward
    assert other_way.general is backward


def test_the_seed_graph_really_does_carry_the_bidirectional_pair():
    """The scenario above is not hypothetical; guarding it against a seed edit."""
    keys = {edge.edge_key for edge in curated_edges_from_seed()}
    assert ("sleep_deprivation", "depressed_mood", "causes") in keys
    assert ("depressed_mood", "sleep_deprivation", "causes") in keys


# ---- AC: an erroneous high-confidence candidate ----------------------------


def test_a_confident_wrong_candidate_is_stopped_by_review_not_by_its_confidence():
    """#101's third named scenario, and the reason `promote` is shaped as it is.

    The model is certain and the edge is a red herring. Nothing about the
    confidence stops it; the layer boundary does.
    """
    wrong = candidate(("sleep_deprivation", "futoko", "causes"), confidence=0.99)
    log = RevisionLog()
    log.add_candidate(wrong, at=DAY)

    with pytest.raises(LayerViolation):
        log.promote(wrong.edge_key, curated(wrong.edge_key), at=DAY, reviewer="curator-a",
                    reason="model is confident", actor=Actor.MODEL)

    resolution = resolve([log.state().candidates[wrong.edge_key]], "sleep_deprivation", "futoko")
    assert resolution.authoritative == (), "a 0.99 proposal is still not knowledge"
    assert resolution.causal_support is False

    log.reject(wrong.edge_key, at=LATER, reason="two-hop shortcut; the curation asserts the links, not the jump")
    assert log.state().candidates[wrong.edge_key].status is CandidateStatus.REJECTED
    assert "shortcut" in log.events[-1].reason


def test_the_gate_catches_the_confident_wrong_candidate():
    proposals = [
        candidate(("sleep_deprivation", "cognitive_impairment", "causes"), confidence=0.9),
        candidate(("cognitive_impairment", "depressed_mood", "causes"), confidence=0.9),
        candidate(("depressed_mood", "social_withdrawal", "causes"), confidence=0.9),
        candidate(("peer_conflict", "social_withdrawal", "causes"), confidence=0.9),
        candidate(("loneliness", "depressed_mood", "causes"), confidence=0.9),
        candidate(("regular_sleep_schedule", "sleep_deprivation", "buffers"), confidence=0.9),
        candidate(("trusted_adult_contact", "depressed_mood", "buffers"), confidence=0.9),
        candidate(("peer_friendship", "loneliness", "buffers"), confidence=0.9),
        # The red herring, proposed with the same confidence as everything true.
        candidate(("sleep_deprivation", "futoko", "causes"), confidence=0.99),
    ]
    result = evaluate_proposals(proposals, experiment="confident-learner")

    assert result.recall >= 0.6, "it did find real structure"
    assert result.red_herring_rate > 0
    assert result.passed is False
    assert any("red-herring rate" in reason for reason in result.blocking_reasons)
    assert ("sleep_deprivation", "futoko", "causes") in result.proposed_red_herrings


# ---- AC: the structure-learning gate --------------------------------------


def test_the_gate_is_declared_before_any_learner_exists():
    summary = gate_summary()
    assert summary["thresholds"]["declared_before_results"] is True
    counts = summary["case_counts"]
    assert counts["held_out_true"] >= 10
    assert counts["red_herring"] >= 5, "the failure mode that matters needs real coverage"
    assert counts["negative"] >= 3


def test_every_labelled_case_states_why_it_carries_that_label():
    cases, _thresholds = load_cases()
    for case in cases:
        assert case.rationale.strip(), case.edge_key
    with pytest.raises(ValueError, match="rationale"):
        LabelledEdge(edge_key=("a", "b", "causes"), label=EdgeLabel.RED_HERRING, rationale="")


def test_a_learner_that_proposes_nothing_fails_on_recall_rather_than_passing_by_silence():
    result = evaluate_proposals([], experiment="empty")
    assert result.passed is False
    assert any("nothing to evaluate" in reason for reason in result.blocking_reasons)


def test_a_clean_learner_passes():
    cases, _ = load_cases()
    held_out = [case.edge_key for case in cases if case.label is EdgeLabel.HELD_OUT_TRUE]
    proposals = [candidate(key, confidence=0.8) for key in held_out]

    result = evaluate_proposals(proposals, experiment="clean")
    assert result.passed is True, result.blocking_reasons
    assert result.recall == 1.0
    assert result.red_herring_rate == 0.0
    assert result.false_positive_rate == 0.0


def test_the_gate_fails_closed_on_too_few_labelled_cases():
    """An evaluation set too small to catch a bad learner has not cleared one."""
    tiny = (
        LabelledEdge(("a", "b", "causes"), EdgeLabel.HELD_OUT_TRUE, "the only real one"),
        LabelledEdge(("a", "c", "causes"), EdgeLabel.RED_HERRING, "plausible and wrong"),
    )
    result = evaluate_proposals(
        [candidate(("a", "b", "causes"))], experiment="tiny", cases=tiny, thresholds=GateThresholds()
    )
    assert result.passed is False
    assert any("too small to catch it" in reason for reason in result.blocking_reasons)


def test_a_mixed_version_proposal_set_describes_no_single_experiment():
    proposals = [
        candidate(("sleep_deprivation", "cognitive_impairment", "causes"), model_version="v1"),
        candidate(("cognitive_impairment", "depressed_mood", "causes"), model_version="v2"),
    ]
    result = evaluate_proposals(proposals, experiment="mixed")
    assert result.passed is False
    assert any("no single experiment" in reason for reason in result.blocking_reasons)
    assert result.model_version.startswith("mixed:")


def test_mostly_unlabelled_output_cannot_be_evaluated():
    cases, _ = load_cases()
    held_out = [case.edge_key for case in cases if case.label is EdgeLabel.HELD_OUT_TRUE]
    noise = [(f"node_{index}", f"node_{index + 1}", "causes") for index in range(40)]
    result = evaluate_proposals(
        [candidate(key) for key in held_out + noise], experiment="noisy"
    )

    assert result.passed is False
    assert any("unlabelled" in reason for reason in result.blocking_reasons)


def test_the_gate_does_not_filter_on_confidence():
    """A learner that wants a threshold applies it before calling. "We would have
    passed at 0.9" is a claim someone has to make out loud."""
    low = evaluate_proposals(
        [candidate(("sleep_deprivation", "futoko", "causes"), confidence=0.01)], experiment="low"
    )
    assert ("sleep_deprivation", "futoko", "causes") in low.proposed_red_herrings


def test_a_gate_result_says_what_passing_does_not_mean():
    result = evaluate_proposals([], experiment="anything")
    assert "not evidence that the learner works" in result.as_dict()["interpretation"]
    assert "human review" in result.as_dict()["interpretation"]


# ---- the bridges from what already exists ---------------------------------


def test_the_curated_layer_loads_from_the_seed_graph_without_claiming_a_review():
    edges = curated_edges_from_seed()
    assert edges, "the seed subgraphs carry curated edges"
    assert all(edge.reviewed_by == "blesc-ontology-seed" for edge in edges)
    assert all(edge.source_refs for edge in edges)
    assert all(edge.scope.is_general for edge in edges)

    attribution = seed_attribution()
    assert attribution["review_status"] == "attributed, not independently reviewed"
    assert "does not retroactively supply one" in attribution["note"]


def test_loading_the_seed_twice_gives_the_same_curated_layer():
    assert [edge.as_dict() for edge in curated_edges_from_seed()] == [
        edge.as_dict() for edge in curated_edges_from_seed()
    ]


def test_the_personal_layer_reads_the_temporal_graph_without_taking_its_citations():
    """A temporal edge that matched a seed edge is still a record of what one
    participant wrote. Copying the seed's citations onto it is the merge these
    layers exist to prevent."""
    from datetime import date as _date

    from app.temporal import SnapshotInput, assemble_participant_graph

    graph = assemble_participant_graph(
        PARTICIPANT,
        [
            SnapshotInput(
                "s1",
                _date(2026, 8, 1),
                [
                    {"id": "眠れない", "label": "眠れない", "category": "State",
                     "provenance": {"matched": True, "source_refs": ["nice_ng134"],
                                    "match_rule": "normalised_label"}},
                    {"id": "部活", "label": "部活", "category": "Protective"},
                ],
                [
                    {"source_id": "部活", "target_id": "眠れない", "type": "buffers",
                     "provenance": {"matched": True, "source_refs": ["who_mhgap"],
                                    "evidence_strength": "association"}}
                ],
                entry_id="e-1",
            )
        ],
    )
    edges = personal_edges_from_graph(graph)

    assert len(edges) == 1
    edge = edges[0]
    assert edge.edge_key == ("部活", "眠れない", "buffers")
    assert edge.participant_id == PARTICIPANT
    assert edge.observations[0].snapshot_id == "s1"
    assert edge.observations[0].entry_id == "e-1"
    assert not hasattr(edge, "source_refs"), "no citations reach the personal layer"
    assert "who_mhgap" not in edge.as_dict().get("observations", [{}])[0].get("note", "")
    assert edge.asserts_causation is False


def test_a_personal_edge_without_an_observation_is_refused():
    with pytest.raises(ValueError, match="not an observation"):
        PersonalEdge(
            edge_key=BUFFERS,
            participant_id=PARTICIPANT,
            observations=(),
            first_observed=DAY,
            last_observed=DAY,
        )


def test_scope_refuses_an_incoherent_combination():
    with pytest.raises(ValueError, match="needs a participant_id"):
        participant_scope("")
    assert GENERAL.covers("anyone") and GENERAL.covers(None)
    assert participant_scope(PARTICIPANT).covers(PARTICIPANT)
    assert not participant_scope(PARTICIPANT).covers("someone-else")
    assert not participant_scope(PARTICIPANT).covers(None)
