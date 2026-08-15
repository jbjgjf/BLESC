"""Regression tests for the tokeniser and the cognitive probe.

Written against the defect the external review recorded: Japanese text was
split on whitespace, so a whole bunsetsu arrived as one token and matched
nothing. Every lexicon metric read ~0 for Japanese users while still returning
a value, so nothing looked broken.
"""

import os

import pytest

from app.analytics.cognitive_probe import (
    NEGATIVE_TERMS,
    POSITIVE_TERMS,
    SELF_REFERENCE_TERMS,
    cognitive_probe_features,
)
from app.analytics.tokenize import (
    analyze,
    contains_japanese,
    count_matches,
    japanese_analysis_available,
    tokens,
)

requires_dictionary = pytest.mark.skipif(
    not japanese_analysis_available(),
    reason="fugashi/unidic-lite not installed",
)


@pytest.mark.skipif(
    not os.environ.get("CI"),
    reason="a local checkout may legitimately lack the dictionary; CI may not",
)
def test_japanese_analysis_is_available_in_ci():
    """The one place a missing dictionary FAILS instead of skipping.

    Every other Japanese test in this repository is guarded by
    `requires_dictionary`, which is right for a contributor who has not
    installed a multi-megabyte dictionary — and wrong for CI, where the same
    guard means a broken install turns the suite GREEN WITH FEWER TESTS. The
    only other signals are a log line from `tokenize.py` and
    `japanese_analysis_available: false` inside the probe payload, and nothing
    reads either in a passing run.

    Found the hard way: `fugashi` and `unidic-lite` are both declared in
    `requirements.txt` and neither was present in a local environment, so
    `tokenize()` fell back to its ASCII path and 「またあの感じが戻ってきた。」
    tokenised as a single token. What surfaced was
    `test_exact_lexical_matching_does_not_beat_chance_on_this_case_set` going
    red with a message about targets sharing vocabulary with their query —
    a case-design problem that did not exist. The tokeniser should say so
    itself.

    Both requirements are unpinned, so this also catches a future resolver
    picking a `fugashi` with no wheel for the runner's Python.
    """
    assert japanese_analysis_available(), (
        "fugashi/unidic-lite are in requirements.txt but the tagger did not load. "
        "Every Japanese result in this suite is measured on the ASCII fallback, "
        "which splits on punctuation and yields clause-sized tokens. Half the #88 "
        "benchmark is Japanese; those numbers mean nothing until this passes."
    )


class TestTokeniser:
    def test_english_splits_on_whitespace_as_before(self):
        assert tokens("I feel tired and anxious") == ["i", "feel", "tired", "and", "anxious"]

    def test_empty_text_yields_nothing(self):
        assert tokens("") == []
        assert analyze("") == []

    def test_contains_japanese_detects_each_script(self):
        assert contains_japanese("ひらがな")
        assert contains_japanese("カタカナ")
        assert contains_japanese("漢字")
        assert not contains_japanese("plain ascii 123")

    @requires_dictionary
    def test_japanese_is_segmented_into_words(self):
        # The exact defect: this used to be two bunsetsu-sized tokens.
        got = tokens("最近ちょっと疲れてるかも、不安です")
        assert "疲れる" in got
        assert "不安" in got
        assert not any(len(token) > 6 for token in got), got

    @requires_dictionary
    def test_particles_and_punctuation_are_not_tokens(self):
        # Counting them would dilute every density metric for Japanese only.
        got = tokens("私は自分がもう消えたいと思う、つらい")
        for function_word in ("は", "が", "と", "、"):
            assert function_word not in got

    @requires_dictionary
    def test_one_entry_per_word_even_when_lemma_differs(self):
        # Emitting surface and lemma as separate tokens would inflate
        # token_count and corrupt every density and the perseveration ratio.
        assert len(analyze("疲れた")) == 1
        # Was 2 (助ける + くれる). くれる here is the 〜てくれる benefactive
        # auxiliary, not the verb "to give": it is 動詞-非自立可能 directly after
        # a 接続助詞, so it is grammar and no longer counted. One content word.
        assert len(analyze("助けてくれた")) == 1
        # The same lemma as a main verb still counts, which is what makes the
        # rule a disambiguation rather than a blanket exclusion.
        assert len(analyze("先生がくれた")) == 2  # 先生 + くれる


class TestVocabularyMatching:
    @requires_dictionary
    @pytest.mark.parametrize("text", ["疲れる", "疲れた", "疲れてる", "疲れ", "疲れました", "疲れちゃった"])
    def test_every_inflection_reaches_the_same_entry(self, text):
        assert count_matches(analyze(text), NEGATIVE_TERMS) == 1

    @requires_dictionary
    def test_unidic_lemma_spellings_still_match(self):
        # UniDic reads 私 as 私-代名詞 and 助け as 助ける; a vocabulary written
        # the way a person would write it must still match.
        assert count_matches(analyze("私"), SELF_REFERENCE_TERMS) == 1
        assert count_matches(analyze("助けてくれた"), POSITIVE_TERMS) == 1


