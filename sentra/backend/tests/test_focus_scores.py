"""Issues #81, #82, #83 — the probe's scoring rule, name and structure.

The weights were unsourced, the name claimed a clinical construct the metric
does not implement, and the single scalar collapsed a distinction the
reference instrument keeps deliberately.
"""

import pytest

from app.analytics.cognitive_probe import (
    PIPELINE_VERSION,
    REFLECTION_TERMS,
    VOCABULARY_PROVENANCE,
    cognitive_probe_features,
    is_legacy_probe_row,
    read_negative_self_focus,
)
from app.analytics.tokenize import japanese_analysis_available

requires_dictionary = pytest.mark.skipif(
    not japanese_analysis_available(), reason="fugashi/unidic-lite not installed"
)


class TestScoringRule:
    """#81 — equal weighting, which is what the RRS actually does."""

    def test_score_is_the_unweighted_mean_of_its_components(self):
        features = cognitive_probe_features("", "i feel tired alone and i am tired")
        expected = (
            features["negative_term_count"] / features["token_count"]
            + features["self_ref_density"]
            + features["perseveration"]
        ) / 3
        assert features["negative_self_focus_score"] == pytest.approx(expected, abs=1e-6)

    def test_range_is_zero_to_one(self):
        # Each component is a density in 0..1, so their mean is too. No clamp
        # is needed, and none is applied — a min(1.0, ...) would hide a
        # component that had escaped its range.
        for text in ["", "i", "i i i i i", "tired tired tired alone alone"]:
            score = cognitive_probe_features("", text)["negative_self_focus_score"]
            assert 0.0 <= score <= 1.0, text

    def test_old_weights_are_gone(self):
        # AST, not text: the comment explaining why the weights were removed
        # names them, and a substring check would trip on its own rationale.
        import ast
        import inspect

        from app.analytics import cognitive_probe

        tree = ast.parse(inspect.getsource(cognitive_probe).lstrip())
        literals = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, float)
        }
        assert not ({0.45, 0.30, 0.25} & literals), f"an unsourced weight is back: {literals}"


class TestNaming:
    """#82 — the clinical name is a claim the metric cannot support."""

    def test_new_keys_are_emitted(self):
        features = cognitive_probe_features("", "i feel tired")
        assert "negative_self_focus_score" in features
        assert "reflective_focus_score" in features

    def test_old_key_is_not_emitted(self):
        assert "rumination_index" not in cognitive_probe_features("", "i feel tired")

    def test_pipeline_version_distinguishes_old_rows(self):
        """Pinned, so a construct change cannot ship without touching this line.

        v5 (2026-08-20) moved the free recall in front of the journal. No
        formula changed, which is exactly why the version had to: the same code
        now reads two texts that mean something different, and a row that could
        not be told apart from a v4 row would let two constructs be pooled.
        """
        assert PIPELINE_VERSION == "cognitive-probe-v5"

    def test_the_row_records_which_prompt_was_answered_first(self):
        """The v5 boundary is visible in the data, not only in a date.

        The UI defaults to recall-first but does not force it, so a session that
        went the other way is a v4-shaped observation carrying a v5 version
        string. Only this field separates them.
        """
        recall_first = cognitive_probe_features(
            "today was long", "tired", field_order=["first_recall_30", "journal_entry"]
        )
        journal_first = cognitive_probe_features(
            "today was long", "tired", field_order=["journal_entry", "first_recall_30"]
        )
        assert recall_first["elicitation_order"] == "recall_first"
        assert journal_first["elicitation_order"] == "journal_first"

    def test_absent_telemetry_is_not_read_as_the_default_order(self):
        """No field order recorded is not evidence the default was followed."""
        assert cognitive_probe_features("a", "b")["elicitation_order"] == "unknown"
        assert cognitive_probe_features("a", "b", field_order=[])["elicitation_order"] == "unknown"

    def test_one_prompt_answered_is_not_an_order(self):
        """A student who only wrote the journal ordered nothing against anything."""
        only_journal = cognitive_probe_features("today", "", field_order=["journal_entry"])
        assert only_journal["elicitation_order"] == "only_journal_entry"

    def test_reordering_does_not_touch_the_formulas(self):
        """v5 is a change of what the texts ARE, not of what is computed.

        Every score must be identical across the two orders — if one moved, the
        reorder would have quietly changed the measurement as well as the
        construct, and the two effects could never be separated afterwards.
        """
        scored = [
            cognitive_probe_features("today was long", "tired", field_order=order)
            for order in (["first_recall_30", "journal_entry"], ["journal_entry", "first_recall_30"])
        ]
        for key, value in scored[0].items():
            if key == "elicitation_order":
                continue
            assert scored[1][key] == value, f"{key} moved with the order"

    def test_history_is_readable_not_dropped(self):
        legacy = {"rumination_index": 0.42, "pipeline_version": "cognitive-probe-v2"}
        assert read_negative_self_focus(legacy) == 0.42
        assert is_legacy_probe_row(legacy) is True

    def test_current_rows_are_not_flagged_legacy(self):
        assert is_legacy_probe_row(cognitive_probe_features("", "i feel tired")) is False

    def test_missing_key_returns_none_rather_than_raising(self):
        assert read_negative_self_focus({"pipeline_version": "x"}) is None


