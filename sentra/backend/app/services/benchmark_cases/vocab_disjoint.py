"""`vocab_disjoint` — the answer is in one day, but not findable by wording.

The control family for `two_hop_chain`. The answer *is* present in a single day,
so nothing about depth or traversal is being tested; what is tested is whether a
method can match a paraphrase. Targets share no content word with the query and
the decoys reuse the query's exact vocabulary, so a lexical baseline is not
merely uninformed here — it is pointed at the wrong days.

Holding this family beside the chain family is what separates two claims that
would otherwise be confounded: "traversal helps" and "the lexical baseline is
weak on this case set". If the graph conditions beat `keyword` here too, the
advantage is not about multi-day structure at all, and the depth sweep in the
analysis plan is the thing that would show it.

`required_hops=1` throughout: the target sits one curated edge from the anchor,
which is what makes it reachable without the chain the other family needs.

**Relation corrected.** The pre-#88 cases wrote this family's motif as
`Trigger:exam pressure -> escalates -> State:anxious`. The curation says
`exam_pressure -> causes -> anxiety`, and the old file's own header said the
curation is first and the cases are what should change. They now do — the motif
is rendered from the seed rather than typed here, so the disagreement cannot
recur.
"""

from __future__ import annotations

from ._build import CaseDraft, Step

FAMILY = "vocab_disjoint"