class TestCognitiveProbe:
    @requires_dictionary
    def test_japanese_recall_produces_lexicon_hits(self):
        # The review's stated acceptance criterion.
        features = cognitive_probe_features("", "最近ちょっと疲れてるかも、不安です")
        assert features["negative_term_count"] >= 2
        assert features["negative_self_focus_score"] > 0

    def test_english_recall_is_unchanged(self):
        features = cognitive_probe_features("", "I feel tired and anxious and alone")
        assert features["negative_term_count"] == 3
        assert features["token_count"] == 7
        assert features["self_ref_density"] > 0

    @requires_dictionary
    def test_mixed_language_finds_both_vocabularies(self):
        features = cognitive_probe_features("", "今日は tired だった")
        assert features["negative_term_count"] == 1  # tired
        assert features["recency_marker_count"] == 1  # 今日

    @requires_dictionary
    def test_japanese_self_reference_is_counted(self):
        features = cognitive_probe_features("", "私は自分のことが不安です")
        assert features["self_ref_density"] > 0

    @requires_dictionary
    def test_semantic_distance_is_meaningful_for_japanese(self):
        # Bunsetsu tokens shared no members, so this pinned at 1.0 regardless
        # of how close the two texts actually were.
        near = cognitive_probe_features("今日は疲れた", "今日はとても疲れた")
        far = cognitive_probe_features("今日は疲れた", "友達と楽しく過ごした")
        assert near["semantic_distance_to_journal"] < far["semantic_distance_to_journal"]

    def test_empty_probe_is_flagged(self):
        features = cognitive_probe_features("", "")
        assert features["empty_probe"] is True
        assert features["token_count"] == 0

    def test_degradation_is_reported_rather_than_silent(self):
        # The failure mode being closed: a Japanese reading taken without a
        # dictionary must be identifiable in the data, not indistinguishable
        # from a calm week.
        features = cognitive_probe_features("", "不安です")
        assert features["contains_japanese"] is True
        assert features["japanese_analysis_available"] == japanese_analysis_available()


class TestSingleWeightTable:
    """D-05: the baseline-deviation weights must exist in exactly one place."""

    def test_scoring_no_longer_carries_a_weight_table(self):
        import ast
        import inspect

        from app.analytics import scoring

        assert not hasattr(scoring, "calculate_anomaly_score")

        # Look for an actual dict of feature -> number, rather than matching
        # text: prose explaining why the table was removed would trip that.
        tree = ast.parse(inspect.getsource(scoring))
        weight_tables = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Dict)
            and node.keys
            and all(isinstance(key, ast.Constant) and isinstance(key.value, str) for key in node.keys)
            and all(
                isinstance(value, ast.Constant) and isinstance(value.value, (int, float))
                or (isinstance(value, ast.UnaryOp) and isinstance(value.operand, ast.Constant))
                for value in node.values
            )
        ]
        assert not weight_tables, "a second weight table came back into scoring.py"

    def test_hybrid_inference_holds_the_live_table(self):
        from app.analytics import hybrid_inference

        assert hasattr(hybrid_inference, "score_baseline_deviation")


class TestDetectionPower:
    """D-02 acceptance: the Japanese cases must fail against the pre-D-01 code.

    If a Japanese case passed on the broken tokeniser, adding it would prove
    nothing — the evaluation would still be blind to the class of defect it
    was added to catch. These are the opening journals of the Japanese
    scenario seeds now in sentra/eval/src/scenarios.ts.
    """

    JAPANESE_SEEDS = [
        "テスト週間。夜中まで勉強してて、正直ちょっと疲れてる。朝はいつもお腹が痛い。",
        "親友がわたしのメッセージをみんなの前で読み上げた。今日もひとりでお昼を食べた。",
        "正直、今話せるのはあなただけ。人と話すのしんどいし、人間は面倒くさい。",
        "しばらく消えたいってずっと考えてる。最近ぜんぶ灰色。",
        "親がこのアプリを見たら終わる。ちょっと不安なんだけど、書いたこと見られますか？",
    ]

    @staticmethod
    def _pre_d01_tokens(text: str) -> list[str]:
        """The tokeniser as of d7b33e8, kept here as the failing baseline."""
        import re

        return [p for p in re.sub(r"[^a-zA-Z0-9ぁ-んァ-ン一-龥]+", " ", text.lower()).split() if p]

    @requires_dictionary
    @pytest.mark.parametrize("seed", JAPANESE_SEEDS)
    def test_seed_finds_nothing_under_the_old_tokeniser(self, seed):
        vocabulary = NEGATIVE_TERMS | SELF_REFERENCE_TERMS
        old_hits = sum(1 for token in self._pre_d01_tokens(seed) if token in vocabulary)
        assert old_hits == 0, "seed would have passed before the fix — it proves nothing"

    @requires_dictionary
    @pytest.mark.parametrize("seed", JAPANESE_SEEDS)
    def test_seed_is_detected_now(self, seed):
        vocabulary = NEGATIVE_TERMS | SELF_REFERENCE_TERMS
        assert count_matches(analyze(seed), vocabulary) > 0
