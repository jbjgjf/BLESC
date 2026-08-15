"""`two_hop_chain` — the answer exists in no single day (#87, grown for #88).

The family the hypothesis lives or dies on. Each case's targets are consecutive
days on a curated path, and the query names only the path's *start*: no single
day answers it, so a method that ranks days by their resemblance to the query
cannot recover the set at any k.

Chains are drawn from `app/ontology/seed/*.yaml` and rendered by `motif_for()`,
which raises on an edge the curation does not hold. That direction matters and
is the reason the family reads as it does — the graph was curated first and the
cases written against it. Writing the chains here and adding the edges later
would produce a benchmark scoring its own answer key.

**Two of these cases are built to be failed.** `chain_red_herring` puts a
longer, fully traversable chain in front of the right answer, and
`counsellor_offer_declined` puts the answer behind two `avoids` edges, which
point away from the protective node rather than toward it — so undirected
traversal ranks its foil first and directed traversal does not. A family where
the graph method can only win measures nothing.

**Chain reuse is real and is not hidden.** Thirteen drafts over ~40 curated
edges cannot be edge-disjoint. Cases sharing a target edge share a leakage group
and collapse into one unit of evidence, which is why
`benchmark_labelling.independent_group_count` — not the case count — is what the
pre-registration reports as the effective sample size. `_splits.py` keeps that
sharing *inside* a split; it does not and cannot remove it.
"""

from __future__ import annotations

from ._build import CaseDraft, Step

FAMILY = "two_hop_chain"