class TestSplit:
    """#83 — brooding-side and reflection-side reported separately."""

    def test_reflection_language_scores_reflective_not_negative(self):
        features = cognitive_probe_features("", "i will try to talk to my teacher tomorrow and plan")
        assert features["reflective_focus_score"] > 0
        assert features["reflective_focus_score"] > features["negative_self_focus_score"]

    @requires_dictionary
    def test_reflection_works_in_japanese(self):
        features = cognitive_probe_features("", "明日はまず先生に相談してみようと思う")
        assert features["reflective_focus_score"] > 0

    @requires_dictionary
    def test_brooding_language_does_not_score_reflective(self):
        features = cognitive_probe_features("", "私は自分がもう消えたい、つらい")
        assert features["negative_self_focus_score"] > 0
        assert features["reflective_focus_score"] == 0.0

    def test_no_combined_scalar_is_emitted(self):
        # Averaging the two would reproduce the collapse this split undoes,
        # and there is no basis for weighting them against each other.
        features = cognitive_probe_features("", "i feel tired but i will try")
        assert "rumination_index" not in features
        assert "combined_focus_score" not in features


class TestVocabularyProvenance:
    """#83's constraint: the new list must not become a second unsourced one."""

    def test_every_vocabulary_declares_where_it_came_from(self):
        features = cognitive_probe_features("", "i feel tired")
        provenance = features["vocabulary_provenance"]
        for name in ("negative", "positive", "self_reference", "recency", "reflection"):
            assert name in provenance

    def test_reflection_list_is_marked_unsourced(self):
        # Honest by default: it is the author's judgement of what
        # problem-solving language looks like, not items from an instrument.
        # Structure changed in #84 from a bare string to a record; the claim
        # it asserts is the same.
        assert VOCABULARY_PROVENANCE["reflection"].source_refs == ["expert_judgement"]

    def test_reflection_vocabulary_covers_both_languages(self):
        assert any(term.isascii() for term in REFLECTION_TERMS)
        assert any(not term.isascii() for term in REFLECTION_TERMS)

    def test_status_no_longer_claims_only_the_weights_were_the_problem(self):
        status = cognitive_probe_features("", "i feel tired")["focus_scores_status"]
        assert "unvalidated" in status


class TestVocabularySourcing:
    """#84 — the word lists are the entire input to the score.

    Their contents are as load-bearing as the weights were, and got less
    scrutiny. Each list now states its basis, its selection rule, and what
    would take a term out.
    """

    def test_every_vocabulary_resolves_against_the_source_registry(self):
        from app.analytics.cognitive_probe import VOCABULARY_PROVENANCE
        from app.ontology.sources import resolve

        for name, provenance in VOCABULARY_PROVENANCE.items():
            assert provenance.source_refs, name
            for source_id in provenance.source_refs:
                resolve(source_id)

    def test_every_vocabulary_states_what_takes_a_term_out(self):
        from app.analytics.cognitive_probe import VOCABULARY_PROVENANCE

        for name, provenance in VOCABULARY_PROVENANCE.items():
            assert provenance.inclusion_rule.strip(), name
            assert provenance.exclusion_rule.strip(), name

    def test_english_self_reference_is_first_person_singular_only(self):
        # The scope Rude et al. (2004) actually support. Plural forms are
        # absent deliberately — the finding does not extend to them, and a
        # `we` in the list would be citing beyond the source.
        from app.analytics.cognitive_probe import SELF_REFERENCE_TERMS

        english = {term for term in SELF_REFERENCE_TERMS if term.isascii()}
        assert english == {"i", "me", "my", "mine", "myself"}
        assert not english & {"we", "us", "our", "ours", "ourselves"}

    def test_the_pronoun_source_records_what_it_does_not_cover(self):
        from app.ontology.sources import resolve

        scope = resolve("rude_2004_pronouns").scope_note
        # Japanese drops pronouns, so density is a different quantity; the
        # sample is US college students, not adolescents.
        assert "Japanese" in scope
        assert "PLURAL" in scope or "plural" in scope

    def test_japanese_lexicons_were_investigated_and_the_answer_recorded(self):
        # "We looked and found nothing" would have been the easier claim and
        # is not the true one: J-LIWC2015, JIWC and 日本語感情語辞書 all exist.
        from app.analytics.cognitive_probe import JAPANESE_LEXICON_STATUS
        from app.ontology.sources import resolve

        assert JAPANESE_LEXICON_STATUS == "suitable_resources_exist_but_unused"
        assert "exist" in resolve("j_liwc2015_not_used").scope_note

    def test_no_liwc_content_is_reproduced(self):
        # LIWC is a licensed dictionary. It is cited for the method — counting
        # pronouns and affect words as separate dimensions — never for words.
        from app.ontology.sources import resolve

        assert "not" in resolve("liwc_category").scope_note.lower()

    def test_per_language_sizes_are_reported(self):
        features = cognitive_probe_features("", "i feel tired")
        for name in ("negative", "positive", "self_reference", "recency", "reflection"):
            entry = features["vocabulary_provenance"][name]
            assert entry["size_en"] > 0, name
            assert entry["size_ja"] > 0, name
