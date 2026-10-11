"""Guards on the #88 labelling scaffolding.

These test the protocol, not the labels — the labels do not exist yet. What can
be checked now is that the protocol cannot quietly produce a benchmark that
grades itself.
"""

import re
from collections import Counter

import pytest

from app.services.benchmark_cases import BENCHMARK_CASES, FAMILIES, TARGET_COMPOSITION
from app.services.benchmark_labelling import (
    DATASET_METADATA,
    RaterLabels,
    adjudicate,
    agreement_sample,
    apply_human_labels,
    assign_splits,
    cohens_kappa,
    display_ids,
    labelling_file,
    labelling_status,
    labelling_task,
    leakage_groups,
    read_rater_labels,
)


def test_rater_never_sees_the_answer_key():
    for case in BENCHMARK_CASES:
        task = labelling_task(case)
        serialised = repr(task)
        assert "expected_evidence_ids" not in task
        assert "research_note" not in task
        assert "family" not in task
        assert "required_hops" not in task
        # The note text itself names the targets in prose ("only traversal of
        # the curated chain"), so absence of the key alone is not enough.
        assert case.research_note not in serialised


def test_candidate_order_is_not_the_authoring_order():
    """c1..c3 first in every list is a cue, and #86 showed it is one a method
    will happily exploit. A rater is no different."""
    moved = 0
    for case in BENCHMARK_CASES:
        internal = {shown: evidence_id for evidence_id, shown in display_ids(case).items()}
        order = [internal[candidate["evidence_id"]] for candidate in labelling_task(case)["candidates"]]
        if order != [day.evidence_id for day in case.evidence]:
            moved += 1
    assert moved == len(BENCHMARK_CASES)


def test_the_id_a_rater_is_shown_does_not_name_the_drafted_role():
    """The internal ids ARE the drafted answer key, spelled as a prefix.

    `c*` is a drafted target, `f*` a foil, `d*` a decoy. A rater handed those
    ids is told which candidate the author meant before reading a word — and in
    the red-herring cases, telling a target from a foil is the only judgement
    that is actually hard. Shuffling the order hid the position and left the
    name. Every id a rater sees has to look the same whatever the day was
    drafted as.
    """
    for case in BENCHMARK_CASES:
        shown = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        internal = {day.evidence_id for day in case.evidence}
        assert not set(shown) & internal, f"{case.case_id} shows its internal ids"
        assert len({re.sub(r"\d+", "", value) for value in shown}) == 1, (
            f"{case.case_id}: shown ids differ in form by role: {sorted(set(shown))[:6]}"
        )


def test_a_decoy_motif_does_not_say_decoy_to_the_rater():
    """The decoy placeholders are numbered concepts named `decoy NN`.

    That keeps the graph language-free for the retrieval conditions, and it
    also writes the word "decoy" on every wrong day a rater is shown.
    """
    for case in BENCHMARK_CASES:
        for candidate in labelling_task(case)["candidates"]:
            for motif in candidate["graph_motifs"]:
                assert "decoy" not in motif.lower(), f"{case.case_id}: {motif}"


def test_a_rater_answering_in_shown_ids_reaches_the_cases_own_ids():
    """The display ids are a presentation layer; the answer key stays in the
    case's own ids, so every downstream consumer is unchanged."""
    case = next(case for case in BENCHMARK_CASES if case.labelled_by == "draft")
    shown = display_ids(case)
    rows = labelling_file("rater-a", [case])
    rows[0]["selected_evidence_ids"] = [shown[evidence_id] for evidence_id in case.expected_evidence_ids]
    labels = read_rater_labels(rows, [case])
    assert labels.selections[case.case_id] == set(case.expected_evidence_ids)


def test_candidate_order_is_stable_across_calls():
    """Two raters must see the same order, or disagreement about position is
    recorded as disagreement about the cases."""
    for case in BENCHMARK_CASES:
        first = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        second = [candidate["evidence_id"] for candidate in labelling_task(case)["candidates"]]
        assert first == second


def test_matched_language_pairs_share_a_leakage_group():
    groups = leakage_groups()
    for pair in (("sleep_chain_en", "sleep_chain_ja"), ("vocab_disjoint_en", "vocab_disjoint_ja")):
        assert any(set(pair) <= set(group) for group in groups), f"{pair} would be split across sets"


def test_red_herring_groups_with_the_case_whose_targets_it_contains():
    """chain_red_herring_en carries another case's targets verbatim as foils.
    Training on it and testing on that case would be testing on seen text.

    The source moved in #88: the foil used to be copied from `sleep_chain`,
    which the edge partition puts in the held-out split, so the copy dragged one
    leakage group across train and test. It is copied from
    `withdrawal_loneliness_loop` now — same split, same property under test.
    """
    groups = leakage_groups()
    assert any(
        {"chain_red_herring_en", "withdrawal_loneliness_loop_en"} <= set(group) for group in groups
    )