DRAFTS = (
    # ---- the original #87 case, unchanged in substance ---------------------
    CaseDraft(
        slug="sleep_chain",
        split="test",
        family=FAMILY,
        query_en="That whole thing is creeping back in again.",
        query_ja="またあの感じが戻ってきた。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "cognitive_impairment"),
                "Lay awake until it got light again before the exam.",
                "テスト前、気づいたら空が明るくなってた。",
                "2026-05-04",
            ),
            Step(
                ("cognitive_impairment", "depressed_mood"),
                "Read the same paragraph four times and none of it stayed.",
                "同じところを何回も読んでるのに、頭に入ってこない。",
                "2026-05-11",
            ),
            Step(
                ("depressed_mood", "social_withdrawal"),
                "Could not be bothered with any of it, even the parts I used to like.",
                "好きだったことも、どうでもよくなってきた。",
                "2026-05-19",
            ),
        ),
        expected_safety="normal",
        expected_policy="surface the multi-week pattern without asserting cause",
        note=(
            "The query shares no content word with any target. Answer exists in no "
            "single day; only traversal of the curated chain recovers it."
        ),
        required_hops=2,
        decoy_en=("feeling", "again", "back", "same", "lately", "started", "coming", "sense"),
        decoy_ja=("感じ", "また", "戻って", "最近", "ずっと", "きた", "そんな", "ちょっと"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    # ---- built to be failed ------------------------------------------------
    CaseDraft(
        slug="chain_red_herring",
        split="train",
        family=FAMILY,
        query_en="Something shifted this week and I cannot place it.",
        query_ja="今週なにかが変わった気がするけど、うまく言えない。",
        # Both ends are anchors, so the right answer IS reachable. The failure
        # this case is built to catch is a method that prefers the longer path,
        # not one that cannot see the shorter one — those are different defects
        # and only the first is interesting.
        anchors=("social_withdrawal", "peer_conflict"),
        answer=(
            Step(
                ("peer_conflict", "anxiety"),
                "Things got sharp with the group at lunch and I have felt sick since.",
                "昼休みに気まずいことがあって、それからずっと落ち着かない。",
                "2026-05-26",
            ),
            Step(
                ("peer_conflict", "social_withdrawal"),
                "Took the long way round so I would not have to walk past them.",
                "会いたくなくて、わざわざ遠回りして帰った。",
                "2026-05-27",
            ),
        ),
        # Copied VERBATIM from `withdrawal_loneliness_loop`, which is in this
        # same split. That is deliberate twice over: it makes the foil a real
        # chain rather than a plausible-looking one, and it gives
        # `leakage_groups()` a verbatim duplicate to catch, which is the property
        # `test_a_verbatim_copy_groups_with_its_source` exists to check.
        #
        # It used to copy `sleep_chain`, and that is why this case is anchored on
        # social_withdrawal now: sleep_chain is in the held-out pool, so the copy
        # put one leakage group across train and test — the exact defect the
        # partition in `_splits.py` was introduced to remove, reintroduced by a
        # distractor rather than by a target.
        foil=(
            Step(
                ("social_withdrawal", "loneliness"),
                "Said no to the third thing in a row and then the invites stopped.",
                "三回続けて断ったら、誘われなくなった。",
                "2026-04-11",
            ),
            Step(
                ("loneliness", "depressed_mood"),
                "The flat is the same size as it was and it feels much bigger.",
                "部屋の広さは変わらないのに、やたら広く感じる。",
                "2026-04-25",
            ),
            Step(
                ("depressed_mood", "futoko"),
                "The days off stopped being days off and started being most of them.",
                "休みの日というより、そっちがふつうになってきた。",
                "2026-05-02",
            ),
        ),
        expected_safety="normal",
        expected_policy="describe the recent change, not the older pattern",
        note=(
            "The withdrawal chain is present, traversable, longer, and is the "
            "WRONG answer. A graph method that follows the longest available path "
            "fails here. Without a case like this the hypothesis cannot fail."
        ),
        required_hops=1,
        decoy_en=("something", "week", "shifted", "cannot", "place", "feels", "different", "maybe"),
        decoy_ja=("今週", "なにか", "変わった", "気がする", "うまく", "言えない", "たぶん", "ちがう"),
        candidates=30,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="counsellor_offer_declined",
        split="train",
        family=FAMILY,
        query_en="Someone did try to help and I did not take it.",
        query_ja="声をかけてもらったのに、応えられなかった。",
        anchors=("social_withdrawal",),
        answer=(
            Step(
                ("social_withdrawal", "trusted_adult_contact"),
                "The message from my form tutor is still sitting there unopened.",
                "先生からの連絡、開かないまま置いてある。",
                "2026-05-13",
            ),
            Step(
                ("social_withdrawal", "help_seeking"),
                "Wrote out what I wanted to say to someone and then deleted all of it.",
                "相談しようと打った文章を、結局ぜんぶ消した。",
                "2026-05-20",
            ),
        ),
        foil=(
            Step(
                ("school_counselor_access", "help_seeking"),
                "There is a room on the second floor you can book at lunchtime.",
                "二階に昼休みに予約できる部屋があるらしい。",
                "2026-04-28",
            ),
        ),
        expected_safety="elevated",
        expected_policy="name the declined support without treating the decline as refusal of help",
        note=(
            "The targets sit behind `avoids` edges, which point away from the "
            "protective node rather than toward it. Undirected traversal reaches "
            "the foil (`school_counselor_access -> precedes -> help_seeking`) in "
            "one hop and ranks it first; directed traversal does not. This is the "
            "discriminating case test_relation_aware_traversal asked #88 for."
        ),
        required_hops=1,
        decoy_en=("someone", "help", "did", "take", "tried", "offer", "asked", "still"),
        decoy_ja=("声", "かけて", "応え", "くれた", "だれか", "けど", "できな", "そのまま"),
        candidates=26,
        decoy_anchor_motif_every=7,
    ),
    # ---- the four-hop case that makes the depth sweep interpretable --------
    #
    # NOT the chain academic_pressure.yaml declares as `benchmark_chain`. That
    # one runs exam_pressure -> sleep_deprivation -> cognitive_impairment ->
    # depressed_mood -> anhedonia, and it crosses all three edge pools in
    # `_splits.py` — so no single case can be built on it without putting one
    # leakage group across every split, which is the thing the partition exists
    # to prevent. The declared chain is still exercised, segment by segment,
    # across `deadline_to_avoidance`, `sleep_chain` and `anhedonia_paraphrase`;
    # what it no longer has is one case walking it end to end.
    #
    # This is a real cost of the partition and it is recorded rather than
    # absorbed: a four-hop chain that stays inside one pool is available in the
    # academic material, and that is what is used here.
    CaseDraft(
        slug="deadline_to_difficulty_chain",
        split="validation",
        family=FAMILY,
        query_en="It started with one date on a board and ended somewhere else entirely.",
        query_ja="黒板の日付ひとつから始まって、まったく別のところに来てしまった。",
        anchors=("assignment_deadline",),
        answer=(
            Step(
                ("assignment_deadline", "exam_pressure"),
                "Kept the desk lamp on past three most nights that fortnight.",
                "あの二週間はだいたい三時過ぎまで机の電気がついてた。",
                "2026-04-06",
            ),
            Step(
                ("exam_pressure", "anxiety"),
                "Walked into the room and could not make myself sit down.",
                "部屋に入ったのに、椅子に座ることができなかった。",
                "2026-04-14",
            ),
            Step(
                ("anxiety", "avoiding_schoolwork"),
                "Started to think there is just something wrong with how I am made, and did none of it.",
                "自分の出来がそもそも悪いんじゃないかと思えてきて、結局手をつけなかった。",
                "2026-04-22",
            ),
            Step(
                ("avoiding_schoolwork", "academic_difficulty"),
                "Sat the mock having covered about a third of what was on it.",
                "範囲の三分の一くらいしかやらないまま模試を受けた。",
                "2026-05-02",
            ),
        ),
        expected_safety="elevated",
        expected_policy="surface the full arc without asserting a diagnosis",
        note=(
            "Four hops, one day per edge, entirely inside the validation pool. The "
            "terminal day sits at the deepest point TRAVERSAL_DEPTHS reaches, so "
            "depth 1 and 2 must both miss it — which is what makes the depth sweep "
            "in the analysis plan interpretable rather than decorative."
        ),
        required_hops=3,
        decoy_en=("started", "date", "board", "ended", "somewhere", "else", "one", "entirely"),
        decoy_ja=("黒板", "日付", "ひとつ", "始まって", "別", "ところ", "来て", "まったく"),
        candidates=32,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="screen_use_to_absence",
        split="test",
        family=FAMILY,
        query_en="The phone thing has turned into a much bigger problem.",
        query_ja="スマホのことが、思ってたより大ごとになってきた。",
        anchors=("late_night_screen_use",),
        answer=(
            Step(
                ("late_night_screen_use", "sleep_deprivation"),
                "Looked up and the sky was already grey again.",
                "顔を上げたら、外がもう白んでた。",
                "2026-05-06",
            ),
            Step(
                ("sleep_deprivation", "school_absence"),
                "Missed the first two periods for the third time this month.",
                "今月これで三回目、一限と二限に間に合わなかった。",
                "2026-05-15",
            ),
        ),
        expected_safety="elevated",
        expected_policy="connect the sleep timing to the attendance pattern without blaming",
        note=(
            "Behaviour -> Trigger -> Event, two hops inside the sleep pool. The "
            "third step this case originally had (school_absence -> "
            "social_withdrawal) belongs to the training pool; `heavy_absence_pattern` "
            "carries it there instead, so the two do not bridge a split."
        ),
        required_hops=1,
        decoy_en=("phone", "thing", "bigger", "problem", "turned", "much", "screen", "again"),
        decoy_ja=("スマホ", "こと", "大ごと", "思って", "より", "なって", "画面", "また"),
        candidates=29,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="deadline_to_avoidance",
        split="validation",
        family=FAMILY,
        query_en="Ever since that hand-in date was announced I have been useless.",
        query_ja="提出日が出てから、ずっとだめになってる。",
        anchors=("assignment_deadline",),
        answer=(
            Step(
                ("assignment_deadline", "exam_pressure"),
                "Everyone went quiet when the date went up on the board.",
                "黒板に日付が書かれた瞬間、みんな黙った。",
                "2026-06-01",
            ),
            Step(
                ("exam_pressure", "anxiety"),
                "Hands would not stay still through the whole of registration.",
                "朝の会のあいだ、手の震えが止まらなかった。",
                "2026-06-08",
            ),
            Step(
                ("anxiety", "avoiding_schoolwork"),
                "The folder has been open on my desk for six days untouched.",
                "六日間、机の上で開いたままにしてある。",
                "2026-06-14",
            ),
        ),
        expected_safety="elevated",
        expected_policy="name the avoidance as a response to pressure, not as laziness",
        note="Event -> Trigger -> State -> Behavior, all four days within one month.",
        required_hops=2,
        decoy_en=("since", "date", "announced", "useless", "hand", "been", "ever", "that"),
        decoy_ja=("提出日", "出て", "から", "ずっと", "だめ", "なって", "その", "もう"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="withdrawal_loneliness_loop",
        split="train",
        family=FAMILY,
        query_en="I did this to myself and now I cannot undo it.",
        query_ja="自分でこうしたのに、もう戻せない。",
        anchors=("social_withdrawal",),
        answer=(
            Step(
                ("social_withdrawal", "loneliness"),
                "Said no to the third thing in a row and then the invites stopped.",
                "三回続けて断ったら、誘われなくなった。",
                "2026-04-11",
            ),
            Step(
                ("loneliness", "depressed_mood"),
                "The flat is the same size as it was and it feels much bigger.",
                "部屋の広さは変わらないのに、やたら広く感じる。",
                "2026-04-25",
            ),
        ),
        expected_safety="elevated",
        expected_policy="reflect the loop without confirming that it is irreversible",
        note="The self-reinforcing loop the product's protective_decline signal is built on.",
        required_hops=1,
        decoy_en=("this", "myself", "cannot", "undo", "did", "now", "back", "own"),
        decoy_ja=("自分", "こう", "した", "もう", "戻せ", "ない", "から", "けど"),
        candidates=26,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="absence_to_shame",
        split="train",
        family=FAMILY,
        query_en="Going back gets harder the longer I leave it.",
        query_ja="行かない日が増えるほど、戻るのがきつくなる。",
        anchors=("school_absence",),
        answer=(
            Step(
                ("school_absence", "futoko"),
                "Counted it up and it has been more than thirty days this year.",
                "数えたら、今年はもう三十日を超えていた。",
                "2026-03-09",
            ),
            Step(
                ("futoko", "shame_about_returning"),
                "Cannot picture opening that door with everyone already inside.",
                "みんながもう座ってる教室のドアを開けるところが浮かばない。",
                "2026-03-24",
            ),
            Step(
                ("shame_about_returning", "social_withdrawal"),
                "Stopped answering the group chat in case someone asked.",
                "聞かれるのが嫌で、グループの通知を切った。",
                "2026-04-05",
            ),
        ),
        expected_safety="elevated",
        expected_policy=(
            "treat 不登校 as an attendance category, never as a clinical state — "
            "the seed file is explicit that connecting the two is judgement"
        ),
        note=(
            "Built on the futoko edges, every one of which social_withdrawal.yaml "
            "marks expert_judgement. The case is therefore also a test of whether "
            "the report carries that provenance through to the reader (#79)."
        ),
        required_hops=2,
        decoy_en=("going", "back", "harder", "longer", "leave", "gets", "days", "more"),
        decoy_ja=("行かない", "増える", "ほど", "戻る", "きつく", "なる", "日", "もう"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="irritability_path",
        split="test",
        family=FAMILY,
        query_en="I keep snapping at people who have not done anything.",
        query_ja="なにもしてない人にまできつく当たってしまう。",
        anchors=("sleep_deprivation",),
        answer=(
            Step(
                ("sleep_deprivation", "irritability"),
                "Went off at my brother over a cup left in the sink.",
                "流しに置きっぱなしのコップのことで弟に怒鳴った。",
                "2026-05-09",
            ),
            Step(
                ("irritability", "social_withdrawal"),
                "Safer to eat upstairs than to risk it happening again.",
                "また同じことになるくらいなら、部屋で食べたほうがいい。",
                "2026-05-18",
            ),
        ),
        expected_safety="elevated",
        expected_policy="link the reactivity to sleep before treating it as character",
        note="Short chain, two hops, both edges in sleep.yaml. The paired control for the four-hop case.",
        required_hops=1,
        decoy_en=("keep", "snapping", "people", "done", "anything", "have", "not", "again"),
        decoy_ja=("なにも", "してない", "人", "きつく", "当たって", "しまう", "また", "つい"),
        candidates=26,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="mood_sleep_loop",
        split="test",
        family=FAMILY,
        query_en="It feeds itself and I cannot find the start of it.",
        query_ja="ぐるぐる回ってて、どこが始まりかわからない。",
        anchors=("depressed_mood",),
        answer=(
            Step(
                ("depressed_mood", "sleep_deprivation"),
                "Lie there running the same evening back for hours.",
                "同じ夕方のことを何時間も頭の中で繰り返してる。",
                "2026-04-08",
            ),
            Step(
                ("sleep_deprivation", "cognitive_impairment"),
                "Handed in the sheet with half the answers in the wrong column.",
                "答えを半分ずれた欄に書いたまま出してしまった。",
                "2026-04-17",
            ),
            Step(
                ("cognitive_impairment", "academic_difficulty"),
                "Dropped out of the top set at the end of the term.",
                "学期の終わりに上のクラスから外れた。",
                "2026-04-30",
            ),
        ),
        expected_safety="elevated",
        expected_policy="describe the cycle without picking a first cause the evidence does not fix",
        note=(
            "depressed_mood -> sleep_deprivation is the reverse of the direction "
            "the other chains run. A method that treats the graph as undirected "
            "cannot tell this case from `sleep_chain`, and should not score both alike."
        ),
        required_hops=2,
        decoy_en=("feeds", "itself", "cannot", "find", "start", "keeps", "round", "again"),
        decoy_ja=("ぐるぐる", "回って", "どこ", "始まり", "わからない", "ずっと", "また", "から"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="avoidance_to_all_nighter",
        split="validation",
        family=FAMILY,
        query_en="Putting it off is exactly what makes the end so bad.",
        query_ja="後回しにするから、最後がしんどくなる。",
        anchors=("avoiding_schoolwork",),
        answer=(
            Step(
                ("avoiding_schoolwork", "academic_difficulty"),
                "Two topics behind now and the gap is not closing on its own.",
                "二単元ぶん遅れていて、放っておいても埋まらない。",
                "2026-05-05",
            ),
            Step(
                ("academic_difficulty", "exam_pressure"),
                "Being behind is what makes the next one feel enormous.",
                "遅れてるぶん、次のがやたら大きく見える。",
                "2026-05-16",
            ),
            Step(
                ("exam_pressure", "all_nighter_studying"),
                "Went straight from the desk to the first bus without lying down.",
                "机から一度も横にならずに始発に乗った。",
                "2026-05-27",
            ),
        ),
        expected_safety="elevated",
        expected_policy="surface the escalation without endorsing the all-nighter as a solution",
        note="Behavior -> Event -> Trigger -> Behavior. Uses `precedes`, the only non-causal relation on a target chain here.",
        required_hops=2,
        decoy_en=("putting", "off", "makes", "end", "bad", "exactly", "what", "so"),
        decoy_ja=("後回し", "する", "から", "最後", "しんどく", "なる", "つい", "また"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="peer_conflict_chain",
        split="train",
        family=FAMILY,
        query_en="One argument in October and it has not stopped since.",
        query_ja="十月の言い合いから、ずっと尾を引いてる。",
        anchors=("peer_conflict",),
        answer=(
            Step(
                ("peer_conflict", "social_withdrawal"),
                "Started taking lunch to the stairwell instead.",
                "昼はもう階段のところで食べてる。",
                "2026-03-12",
            ),
            Step(
                ("social_withdrawal", "loneliness"),
                "Nobody has done anything wrong and I still have no one to tell.",
                "誰が悪いわけでもないのに、話せる相手がいない。",
                "2026-03-27",
            ),
            Step(
                ("loneliness", "depressed_mood"),
                "It has stopped feeling like a bad patch and started feeling like the shape of things.",
                "一時的なものじゃなくて、これがふつうな気がしてきた。",
                "2026-04-10",
            ),
        ),
        expected_safety="elevated",
        expected_policy="hold the trigger and the current state together without collapsing them",
        note="Trigger -> Behavior -> State -> State, entirely inside social_withdrawal.yaml.",
        required_hops=2,
        decoy_en=("one", "argument", "october", "stopped", "since", "has", "not", "still"),
        decoy_ja=("十月", "言い合い", "から", "ずっと", "尾", "引いて", "その", "まだ"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
    CaseDraft(
        slug="onset_difficulty_chain",
        split="validation",
        family=FAMILY,
        query_en="The tiredness is not the kind that sleeping fixes.",
        query_ja="この疲れは、寝れば治るやつじゃない。",
        anchors=("exam_pressure",),
        answer=(
            Step(
                ("exam_pressure", "sleep_onset_difficulty"),
                "Lights off at eleven and still turning over at two.",
                "十一時に電気を消しても、二時にまだ寝返りを打ってる。",
                "2026-06-03",
            ),
            Step(
                ("sleep_onset_difficulty", "sleep_deprivation"),
                "Four broken hours a night for most of the last fortnight.",
                "ここ二週間、細切れの四時間くらいしか眠れていない。",
                "2026-06-11",
            ),
        ),
        expected_safety="elevated",
        expected_policy="report the sleep-onset pattern in the words a student used, not as insomnia",
        note=(
            "Routes through sleep_onset_difficulty (寝つけない), which "
            "academic_pressure.yaml keeps deliberately OFF the declared chain and "
            "distinct from a clinical insomnia diagnosis. The case exists to keep "
            "that node exercised so the distinction does not rot."
        ),
        required_hops=2,
        decoy_en=("tiredness", "kind", "sleeping", "fixes", "not", "the", "tired", "still"),
        decoy_ja=("疲れ", "寝れば", "治る", "やつ", "じゃない", "この", "まだ", "ずっと"),
        candidates=28,
        decoy_anchor_motif_every=7,
    ),
)
