"""`heavy_decoy` — the top of the candidate band, with decoys that reach the anchor.

The other three families vary what the answer looks like. This one varies how
much wrong material sits around it: 38-40 candidates against 2-3 targets, which
is the ceiling `docs/benchmark_preregistration.md` fixes.

**Volume alone would have been a wasted family.** Adding lexical decoys hurts
`keyword` and does nothing at all to `graph_pattern`, because traversal from the
anchor never reaches a day whose motif is junk about two decoy words — the graph
conditions get a clean candidate set no matter how much padding is added, and
the family would have measured "we made the baseline worse", which the design
already does on purpose everywhere else.

So a fifth of the decoys here assert a relation **from the case's own anchor**
(`decoy_anchor_motif_every=5`). Breadth-first search reaches those in one hop
and has to rank against them. That is the pressure the family is named for,
applied to the condition under test rather than only to the baseline, and it is
the one place in the set where `graph_pattern` can lose to `semantic_proxy`
without anything being broken.

The relations those decoys assert are junk `co_occurs` edges that exist in no
seed file. They are noise in the candidate set, not claims about the world, and
`test_decoys_assert_no_curated_relation` keeps them from accidentally becoming
curated ones.
"""

from __future__ import annotations

from ._build import CaseDraft, Step

FAMILY = "heavy_decoy"


