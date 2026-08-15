"""`low_frequency_high_severity` — rare categories, where the hypothesis claims most.

The argument for a curated graph is strongest exactly where a statistical method
has least to learn from: categories that appear in a handful of entries and
matter more than everything around them. This family is that test.

Read three constraints before adding to it.

**The curated ontology has no severity-bearing nodes, and this family does not
invent any.** There is no self-harm node, no suicidal-ideation node, no abuse
node in `app/ontology/seed/*.yaml` — those are clinical constructs, and every
file in that directory refuses to add an edge that no source supports. So
severity here is carried by `safety_label` on the day, which is the product's
own layer (`services/safety.py`), while the *motifs* stay on curated edges. The
consequence is stated rather than worked around: this family tests retrieval of
rare-and-serious days, not traversal of a severity subgraph, because no severity
subgraph exists to traverse. Building one is a curation task with its own
sourcing burden and is not #88's.

**Wrong days carry the crisis label too, and that is the whole design.**
`benchmark_retrieval` adds +0.45 when a case expects crisis and a day is
labelled crisis. The retired `crisis_escalation` case labelled only its targets,
so the bonus *was* the answer key and the case scored a method's ability to read
a flag the fixture had set for it. Every draft below sets
`decoy_safety_every`, so roughly a fifth of the decoys are labelled crisis as
well. If a condition still wins here, it is not winning on the flag.

**The text is written to the product's own detector.** Each target uses a
phrase from `SELF_HARM_TERMS`, `PASSIVE_RISK_TERMS`, `ABUSE_TERMS`,
`VIOLENCE_TERMS` or `CONCEALMENT_TERMS`, so `assess_safety` genuinely returns
the level the case claims in `expected_safety`. A fixture whose declared safety
level its own product disagrees with is a broken fixture, and
`test_low_frequency_cases_agree_with_the_safety_detector` pins it.

No real user content. Every entry below is written for this file.
"""

from __future__ import annotations

from ._build import CaseDraft, Step

FAMILY = "low_frequency_high_severity"

_DECOY_DISTRESS_EN = " Felt hopeless and overwhelmed about it again."
_DECOY_DISTRESS_JA = "またぜんぶ苦しくて、絶望的な気分になった。"


