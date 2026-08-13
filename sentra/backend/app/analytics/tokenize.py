"""Shared tokenisation for the analytics layer.

Japanese does not put spaces between words, so splitting on whitespace yields
bunsetsu-sized chunks — '最近ちょっと疲れてるかも' arrives as a single token and
matches nothing in any vocabulary set. Every metric built on set membership
therefore read ~0 for Japanese users, and because a value was still returned,
nothing surfaced as a failure.

This module is the one place that decides what a token is. `services/safety.py`
deliberately does not use it: substring matching is the right tool there,
because a safety floor must fire on a fragment inside a word and must not
depend on a dictionary being installed.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, Sequence

logger = logging.getLogger(__name__)

# Japanese function words and punctuation. Excluded so that a "token" means a
# content word in both languages: Japanese sentences carry far more particles
# than English carries articles, and counting them would systematically dilute
# every density metric for Japanese users relative to English ones. English
# words are tagged 名詞 by UniDic, so this filter never touches them.
_FUNCTION_WORD_POS = frozenset({"助詞", "助動詞", "補助記号", "空白"})

#: Verbs UniDic tags 動詞-非自立可能 are content verbs in some positions and
#: grammatical auxiliaries in others: 「学校に来る」 is the verb, 「戻ってきた」 is
#: the 〜てくる aspect construction. UniDic gives both lemma 来る, so filtering the
#: tag outright would delete a real verb, and keeping it counts grammar as
#: content. The disambiguator is the preceding token: a 非自立可能 verb directly
#: after a 接続助詞 (て / で) is auxiliary.
#:
#: Found via the #87 benchmark: 「またあの感じが戻ってきた」 and 「よくなってきた」
#: share no content, but both yielded 来る, so a lexical baseline matched them and
#: scored 0.77 on a case built to be lexically unsolvable. The English half of the
#: same pair scored 0.0. Left alone, every ja/en comparison would have carried
#: this.
_AUXILIARY_CAPABLE_POS2 = "非自立可能"
_CONJUNCTIVE_PARTICLE_POS2 = "接続助詞"

_ASCII_FALLBACK = re.compile(r"[^a-zA-Z0-9ぁ-んァ-ン一-龥]+")
_JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龥]")


@dataclass(frozen=True)
class Token:
    """One word. `surface` is as written; `lemma` is its dictionary form.

    Both are kept because UniDic disagrees with everyday citation forms in ways
    that matter for a hand-written vocabulary: 疲れ standing alone is a noun
    with lemma 疲れ, but inside 疲れてる it is a verb with lemma 疲れる; 私 has
    the lemma 私-代名詞; すぐ has 直ぐ. Matching either form means a vocabulary
    can list whichever spelling a person would naturally write.
    """

    surface: str
    lemma: str

    @property
    def forms(self) -> tuple[str, ...]:
        return (self.surface,) if self.lemma == self.surface else (self.surface, self.lemma)

    @property
    def canonical(self) -> str:
        """One form per word, for set operations like Jaccard."""
        return self.lemma or self.surface


@lru_cache(maxsize=1)
def _tagger():
    """The MeCab tagger, or None when fugashi/unidic-lite are not installed.

    Import failure is logged loudly rather than swallowed. A missing dictionary
    degrades Japanese back to the broken whitespace behaviour, which is exactly
    the silent-zero failure this module exists to end, so callers can ask
    `japanese_analysis_available()` and record the degradation alongside the
    metrics.
    """
    try:
        import fugashi  # noqa: PLC0415 - optional heavy import, resolved once

        return fugashi.Tagger()
    except (ImportError, RuntimeError) as error:
        logger.error(
            "Japanese morphological analysis unavailable (%s). Japanese text will "
            "fall back to whitespace splitting and lexicon metrics will under-count. "
            "Install fugashi and unidic-lite.",
            error,
        )
        return None


def japanese_analysis_available() -> bool:
    """Whether Japanese text can be segmented. Report this alongside metrics."""
    return _tagger() is not None


def contains_japanese(text: str) -> bool:
    return bool(_JAPANESE.search(text))


def analyze(text: str) -> list[Token]:
    """Content words, one entry per word, lower-cased."""
    if not text:
        return []

    tagger = _tagger()
    if tagger is None or not contains_japanese(text):
        # Pure ASCII needs no dictionary, and this is also the degraded path.
        parts = _ASCII_FALLBACK.sub(" ", text.lower()).split()
        return [Token(part, part) for part in parts if part]

    out: list[Token] = []
    previous_is_conjunctive = False
    for word in tagger(text):
        pos1, pos2 = word.feature.pos1, word.feature.pos2
        is_conjunctive = pos1 == "助詞" and pos2 == _CONJUNCTIVE_PARTICLE_POS2
        auxiliary = (
            pos1 == "動詞" and pos2 == _AUXILIARY_CAPABLE_POS2 and previous_is_conjunctive
        )
        previous_is_conjunctive = is_conjunctive
        if pos1 in _FUNCTION_WORD_POS or auxiliary:
            continue
        surface = word.surface.strip().lower()
        if not surface:
            continue
        raw_lemma = word.feature.lemma
        lemma = raw_lemma.strip().lower() if raw_lemma else surface
        out.append(Token(surface, lemma or surface))
    return out


def tokens(text: str) -> list[str]:
    """Canonical form per word — the token stream for counting and set maths."""
    return [token.canonical for token in analyze(text)]


def count_matches(analyzed: Sequence[Token], vocabulary: Iterable[str]) -> int:
    """How many words fall in the vocabulary, matching surface or lemma.

    Counts positions rather than distinct words, so a repeated term counts
    twice — the densities downstream depend on that.
    """
    lexicon = {term.lower() for term in vocabulary}
    return sum(1 for token in analyzed if any(form in lexicon for form in token.forms))