def test_decoy_sharing_does_not_collapse_every_case_into_one_group():
    """Decoys are generated from a shared word list and are identical across
    cases. Linking on them would make the guard vacuous by grouping everything."""
    assert len(leakage_groups()) > 1


def test_every_split_is_filled_and_no_group_spans_two():
    """The state #88 was blocking on, now reached.

    Before #88 this test asserted the opposite — that an unfillable split
    surfaced as a warning — because 6 cases could not fill three splits. What
    replaces it is the property the edge partition in `benchmark_cases/_splits.py`
    exists to guarantee, and it is the one that matters to #98: a leakage group
    that spans two splits puts a translation or a shared chain across the
    train/test boundary.
    """
    result = assign_splits()
    for split in ("train", "validation", "test"):
        assert result.cases_in(split), f"{split} is empty"
    assert not [warning for warning in result.warnings if warning.startswith("LEAKAGE:")]


def test_the_effective_sample_size_is_reported_on_every_run():
    """Not only when it is small.

    82 cases over an ontology of ~40 edges are nowhere near 82 independent
    items, and the group count is what any held-out claim rests on. Reporting it
    unconditionally is the difference between a limitation and a footnote.
    """
    result = assign_splits()
    assert any("effective sample size" in warning for warning in result.warnings)
    assert len(result.groups) < len(BENCHMARK_CASES)


def test_no_case_appears_in_two_splits():
    result = assign_splits()
    seen = [case_id for split in ("train", "validation", "test") for case_id in result.cases_in(split)]
    assert len(seen) == len(set(seen))


def test_kappa_reports_undefined_rather_than_zero_when_chance_agreement_saturates():
    """Both raters selecting nothing is 100% observed agreement and ~100%
    chance agreement. Returning 0.0 would read as 'the raters disagreed'."""
    empty = {case.case_id: set() for case in BENCHMARK_CASES}
    result = cohens_kappa(RaterLabels("a", empty), RaterLabels("b", dict(empty)))
    assert result.kappa is None
    assert result.is_defined is False
    assert result.observed_agreement == 1.0
    assert not result.meets_threshold


def test_kappa_ignores_cases_only_one_rater_labelled():
    """Treating an unlabelled case as 'selected nothing' manufactures agreement
    out of work that was never done."""
    full = {case.case_id: set(case.expected_evidence_ids) for case in BENCHMARK_CASES}
    partial = {BENCHMARK_CASES[0].case_id: set(BENCHMARK_CASES[0].expected_evidence_ids)}
    result = cohens_kappa(RaterLabels("a", full), RaterLabels("b", partial))
    assert result.judgements == len(BENCHMARK_CASES[0].evidence)


def test_no_agreement_computed_when_raters_share_no_case():
    result = cohens_kappa(RaterLabels("a", {}), RaterLabels("b", {}))
    assert result.is_defined is False
    assert result.judgements == 0


def test_status_admits_the_labels_are_not_human():
    status = labelling_status()
    assert status["human_labelled_count"] == 0
    assert status["inter_rater_agreement"] is None
    assert status["inter_rater_agreement_measured"] is False
    assert "not yet performed" in status["dataset"]["labelling_status"]
    assert status["dataset"]["reviewer"] is None
    # The count that limits any held-out claim is the group count, and it must
    # not be reported as the case count.
    assert status["independent_group_count"] < status["case_count"]


# ---- AC: composition, language, privacy (#88) -------------------------------


def test_the_case_count_is_inside_the_band_the_issue_fixed():
    assert 60 <= len(BENCHMARK_CASES) <= 100


def test_every_case_carries_a_language():
    """The single line that closes the "we have not measured per-language
    performance" gap. A case without it silently lands in whichever bucket the
    default names."""
    for case in BENCHMARK_CASES:
        assert case.lang in ("ja", "en"), case.case_id


def test_every_family_holds_the_same_count_in_each_language():
    """The matched-pair design only delivers when the families are balanced.

    Unbalanced, `by_language` measures case difficulty and reports it as a
    language effect — which is exactly what happened in #87 when the red-herring
    case was English-only.
    """
    matrix: dict[str, Counter] = {}
    for case in BENCHMARK_CASES:
        matrix.setdefault(case.family, Counter())[case.lang] += 1
    for family, langs in matrix.items():
        assert set(langs) == {"ja", "en"}, family
        assert langs["ja"] == langs["en"], f"{family} is {dict(langs)}"