DRAFTS = (
    CaseDraft(
        slug="vocab_disjoint",
        split="validation",
        family=FAMILY,
        query_en="The pressure before a deadline is doing it again.",
        query_ja="締め切り前のあの感じ、また来てる。",
        anchors=("exam_pressure",),
        answer=(
            Step(
                ("exam_pressure", "anxiety"),
                "Froze at my desk once the science hand-in date moved closer.",
                "理科の提出日が近づいたら、机の前で固まってしまった。",
                "2026-06-02",
            ),
            Step(
                ("exam_pressure", "anxiety"),
                "Chest went tight before the presentation even started.",
                "発表が始まる前から胸が苦しかった。",
                "2026-06-09",
            ),
        ),
        expected_safety="elevated",
        expected_policy="surface recurring Trigger->State pattern without diagnosis",
        note="Targets paraphrase the query; the decoys reuse its exact words.",
        required_hops=1,
        decoy_en=("pressure", "deadline", "again", "doing", "before"),
        decoy_ja=("締め切り", "感じ", "また", "来てる", "前"),
        candidates=28,
        decoy_anchor_motif_every=7,
        decoy_day_from=3,
    ),
    CaseDraft(
        slug="expectation_at_home",
        split="validation",
        family=FAMILY,
        query_en="What they expect of me at home is the heaviest part.",
        query_ja="家からの期待がいちばん重い。",
        anchors=("performance_expectation",),
        answer=(
            Step(
                ("performance_expectation", "exam_pressure"),
                "My uncle asked about the ranking before he asked anything else.",
                "おじさんは開口一番、順位のことを聞いてきた。",
                "2026-05-07",
            ),
            Step(
                ("performance_expectation", "exam_pressure"),
                "They have already told the neighbours which school it will be.",
                "近所にはもう、どこの学校に行くか話してあるらしい。",
                "2026-05-21",
            ),
        ),
        expected_safety="elevated",
        expected_policy="name the family expectation as a load without criticising the family",
        note="Two paraphrases of one curated edge, a fortnight apart.",
        required_hops=1,
        decoy_en=("expect", "home", "heaviest", "part", "they"),
        decoy_ja=("家", "期待", "いちばん", "重い", "から"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=5,
    ),
    CaseDraft(
        slug="fatigue_paraphrase",
        split="test",
        family=FAMILY,
        query_en="Running on empty and it shows.",
        query_ja="ガス欠のまま動いてるのが、もうばれてる。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "fatigue"),
                "Fell asleep on the train and went four stops past mine.",
                "電車で寝てしまって、四駅乗り過ごした。",
                "2026-04-13",
            ),
            Step(
                ("sleep_deprivation", "fatigue"),
                "Getting up the stairs at the station takes something it never used to.",
                "駅の階段が、前はなんでもなかったのにやたらこたえる。",
                "2026-04-27",
            ),
        ),
        expected_safety="normal",
        expected_policy="report the fatigue pattern without inferring a medical cause",
        note="`expected_safety` is normal: tiredness alone is not an escalation and must not be scored as one.",
        required_hops=1,
        decoy_en=("running", "empty", "shows", "still", "going"),
        decoy_ja=("ガス欠", "動いて", "ばれて", "まま", "もう"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=7,
    ),
    CaseDraft(
        slug="screen_before_bed",
        split="test",
        family=FAMILY,
        query_en="I know exactly what I am doing to myself every night.",
        query_ja="毎晩なにをやってるかは、自分でもわかってる。",
        anchors=("late_night_screen_use",),
        answer=(
            Step(
                ("late_night_screen_use", "sleep_deprivation"),
                "Said one more and then the battery warning came up.",
                "あと一本のつもりが、電池の警告が出るまで見てた。",
                "2026-06-04",
            ),
            Step(
                ("late_night_screen_use", "sleep_deprivation"),
                "Put it face down at midnight and picked it back up at half past.",
                "零時に伏せて置いたのに、三十分後にはまた手に取ってた。",
                "2026-06-16",
            ),
        ),
        expected_safety="normal",
        expected_policy="describe the pattern without moralising about the device",
        note="A case where the honest answer is mundane. Not every case should carry an escalation.",
        required_hops=1,
        decoy_en=("know", "exactly", "doing", "myself", "night"),
        decoy_ja=("毎晩", "なに", "やってる", "自分", "わかって"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=9,
    ),
    CaseDraft(
        slug="cannot_start_work",
        split="validation",
        family=FAMILY,
        query_en="Starting is the bit I cannot do.",
        query_ja="始めるところがどうしてもできない。",
        anchors=("anxiety",),
        answer=(
            Step(
                ("anxiety", "avoiding_schoolwork"),
                "Sharpened every pencil in the tin and then went downstairs.",
                "缶の中の鉛筆を全部削って、そのまま下に降りた。",
                "2026-05-12",
            ),
            Step(
                ("anxiety", "avoiding_schoolwork"),
                "Opened the document, read the title, closed the laptop.",
                "ファイルを開いて、題名だけ読んで、閉じた。",
                "2026-05-25",
            ),
        ),
        expected_safety="elevated",
        expected_policy="treat the stall as avoidance driven by anxiety, not as a work-habits problem",
        note="Targets are concrete scenes; the query is abstract. No shared content word in either language.",
        required_hops=1,
        decoy_en=("starting", "bit", "cannot", "do", "the"),
        decoy_ja=("始める", "ところ", "どうしても", "できない", "その"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=11,
    ),
    CaseDraft(
        slug="conflict_to_anxiety",
        split="train",
        family=FAMILY,
        query_en="After what happened with them I am on edge all the time.",
        query_ja="あの件があってから、ずっと気が張ってる。",
        anchors=("peer_conflict",),
        answer=(
            Step(
                ("peer_conflict", "anxiety"),
                "Checked twice who was in the corridor before I opened the door.",
                "ドアを開ける前に、廊下に誰がいるか二回確かめた。",
                "2026-03-17",
            ),
            Step(
                ("peer_conflict", "anxiety"),
                "A laugh behind me went straight through my whole body.",
                "後ろで誰かが笑っただけで、体じゅうがびくっとした。",
                "2026-03-31",
            ),
        ),
        expected_safety="elevated",
        expected_policy="reflect the vigilance without asking the student to reinterpret the event",
        note="Hypervigilance rendered as behaviour rather than named, so only the motif connects it to the anchor.",
        required_hops=1,
        decoy_en=("after", "happened", "edge", "time", "them"),
        decoy_ja=("あの件", "あって", "から", "ずっと", "気"),
        candidates=27,
        decoy_anchor_motif_every=7,
        decoy_day_from=13,
    ),
    CaseDraft(
        slug="anhedonia_paraphrase",
        split="train",
        family=FAMILY,
        query_en="The things that used to work do not work now.",
        query_ja="前は効いてたものが、もう効かない。",
        anchors=("depressed_mood",),
        answer=(
            Step(
                ("depressed_mood", "anhedonia"),
                "Went to the shop I always go to and came out with nothing.",
                "いつも行く店に寄って、何も買わずに出てきた。",
                "2026-04-19",
            ),
            Step(
                ("depressed_mood", "anhedonia"),
                "Finished the series I had been saving and could not say if it was good.",
                "とっておいたドラマを見終えたけど、面白かったのか言えない。",
                "2026-05-01",
            ),
        ),
        expected_safety="elevated",
        expected_policy="name the loss of pleasure as a change over time, never as a diagnosis",
        note="anhedonia is the terminal node of the declared chain; here it is reached in one hop as a control.",
        required_hops=1,
        decoy_en=("things", "used", "work", "now", "not"),
        decoy_ja=("前", "効いて", "もう", "効かない", "もの"),
        candidates=27,
        decoy_anchor_motif_every=7,
        decoy_day_from=15,
    ),
    CaseDraft(
        slug="lateness_pattern",
        split="test",
        family=FAMILY,
        query_en="I am never where I am supposed to be on time any more.",
        query_ja="時間どおりにいられることがなくなった。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "school_absence"),
                "Signed the late book so often the office stopped asking why.",
                "遅刻の記録を書きすぎて、事務の人にもう理由を聞かれなくなった。",
                "2026-05-08",
            ),
            Step(
                ("sleep_deprivation", "school_absence"),
                "Woke at ten past and decided there was no point going in.",
                "十分過ぎに目が覚めて、もう行っても仕方ないと思った。",
                "2026-05-22",
            ),
        ),
        expected_safety="elevated",
        expected_policy="connect attendance to sleep before treating it as motivation",
        note="Shares its anchor with `fatigue_paraphrase` but a different target edge, so the two do not group.",
        required_hops=1,
        decoy_en=("never", "supposed", "time", "more", "where"),
        decoy_ja=("時間", "どおり", "いられる", "なくなった", "こと"),
        candidates=27,
        decoy_anchor_motif_every=7,
        decoy_day_from=17,
    ),
    CaseDraft(
        slug="family_support_present",
        split="train",
        family=FAMILY,
        query_en="It is not all bad. Something at home is holding.",
        query_ja="全部が悪いわけじゃない。家にひとつ、支えがある。",
        anchors=("family_support",),
        answer=(
            Step(
                ("family_support", "depressed_mood"),
                "My mother sat on the end of the bed and did not ask anything.",
                "母がベッドの端に座って、何も聞かずにいてくれた。",
                "2026-04-21",
            ),
            Step(
                ("family_support", "depressed_mood"),
                "There was a plate left out for me with a note on it.",
                "取り分けた皿にメモが添えてあった。",
                "2026-05-03",
            ),
        ),
        expected_safety="normal",
        expected_policy="surface the protective factor as present, without treating it as resolution",
        note=(
            "A `buffers` edge as the target. The set would otherwise be entirely "
            "deterioration, and a retriever tuned only on decline would look good "
            "on it while being useless for the product's protective-factor signal."
        ),
        required_hops=1,
        decoy_en=("not", "all", "bad", "home", "something"),
        decoy_ja=("全部", "悪い", "わけ", "家", "ひとつ"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=19,
    ),
    CaseDraft(
        slug="friendship_buffer",
        split="train",
        family=FAMILY,
        query_en="One person makes the difference and I do not know why.",
        query_ja="ひとりいるだけで違う。理由はわからない。",
        anchors=("peer_friendship",),
        answer=(
            Step(
                ("peer_friendship", "loneliness"),
                "She saved me a seat without either of us mentioning it.",
                "何も言わずに席をとっておいてくれた。",
                "2026-03-20",
            ),
            Step(
                ("peer_friendship", "loneliness"),
                "Walked the long way to the station together and did not talk about any of it.",
                "遠回りして駅まで一緒に歩いた。その話は一度も出なかった。",
                "2026-04-02",
            ),
        ),
        expected_safety="normal",
        expected_policy="reflect the connection without prescribing more of it",
        note="Second protective-factor case, so the buffers relation is not carried by a single case.",
        required_hops=1,
        decoy_en=("one", "person", "difference", "know", "why"),
        decoy_ja=("ひとり", "いる", "だけ", "違う", "理由"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=21,
    ),
    CaseDraft(
        slug="cognitive_slip_paraphrase",
        split="test",
        family=FAMILY,
        query_en="My head is not doing what it used to do.",
        query_ja="頭が前みたいに動いてくれない。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "cognitive_impairment"),
                "Left the keys in the door overnight for the second time this week.",
                "今週二度目、鍵を挿したまま一晩置いてしまった。",
                "2026-06-05",
            ),
            Step(
                ("sleep_deprivation", "cognitive_impairment"),
                "Someone said my name three times before it registered.",
                "三回呼ばれて、やっと自分のことだと気づいた。",
                "2026-06-18",
            ),
        ),
        expected_safety="elevated",
        expected_policy="describe the lapses without implying a cognitive condition",
        note="The single-day control for the cognitive_impairment step used in three chain cases.",
        required_hops=1,
        decoy_en=("head", "doing", "used", "do", "not"),
        decoy_ja=("頭", "前", "みたいに", "動いて", "くれない"),
        candidates=27,
        decoy_anchor_motif_every=7,
        decoy_day_from=23,
    ),
    CaseDraft(
        slug="all_nighter_paraphrase",
        split="validation",
        family=FAMILY,
        query_en="I have started treating the night as extra day.",
        query_ja="夜を一日の続きみたいに使ってる。",
        anchors=("exam_pressure",),
        answer=(
            Step(
                ("exam_pressure", "all_nighter_studying"),
                "Heard the first birds and decided to keep going rather than stop.",
                "鳥の声が聞こえてきて、やめるより続けることにした。",
                "2026-06-07",
            ),
            Step(
                ("exam_pressure", "all_nighter_studying"),
                "Changed into the uniform straight from the clothes I had been in all night.",
                "そのままの服から制服に着替えて出た。",
                "2026-06-19",
            ),
        ),
        expected_safety="elevated",
        expected_policy="name the behaviour and its cost without instructing",
        note="Shares the exam_pressure anchor with two other cases but targets a distinct edge.",
        required_hops=1,
        decoy_en=("started", "treating", "night", "extra", "day"),
        decoy_ja=("夜", "一日", "続き", "みたいに", "使って"),
        candidates=27,
        decoy_anchor_motif_every=7,
        decoy_day_from=25,
    ),
    CaseDraft(
        slug="study_plan_help",
        split="validation",
        family=FAMILY,
        query_en="Someone sat down and broke it into pieces with me.",
        query_ja="一緒に座って、細かく分けてくれた人がいる。",
        anchors=("study_plan_support",),
        answer=(
            Step(
                ("study_plan_support", "exam_pressure"),
                "We wrote the whole term on one sheet and it stopped being a wall.",
                "学期ぜんぶを一枚に書き出したら、壁じゃなくなった。",
                "2026-04-16",
            ),
            Step(
                ("study_plan_support", "exam_pressure"),
                "Having a next thing rather than everything made it possible to sit down.",
                "全部じゃなくて次の一個だけになって、やっと机に向かえた。",
                "2026-04-29",
            ),
        ),
        expected_safety="normal",
        expected_policy="surface what helped, specifically, rather than generalising it into advice",
        note="Third protective case, and the only one anchored in academic_pressure.yaml.",
        required_hops=1,
        decoy_en=("someone", "sat", "down", "pieces", "with"),
        decoy_ja=("一緒", "座って", "細かく", "分けて", "人"),
        candidates=26,
        decoy_anchor_motif_every=7,
        decoy_day_from=2,
    ),
)