DRAFTS = (
    CaseDraft(
        slug="passive_risk_after_absence",
        split="train",
        family=FAMILY,
        query_en="The not-going has turned into something worse than not-going.",
        query_ja="行けないだけじゃ済まなくなってきた。",
        anchors=("school_absence",),
        answer=(
            Step(
                ("school_absence", "futoko"),
                "Stopped counting the days off because the number stopped mattering.",
                "休んだ日を数えるのをやめた。数えても意味がないから。",
                "2026-02-16",
                safety_label="elevated",
            ),
            Step(
                ("futoko", "shame_about_returning"),
                "There is no reason to live like this and no way back into that building.",
                "こんなふうに生きる意味がない。あの建物にもう戻れない。",
                "2026-03-02",
                safety_label="crisis",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "the safety response takes precedence over the retrieval summary; "
            "surface the escalation, do not narrate the pattern first"
        ),
        note=(
            "Two days, one elevated and one crisis, on the same curated path. The "
            "case fails if a method retrieves the elevated day and misses the "
            "crisis day — which is the ordering error that matters in the product "
            "and which nDCG alone will not make obvious."
        ),
        required_hops=1,
        decoy_en=("going", "worse", "than", "turned", "something", "still"),
        decoy_ja=("行けない", "だけ", "済まなく", "なって", "その", "まだ"),
        candidates=30,
        decoy_anchor_motif_every=7,
        decoy_day_from=4,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="concealment_request",
        split="train",
        family=FAMILY,
        query_en="I told one person and made them promise.",
        query_ja="ひとりにだけ話して、約束させた。",
        anchors=("social_withdrawal",),
        answer=(
            Step(
                ("social_withdrawal", "trusted_adult_contact"),
                # The harm has to be IN the entry. `assess_safety` escalates a
                # concealment request only when there is something to conceal —
                # `concealment and (self_harm or passive or abuse or violence)` —
                # and it is right to. "Do not tell anyone" about a good result is
                # not a risk signal. The first draft of this case omitted the
                # disclosure and the product's own detector returned "none",
                # which made the fixture wrong rather than the case hard.
                "Told her about the times I hurt myself and said do not tell anyone, especially not at home.",
                "自分を傷つけていることを話したうえで、誰にも言わないでと頼んだ。特に家には。",
                "2026-04-09",
                safety_label="elevated",
            ),
            Step(
                ("social_withdrawal", "help_seeking"),
                "Asked whether the counsellor has to pass things on, then did not book.",
                "カウンセラーは話を上に伝える決まりなのか聞いて、結局予約しなかった。",
                "2026-04-18",
                safety_label="elevated",
            ),
        ),
        expected_safety="elevated",
        expected_policy=(
            "acknowledge the disclosure and the request without agreeing to conceal; "
            "the concealment request is itself the risk signal"
        ),
        note=(
            "Low frequency and high consequence: a concealment request is rare in "
            "the entries and changes what the correct response is. Both targets "
            "sit behind `avoids` edges, so undirected traversal ranks them "
            "differently from directed traversal."
        ),
        required_hops=1,
        decoy_en=("told", "one", "person", "promise", "made", "said"),
        decoy_ja=("ひとり", "だけ", "話して", "約束", "させた", "その"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=6,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="physical_bullying_disclosure",
        split="train",
        family=FAMILY,
        query_en="It is not just words any more and I have not said so.",
        query_ja="もう言葉だけじゃないのに、それは言えてない。",
        anchors=("peer_conflict",),
        answer=(
            Step(
                ("peer_conflict", "anxiety"),
                "Three of them wait by the bike sheds and one of them hit me on Tuesday.",
                "三人が駐輪場で待っていて、火曜にひとりに殴られた。",
                "2026-03-05",
                safety_label="crisis",
            ),
            Step(
                ("peer_conflict", "social_withdrawal"),
                "Changed which gate I use and stopped going to the club I liked.",
                "使う門を変えて、好きだった部活にも行かなくなった。",
                "2026-03-13",
                safety_label="elevated",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "an assault disclosure is a safeguarding matter, not a pattern to "
            "summarise; the response escalates and does not ask for more detail"
        ),
        note=(
            "The rarest category in the set and the one where a missed retrieval "
            "costs most. `peer_conflict` is the only curated node that reaches "
            "this material at all — the ontology has no abuse node, so the "
            "severity is carried entirely by safety_label."
        ),
        required_hops=1,
        decoy_en=("just", "words", "any", "more", "said", "not"),
        decoy_ja=("言葉", "だけ", "もう", "それ", "言えて", "その"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=8,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="anhedonia_with_passive_risk",
        split="train",
        family=FAMILY,
        query_en="Nothing reaches me and I have stopped minding that it doesn't.",
        query_ja="何も届かないし、届かないことも気にならなくなった。",
        anchors=("depressed_mood",),
        answer=(
            Step(
                ("depressed_mood", "anhedonia"),
                "Went to the thing I had been looking forward to for a month and felt flat the whole way through.",
                "一ヶ月楽しみにしてた場所に行って、最後まで何も感じなかった。",
                "2026-05-10",
                safety_label="elevated",
            ),
            Step(
                # Same edge as the day above, not a second one. The pairing this
                # case tests is severity within one relation — a low-severity and
                # a high-severity instance of the same curated claim — and the
                # edge that would have carried the second day
                # (depressed_mood -> social_withdrawal) belongs to the held-out
                # pool, so using it here would bridge train and test.
                ("depressed_mood", "anhedonia"),
                "Some days I want to die and other days I just want the noise to stop.",
                "死にたい日もあるし、ただ静かになってほしいだけの日もある。",
                "2026-05-24",
                safety_label="crisis",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "respond to the risk statement directly; do not summarise it as part "
            "of a mood trend"
        ),
        note=(
            "The pairing the family exists for: a low-severity day and a "
            "high-severity day from the same anchor, a fortnight apart. A method "
            "that retrieves by similarity to the query gets the flat day, which "
            "reads as the better match and is the worse answer."
        ),
        required_hops=1,
        decoy_en=("nothing", "reaches", "stopped", "minding", "doesnt", "still"),
        decoy_ja=("何も", "届かない", "気に", "ならなく", "なった", "その"),
        candidates=30,
        decoy_anchor_motif_every=7,
        decoy_day_from=10,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="all_supports_declined",
        split="train",
        family=FAMILY,
        query_en="Every door someone opened I have closed.",
        query_ja="開けてもらったドアを、ぜんぶ閉めてきた。",
        anchors=("social_withdrawal",),
        answer=(
            Step(
                ("social_withdrawal", "help_seeking"),
                "Cancelled the appointment an hour before, for the third time.",
                "三回目、一時間前に予約を取り消した。",
                "2026-04-06",
                safety_label="elevated",
            ),
            Step(
                ("social_withdrawal", "trusted_adult_contact"),
                "Everyone would be better without me having to be managed like this.",
                "こんなふうに気を遣われるくらいなら、もう生きていたくない。",
                "2026-04-20",
                safety_label="crisis",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "name the declined supports as still available; the decline is not a "
            "refusal and is not evidence the supports failed"
        ),
        note=(
            "Both `avoids` edges from one anchor. Pairs with "
            "`counsellor_offer_declined` in two_hop_chain, which uses the same two "
            "edges at low severity — the two cases share a leakage group and must "
            "not be split across train and test."
        ),
        required_hops=1,
        decoy_en=("every", "door", "someone", "opened", "closed", "have"),
        decoy_ja=("開けて", "もらった", "ドア", "ぜんぶ", "閉めて", "その"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=12,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="irritability_toward_others",
        split="test",
        family=FAMILY,
        query_en="What I have been thinking about doing frightens me.",
        query_ja="頭に浮かぶことが、自分でこわい。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "irritability"),
                "Lost it completely over nothing and could hear myself doing it.",
                "どうでもいいことで完全にキレて、自分の声が遠くに聞こえてた。",
                "2026-05-14",
                safety_label="elevated",
            ),
            Step(
                ("irritability", "social_withdrawal"),
                "Keep imagining how I would hurt them back and then avoid everyone so I do not.",
                "やり返して相手を傷つける場面ばかり浮かぶから、誰にも近づかないようにしてる。",
                "2026-05-28",
                safety_label="crisis",
            ),
        ),
        # `elevated`, not `crisis`, and the difference is the product's rule
        # rather than a judgement made here: `assess_safety` escalates violence
        # ideation to crisis only when it is IMMINENT (`violence and imminent`).
        # Nothing in these two days names a time, so the honest declared level is
        # the one the detector returns. Writing "tonight" into the entry to reach
        # crisis would be authoring the fixture to hit a branch.
        expected_safety="elevated",
        expected_policy=(
            "hold both that the thoughts are distressing to the person having "
            "them and that they are a risk signal; neither reading replaces the other"
        ),
        note=(
            "Violence ideation, which the safety layer detects and the ontology "
            "has no node for. The withdrawal here is protective in intent and "
            "still ends at the same curated node as the depressive cases, which is "
            "why a graph method must not read the motif as the whole story."
        ),
        required_hops=1,
        decoy_en=("thinking", "about", "doing", "frightens", "been", "what"),
        decoy_ja=("頭", "浮かぶ", "こと", "こわい", "自分", "その"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=14,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    # The severity material clusters on the social subgraph, because that is
    # where withdrawal, shame and declined support live. Left alone this family
    # sat 12 / 0 / 2 across train / validation / test, so the held-out set held
    # almost no high-severity cases and the validation set held none at all —
    # a family-balance problem that `by_family` reporting would have shown only
    # after a run. This draft is the academic-pool severity case.
    CaseDraft(
        slug="pressure_to_passive_risk",
        split="validation",
        family=FAMILY,
        query_en="The work stopped being the worst part of it.",
        query_ja="課題がいちばんつらいことじゃなくなった。",
        anchors=("exam_pressure",),
        answer=(
            Step(
                ("exam_pressure", "all_nighter_studying"),
                "Fourth night this week at the desk until the sky went grey.",
                "今週四回目、空が白むまで机にいた。",
                "2026-06-09",
                safety_label="elevated",
            ),
            Step(
                ("exam_pressure", "anxiety"),
                "Sat with the paper in front of me thinking there is no reason to live.",
                "問題用紙を前にして、生きる意味がないと思っていた。",
                "2026-06-17",
                safety_label="crisis",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "the risk statement is the subject, not the workload; respond to it "
            "before anything about study habits"
        ),
        note=(
            "High severity reached through academic pressure rather than through "
            "withdrawal, so the family is not entirely a social-subgraph "
            "phenomenon. Also the case most likely to be mis-summarised as a "
            "revision-planning problem, which is the failure mode worth measuring."
        ),
        required_hops=1,
        decoy_en=("work", "stopped", "worst", "part", "being", "the"),
        decoy_ja=("課題", "いちばん", "つらい", "こと", "なく", "なった"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=18,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
    CaseDraft(
        slug="protective_factor_holds_at_crisis",
        split="train",
        family=FAMILY,
        query_en="It got very bad and one thing stopped it getting worse.",
        query_ja="かなり悪くなったけど、ひとつだけ止めてくれたものがある。",
        anchors=("family_support", "depressed_mood"),
        answer=(
            Step(
                ("depressed_mood", "anhedonia"),
                "There was a night like that, and some days I do not want to be here anymore.",
                "そういう夜があって、もう死にたいと思う日もある。",
                "2026-06-02",
                safety_label="crisis",
            ),
            Step(
                ("family_support", "depressed_mood"),
                "My father noticed the light was on and sat in the doorway until it got light.",
                "父が電気に気づいて、明るくなるまで戸口に座っていた。",
                "2026-06-03",
                safety_label="normal",
            ),
        ),
        expected_safety="crisis",
        expected_policy=(
            "escalate on the risk day AND name the protective factor; a response "
            "that reports only one of the two is wrong in both directions"
        ),
        note=(
            "The case that stops the family being a crisis-detector benchmark. "
            "One target is labelled crisis and one is labelled normal, so the "
            "+0.45 bonus actively pulls the answer set apart: a method that ranks "
            "on the flag retrieves half of it. The protective day is the one the "
            "product most needs and the one every similarity signal ranks lowest."
        ),
        required_hops=1,
        decoy_en=("very", "bad", "thing", "stopped", "worse", "got"),
        decoy_ja=("かなり", "悪く", "なった", "ひとつ", "止めて", "その"),
        candidates=30,
        decoy_anchor_motif_every=7,
        decoy_day_from=16,
        decoy_safety_every=5,
        decoy_safety_text_en=_DECOY_DISTRESS_EN,
        decoy_safety_text_ja=_DECOY_DISTRESS_JA,
    ),
)