def test_every_case_has_a_partner_in_the_other_language():
    by_pair: dict[str, set] = {}
    for case in BENCHMARK_CASES:
        by_pair.setdefault(case.pair_id, set()).add(case.lang)
    for pair_id, langs in by_pair.items():
        assert langs == {"ja", "en"}, f"{pair_id} is not a matched pair: {langs}"


def test_the_composition_matches_what_the_issue_fixed_in_advance():
    """A family that quietly shrank should be a failure, not a footnote."""
    actual = Counter(case.family for case in BENCHMARK_CASES)
    assert set(actual) == set(FAMILIES)
    for family, expected in TARGET_COMPOSITION.items():
        assert actual[family] == expected, f"{family}: {actual[family]} != {expected}"


def test_candidates_per_case_stay_inside_the_pre_registered_band():
    for case in BENCHMARK_CASES:
        assert 20 <= len(case.evidence) <= 40, f"{case.case_id} has {len(case.evidence)}"


def test_no_case_carries_real_user_content():
    """Structural, not a promise. Every day in the set is built by
    `expand_pair()` from a `CaseDraft` literal in this repository, so the only
    way real content could enter is by someone pasting it into a draft."""
    assert DATASET_METADATA["contains_real_user_content"] is False
    assert DATASET_METADATA["privacy_class"] == "synthetic_non_user_data"
    for case in BENCHMARK_CASES:
        for day in case.evidence:
            assert day.text.strip(), case.case_id


def test_no_case_is_labelled_human_before_a_rater_file_exists():
    """The line #88 turns on. A drafted key is not an answer key, and a model
    that writes both the question and the answer produces a benchmark shaped
    like that model's strengths."""
    assert not [case for case in BENCHMARK_CASES if case.labelled_by == "human"]


# ---- AC: the labelling round trip ------------------------------------------


def test_the_agreement_sample_is_fixed_in_advance_and_stratified():
    """Choosing which cases to double-label after seeing the labels would let
    the agreement figure be selected rather than measured."""
    first = [case.case_id for case in agreement_sample()]
    assert first == [case.case_id for case in agreement_sample()]
    assert len(first) == 20

    by_id = {case.case_id: case for case in BENCHMARK_CASES}
    langs: dict[str, Counter] = {}
    for case_id in first:
        case = by_id[case_id]
        langs.setdefault(case.family, Counter())[case.lang] += 1
    assert set(langs) == set(FAMILIES), "a family missing from the sample cannot be reported on"
    for family, counts in langs.items():
        assert counts["ja"] == counts["en"], f"{family} is unbalanced in the sample: {dict(counts)}"


def test_the_rater_file_carries_no_key_and_an_empty_slot_to_fill():
    rows = labelling_file("rater-a")
    assert len(rows) == len(BENCHMARK_CASES)
    for row in rows:
        assert row["selected_evidence_ids"] == []
        assert "expected_evidence_ids" not in row
        assert row["dataset_version"]


def test_an_unanswered_case_is_unlabelled_rather_than_labelled_empty():
    """"I worked through it and nothing helps" and "I did not get to it" are
    different claims, and only one of them is evidence."""
    rows = labelling_file("rater-a")[:3]
    rows[0]["selected_evidence_ids"] = ["c1"]
    rows[1]["selected_evidence_ids"] = ["none"]
    labels = read_rater_labels(rows)
    assert labels.selections[rows[0]["case_id"]] == {"c1"}
    assert labels.selections[rows[1]["case_id"]] == set()
    assert rows[2]["case_id"] not in labels.selections


def test_a_disagreement_stays_unresolved_until_someone_records_a_decision():
    """Taking the union or the intersection would manufacture an answer key out
    of a disagreement, and there would be nothing left to exclude."""
    case_id = BENCHMARK_CASES[0].case_id
    first = RaterLabels("a", {case_id: {"c1"}})
    second = RaterLabels("b", {case_id: {"c1", "c2"}})

    unresolved = adjudicate(first, second)
    assert case_id in unresolved.disputed
    assert case_id not in unresolved.usable

    settled = adjudicate(first, second, {case_id: {"c1", "c2"}})
    assert settled.usable[case_id] == {"c1", "c2"}


def test_applying_labels_promotes_only_the_cases_a_rater_reached():
    case = BENCHMARK_CASES[0]
    labels = RaterLabels("a", {case.case_id: {"c1"}})
    applied = apply_human_labels(adjudicate(labels, RaterLabels("b", {})))

    promoted = {item.case_id: item for item in applied}[case.case_id]
    assert promoted.labelled_by == "human"
    assert promoted.expected_evidence_ids == ("c1",)
    # Everything else keeps its drafted key and stays out of the confirmatory set.
    untouched = [item for item in applied if item.case_id != case.case_id]
    assert all(item.labelled_by in ("draft", "author") for item in untouched)


