"""No attributable observation path, no educator (#100, #102).

The deterministic traversal's own check is tested in
`test_relation_aware_traversal.py` (`filter_reportable`, #96). These cover the
rule for every other producer, and the part only a learned model needs: a
perfect path does not get a learned output past a closed Stage 3 gate.
"""

from __future__ import annotations

import inspect
from datetime import date

from app.ontology.educator_exposure import (
    LEARNED_OUTPUT_GATE_CLOSED,
    NO_OBSERVATION_PATH,
    NO_SCORE_BREAKDOWN,
    OBSERVATION_OF_ANOTHER_PARTICIPANT,
    UNRESOLVABLE_OBSERVATION,
    EducatorCandidate,
    Producer,
    exposure_reasons,
    split_for_educators,
)
from app.ontology.evolution.layers import ObservationRef
from app.ontology.learning_gates import evaluate_stage3_entry_gate


def _ref(snapshot_id="snap-1", participant_id="synthetic:p1", day=date(2026, 9, 1)):
    return ObservationRef(participant_id=participant_id, day=day, snapshot_id=snapshot_id, entry_id="entry-1")


def _candidate(output_id="out-1", producer=Producer.DETERMINISTIC, observations=None, breakdown=True):
    return EducatorCandidate(
        output_id=output_id,
        participant_id="synthetic:p1",
        producer=producer,
        producer_version="relation-aware-traversal-v1" if producer is Producer.DETERMINISTIC else "hgt-v0",
        observations=(_ref(),) if observations is None else tuple(observations),
        has_score_breakdown=breakdown,
    )


def test_a_traceable_deterministic_output_may_be_shown():
    assert exposure_reasons(_candidate()) == ()


def test_an_output_with_no_observation_path_is_withheld():
    reasons = exposure_reasons(_candidate(observations=[]))
    assert [code for code, _ in reasons] == [NO_OBSERVATION_PATH]


def test_an_observation_that_cannot_be_resolved_is_not_a_path():
    reasons = exposure_reasons(_candidate(observations=[_ref(snapshot_id="  ")]))
    assert [code for code, _ in reasons] == [UNRESOLVABLE_OBSERVATION]


def test_another_participants_observation_is_not_this_participants_path():
    reasons = exposure_reasons(_candidate(observations=[_ref(participant_id="synthetic:p2")]))
    assert [code for code, _ in reasons] == [OBSERVATION_OF_ANOTHER_PARTICIPANT]


def test_a_bare_label_without_a_breakdown_is_withheld():
    reasons = exposure_reasons(_candidate(breakdown=False))
    assert [code for code, _ in reasons] == [NO_SCORE_BREAKDOWN]


def test_a_learned_output_is_withheld_while_stage3_is_closed_even_with_a_path():
    assert evaluate_stage3_entry_gate().open is False

    reasons = exposure_reasons(_candidate(producer=Producer.LEARNED))
    assert [code for code, _ in reasons] == [LEARNED_OUTPUT_GATE_CLOSED]


def test_a_learned_output_without_a_path_fails_on_both_counts():
    codes = {code for code, _ in exposure_reasons(_candidate(producer=Producer.LEARNED, observations=[]))}
    assert codes == {NO_OBSERVATION_PATH, LEARNED_OUTPUT_GATE_CLOSED}


def test_withheld_outputs_come_back_with_reasons_and_nothing_is_dropped():
    candidates = [
        _candidate("shown"),
        _candidate("no-path", observations=[]),
        _candidate("learned", producer=Producer.LEARNED),
    ]
    allowed, withheld = split_for_educators(candidates)

    assert [c.output_id for c in allowed] == ["shown"]
    assert [w.candidate.output_id for w in withheld] == ["no-path", "learned"]
    assert len(allowed) + len(withheld) == len(candidates)
    assert withheld[1].as_dict()["reasons"][0]["code"] == LEARNED_OUTPUT_GATE_CLOSED


def test_no_caller_can_hand_in_an_open_gate():
    """The gate is evaluated inside; there is no parameter to pass one through."""
    assert list(inspect.signature(exposure_reasons).parameters) == ["candidate"]
    assert list(inspect.signature(split_for_educators).parameters) == ["candidates"]