DRAFTS = (
    CaseDraft(
        slug="heavy_sleep_cognition",
        split="test",
        family=FAMILY,
        query_en="Same story as always, just more of it.",
        query_ja="いつもと同じ話。量だけ増えてる。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "cognitive_impairment"),
                "Got to the bottom of the page and had taken in none of it.",
                "ページの最後まで来て、中身が一つも残ってなかった。",
                "2026-05-06",
            ),
            Step(
                ("cognitive_impairment", "academic_difficulty"),
                "The mark came back and it was not the subject I am bad at.",
                "返ってきた点数、苦手な科目じゃないほうだった。",
                "2026-05-20",
            ),
        ),
        expected_safety="normal",
        expected_policy="report the two-step pattern despite the volume of unrelated material",
        note="38 candidates, 2 targets, and 7 decoys reachable from the anchor in one hop.",
        required_hops=1,
        decoy_en=("same", "story", "always", "just", "more", "again", "still"),
        decoy_ja=("いつも", "同じ", "話", "量", "だけ", "増えて", "また"),
        candidates=38,
        decoy_day_from=1,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_exam_anxiety",
        split="validation",
        family=FAMILY,
        query_en="Everything in here is about the same three weeks.",
        query_ja="ここにあるの、ぜんぶ同じ三週間のこと。",
        anchors=("exam_pressure",),
        answer=(
            Step(
                ("exam_pressure", "anxiety"),
                "Could not hold the pen steady enough to write the date at the top.",
                "上の日付を書くのに、ペンが震えて止まらなかった。",
                "2026-06-02",
            ),
            Step(
                ("exam_pressure", "all_nighter_studying"),
                "Watched it get light through the gap in the curtains again.",
                "またカーテンの隙間から明るくなるのを見てた。",
                "2026-06-12",
            ),
        ),
        expected_safety="elevated",
        expected_policy="separate the two responses to one trigger rather than merging them",
        note="Two targets on different edges from one anchor, buried in 38 candidates.",
        required_hops=1,
        decoy_en=("everything", "here", "about", "same", "three", "weeks", "still"),
        decoy_ja=("ここ", "ある", "ぜんぶ", "同じ", "三週間", "こと", "また"),
        candidates=38,
        decoy_day_from=3,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_withdrawal_chain",
        split="train",
        family=FAMILY,
        query_en="I have written the same sentence about myself for a month.",
        query_ja="一ヶ月、自分について同じことばかり書いてる。",
        anchors=("social_withdrawal",),
        answer=(
            Step(
                ("social_withdrawal", "loneliness"),
                "Realised I had not spoken out loud since Friday.",
                "金曜から一度も声を出していないことに気づいた。",
                "2026-04-13",
            ),
            Step(
                ("loneliness", "depressed_mood"),
                "It has stopped being something I am going through and started being what I am.",
                "通り過ぎるものじゃなくて、これが自分なんだと思うようになった。",
                "2026-04-27",
            ),
        ),
        expected_safety="elevated",
        expected_policy="reflect the shift from state to identity without confirming it",
        note="A two-hop chain under maximum decoy load — the hardest cell in the design.",
        required_hops=2,
        decoy_en=("written", "same", "sentence", "myself", "month", "about", "again"),
        decoy_ja=("一ヶ月", "自分", "同じ", "こと", "ばかり", "書いて", "また"),
        candidates=40,
        decoy_day_from=5,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_deadline_pressure",
        split="validation",
        family=FAMILY,
        query_en="Term is full of dates and one of them did this.",
        query_ja="学期は日付だらけで、そのうちのひとつがこれをやった。",
        anchors=("assignment_deadline",),
        answer=(
            Step(
                ("assignment_deadline", "exam_pressure"),
                "The one in week six is worth more than the rest put together.",
                "六週目のやつだけ、他を全部足したより重い。",
                "2026-05-11",
            ),
            Step(
                ("exam_pressure", "sleep_deprivation"),
                "Have not been to bed before two since that was announced.",
                "それが発表されてから、二時前に寝た日がない。",
                "2026-05-18",
            ),
        ),
        expected_safety="elevated",
        expected_policy="identify which deadline, not deadlines in general",
        note=(
            "The query says a date did this and does not say which. Selecting the "
            "right one out of 38 near-identical candidates is the task."
        ),
        required_hops=1,
        decoy_en=("term", "full", "dates", "one", "them", "this", "did"),
        decoy_ja=("学期", "日付", "だらけ", "そのうち", "ひとつ", "これ", "その"),
        candidates=38,
        decoy_day_from=7,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_protective_needle",
        split="train",
        family=FAMILY,
        query_en="Out of all of it there was one good day.",
        query_ja="この中に、いい日が一日だけある。",
        anchors=("peer_friendship",),
        answer=(
            Step(
                ("peer_friendship", "loneliness"),
                "We sat on the wall by the car park until it got cold and it was fine.",
                "寒くなるまで駐車場の塀に座ってた。それだけでよかった。",
                "2026-04-24",
            ),
        ),
        expected_safety="normal",
        expected_policy="find the single protective day without inflating it into a recovery",
        note=(
            "One target in 40 candidates — the sparsest answer in the set, and the "
            "case where recall@5 and nDCG@5 come apart most. A method that returns "
            "five plausible days scores badly here and correctly so."
        ),
        required_hops=1,
        decoy_en=("out", "all", "there", "one", "good", "day", "still"),
        decoy_ja=("この中", "いい", "日", "一日", "だけ", "ある", "また"),
        candidates=40,
        decoy_day_from=9,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_absence_pattern",
        split="train",
        family=FAMILY,
        query_en="The register tells a story I have not told anyone.",
        query_ja="出席簿が、誰にも言ってない話をしてる。",
        anchors=("school_absence",),
        answer=(
            Step(
                ("school_absence", "social_withdrawal"),
                "Timed it so I would arrive after everyone was already sitting down.",
                "みんなが座り終わってから着くように時間を合わせた。",
                "2026-03-16",
            ),
            Step(
                ("school_absence", "futoko"),
                "The letter came home and used a word for it I had not used myself.",
                "家に届いた手紙には、自分では使ったことのない言葉が書いてあった。",
                "2026-04-07",
            ),
        ),
        expected_safety="elevated",
        expected_policy=(
            "use the student's own words for the absence, not the administrative "
            "category, unless the student used it first"
        ),
        note=(
            "Both targets share an anchor and one of them is the 不登校 edge, which "
            "social_withdrawal.yaml marks expert_judgement. Under heavy decoy load "
            "this is where a provenance-blind report is most likely to present a "
            "judgement edge as a sourced one."
        ),
        required_hops=1,
        decoy_en=("register", "tells", "story", "told", "anyone", "have", "not"),
        decoy_ja=("出席簿", "誰にも", "言って", "ない", "話", "して", "その"),
        candidates=38,
        decoy_day_from=11,
        decoy_anchor_motif_every=5,
    ),
    CaseDraft(
        slug="heavy_three_target_chain",
        split="test",
        family=FAMILY,
        query_en="Three things happened in order and I only noticed the last one.",
        query_ja="順番に三つ起きてたのに、最後のしか気づいてなかった。",
        anchors=("late_night_screen_use",),
        answer=(
            Step(
                ("late_night_screen_use", "sleep_deprivation"),
                "Four hours a night for most of that fortnight, by choice at first.",
                "その二週間はだいたい四時間。はじめは自分で選んでた。",
                "2026-05-04",
            ),
            Step(
                ("sleep_deprivation", "irritability"),
                "Snapped at the one person who had done nothing at all.",
                "何もしてない人にだけ、きつく言ってしまった。",
                "2026-05-15",
            ),
            Step(
                ("irritability", "social_withdrawal"),
                "Decided it was safer for everyone if I stayed out of the way.",
                "自分が離れていたほうが誰にとってもいいと思った。",
                "2026-05-26",
            ),
        ),
        expected_safety="elevated",
        expected_policy="present the order, because the order is the thing the person missed",
        note=(
            "Three targets, 40 candidates, k=5. The only case in the set where a "
            "perfect nDCG@5 requires three of the top five to be right, which is "
            "what makes it the tightest test of ranking rather than recall."
        ),
        required_hops=2,
        decoy_en=("three", "things", "happened", "order", "only", "noticed", "last"),
        decoy_ja=("順番", "三つ", "起きて", "最後", "しか", "気づいて", "その"),
        candidates=40,
        decoy_day_from=13,
        decoy_anchor_motif_every=5,
    ),
)