def test_a_rater_cannot_select_a_day_that_is_not_in_the_case():
    case = BENCHMARK_CASES[0]
    labels = RaterLabels("a", {case.case_id: {"not-a-real-id"}})
    with pytest.raises(ValueError, match="not among its candidates"):
        apply_human_labels(adjudicate(labels, RaterLabels("b", {})))


# ---- agreement and adjudication on synthetic labels (#127) ------------------
#
# Every label below is invented inside the test. None of it is, or stands in
# for, a human judgement about a case.


def test_kappa_matches_a_hand_computed_value():
    """One case, 2 picks each, 1 shared: 1 both / 1 + 1 one-sided / rest neither.

    p_o = (1 + (n-3)) / n, p_e = (2/n)^2 + ((n-2)/n)^2. For n = 26 that is
    p_o = 24/26 and p_e = 580/676, so kappa = 44/96.
    """
    case = next(case for case in BENCHMARK_CASES if len(case.evidence) == 26)
    ids = [day.evidence_id for day in case.evidence]
    first = RaterLabels("a", {case.case_id: {ids[0], ids[1]}})
    second = RaterLabels("b", {case.case_id: {ids[0], ids[2]}})

    result = cohens_kappa(first, second, [case])
    assert result.is_defined is True
    assert result.judgements == 26
    assert result.observed_agreement == round(24 / 26, 4)
    assert result.expected_agreement == round(580 / 676, 4)
    assert result.kappa == round(44 / 96, 4)
    assert result.meets_threshold is False


def test_identical_raters_meet_the_threshold():
    cases = [case for case in BENCHMARK_CASES if case.labelled_by == "draft"][:5]
    picks = {case.case_id: {case.evidence[0].evidence_id, case.evidence[3].evidence_id} for case in cases}
    result = cohens_kappa(RaterLabels("a", picks), RaterLabels("b", dict(picks)), cases)
    assert result.is_defined and result.kappa == 1.0 and result.meets_threshold


def test_status_tells_undefined_apart_from_not_measured():
    """Both read `inter_rater_agreement: None`. Only one of them was measured."""
    empty = {case.case_id: set() for case in BENCHMARK_CASES}
    undefined = cohens_kappa(RaterLabels("a", empty), RaterLabels("b", dict(empty)))

    measured = labelling_status(agreement=undefined)
    assert measured["inter_rater_agreement"] is None
    assert measured["inter_rater_agreement_measured"] is True
    assert measured["inter_rater_agreement_defined"] is False
    joined = " ".join(measured["warnings"])
    assert "UNDEFINED" in joined and "never as 0" in joined
    # An undefined coefficient is not a low one.
    assert "below the 0.67" not in joined

    unmeasured = labelling_status()
    assert unmeasured["inter_rater_agreement_measured"] is False
    assert unmeasured["inter_rater_agreement_defined"] is None


def test_an_excluded_disagreement_is_out_of_the_key_and_no_longer_outstanding():
    case_id = BENCHMARK_CASES[0].case_id
    first = RaterLabels("a", {case_id: {"c1"}})
    second = RaterLabels("b", {case_id: {"c1", "c2"}})

    pending = adjudicate(first, second)
    assert pending.unresolved == [case_id]

    excluded = adjudicate(first, second, exclusions={case_id: "raters read the query differently"})
    assert case_id not in excluded.usable, "an exclusion must not become a label"
    assert excluded.unresolved == []
    assert excluded.excluded == {case_id: "raters read the query differently"}


def test_an_exclusion_needs_a_disagreement_and_a_reason():
    """Only disagreement can ground an exclusion here: the pre-registration lists
    "being hard" and "being one the baseline wins" as NOT grounds, and an
    exclusion path that took any case id would be a way round that list."""
    agreed, disputed = BENCHMARK_CASES[0].case_id, BENCHMARK_CASES[1].case_id
    first = RaterLabels("a", {agreed: {"c1"}, disputed: {"c1"}})
    second = RaterLabels("b", {agreed: {"c1"}, disputed: {"c2"}})

    with pytest.raises(ValueError, match="did not disagree"):
        adjudicate(first, second, exclusions={agreed: "too hard"})
    with pytest.raises(ValueError, match="no reason"):
        adjudicate(first, second, exclusions={disputed: "  "})
    with pytest.raises(ValueError, match="both resolved and excluded"):
        adjudicate(first, second, {disputed: {"c1"}}, {disputed: "split decision"})
