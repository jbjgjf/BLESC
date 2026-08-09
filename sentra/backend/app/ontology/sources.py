"""Registry of the material the ontology rests on — including where it rests on
nothing.

The failure this exists to fix is not missing citations. It is that a sourced
choice and an invented one look identical in the code: `VALID_CATEGORIES` was a
bare set, and nothing could distinguish a category drawn from a guideline from
one somebody typed. A registry that only holds citations reproduces that
problem for everything uncited, which is why `SourceKind.EXPERT_JUDGEMENT`
exists and why `scope_note` is required rather than optional.

Deliberately free of ontology-specific imports: the probe vocabularies use the
same registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Dict


class SourceKind(str, Enum):
    """What kind of thing is being cited.

    EXPERT_JUDGEMENT is a first-class member, not a fallback. A choice with no
    published basis is *recorded as* having none, so it can be counted, argued
    with, and replaced. Leaving it blank would make it invisible.
    """

    GUIDELINE = "guideline"
    SYSTEMATIC_REVIEW = "systematic_review"
    PRIMARY = "primary"
    EXPERT_JUDGEMENT = "expert_judgement"


@dataclass(frozen=True)
class Source:
    source_id: str
    citation: str
    url: str
    kind: SourceKind
    #: The date the material was actually retrieved. Guidelines are revised, so
    #: a claim sourced to NG134 is a claim about NG134 as it read on this date.
    #: Not the file's creation date.
    retrieved_on: date
    #: What this source supports **and what it does not**. A fact sheet
    #: reporting an association is not a source for a causal claim, and without
    #: this field that distinction lives only in whoever added the reference.
    scope_note: str

    @property
    def is_published(self) -> bool:
        return self.kind is not SourceKind.EXPERT_JUDGEMENT


_RETRIEVED = date(2026, 8, 9)

SOURCES: Dict[str, Source] = {
    "who_adolescent_mh": Source(
        source_id="who_adolescent_mh",
        citation="World Health Organization. Mental health of adolescents (fact sheet).",
        url="https://www.who.int/news-room/fact-sheets/detail/adolescent-mental-health",
        kind=SourceKind.GUIDELINE,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: prevalence and burden of adolescent mental health conditions, "
            "and that depression is a leading cause of illness and disability in "
            "adolescents. Does NOT support: any causal claim between specific "
            "antecedents and outcomes, and nothing about individual-level prediction."
        ),
    ),
    "who_mhgap": Source(
        source_id="who_mhgap",
        citation="World Health Organization. mhGAP Intervention Guide, version 2.0.",
        url="https://www.who.int/publications/i/item/9789241549790",
        kind=SourceKind.GUIDELINE,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: non-specialist assessment and referral language, and which "
            "presentations warrant escalation to a professional. Does NOT support: "
            "diagnosis, causal structure between states, or use as a screening "
            "instrument — the guide is explicit that it is for trained health workers."
        ),
    ),
    "nice_ng134": Source(
        source_id="nice_ng134",
        citation=(
            "National Institute for Health and Care Excellence. Depression in children "
            "and young people: identification and management. NICE guideline NG134, 2019."
        ),
        url="https://www.nice.org.uk/guidance/ng134",
        kind=SourceKind.GUIDELINE,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: identification and management of depression in 5-18 year olds, "
            "and which factors clinicians are directed to consider. Does NOT support: "
            "causal direction between those factors, nor their use as features in an "
            "automated risk score — NG134 describes clinician-led assessment."
        ),
    ),
    "mhlw_kokoro": Source(
        source_id="mhlw_kokoro",
        citation="厚生労働省. こころの健康（こころの耳・みんなのメンタルヘルス総合サイト）.",
        url="https://www.mhlw.go.jp/kokoro/",
        kind=SourceKind.GUIDELINE,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: Japanese-language framing of mental health, help-seeking routes, "
            "and consultation services appropriate to a Japanese school context. "
            "Does NOT support: any causal or diagnostic claim."
        ),
    ),
    "mext_seitoshido": Source(
        source_id="mext_seitoshido",
        citation="文部科学省. 生徒指導提要（令和4年12月改訂）.",
        url="https://www.mext.go.jp/a_menu/shotou/seitoshidou/",
        kind=SourceKind.GUIDELINE,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: the role of school staff, the expected escalation route within a "
            "Japanese school, and what teachers are and are not expected to judge. "
            "Does NOT support: any clinical claim, and is a source about process "
            "rather than about psychology."
        ),
    ),
    # Not a citation. This is how the registry records that a choice has no
    # published basis, so it is countable rather than invisible.
    "expert_judgement": Source(
        source_id="expert_judgement",
        citation="Author judgement. No published source identified.",
        url="",
        kind=SourceKind.EXPERT_JUDGEMENT,
        retrieved_on=_RETRIEVED,
        scope_note=(
            "Supports: nothing on its own. Records that whoever added the entry "
            "chose it without a source they could point at. Every use must carry "
            "its own written rationale; this entry is the marker, not the argument."
        ),
    ),
}


class UnknownSource(KeyError):
    """Raised when something references a source_id the registry does not hold."""


def resolve(source_id: str) -> Source:
    try:
        return SOURCES[source_id]
    except KeyError as error:
        raise UnknownSource(
            f"{source_id!r} is not in the source registry. Add it to sources.py, or "
            f"use 'expert_judgement' with a written rationale if there is no source."
        ) from error


def resolve_all(source_ids: list[str]) -> list[Source]:
    return [resolve(source_id) for source_id in source_ids]
