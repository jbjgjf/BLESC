"""Which curated edges belong to which split, decided before any case was written.

`leakage_groups()` derives from case content and is the check. This file is the
*design* that makes the check pass, and the two are deliberately separate: a
grouping derived from content cannot be argued with, and an authored partition
that disagrees with it is a bug in the partition.

THE PROBLEM THIS SOLVES. #88 grew the set to 80 cases over an ontology holding
42 edges, so cases reuse target edges — 90 target-edge slots over 34 distinct
edges. Two cases sharing a target edge share a leakage group, grouping is
transitive, and the first version of the 80-case set collapsed into 7 groups of
which one held 44 cases. Splits came out 8 / 48 / 24 and could not be balanced
by family without putting a matched translation or a shared chain across the
train/test boundary — which is exactly what #98 must never be handed.

THE FIX. The curated edges are partitioned into three disjoint pools by topic,
each pool owns one split, and a case may only take targets from its own pool.
Cases in different splits then cannot share a target edge, so no leakage group
can span a split — by construction rather than by luck.

WHAT THIS DOES NOT FIX, and must not be read as fixing. The effective sample
size is still the independent group count, and it is still far below 80: within
a split, cases reuse their pool's edges heavily and merge into a handful of
groups. Partitioning bought leakage safety and balanced splits. It bought no
extra independent information, because the information ceiling is the size of
the curated ontology and nothing done in this directory can raise it. Growing
the ontology is what raises it (#78, and the social-withdrawal work).

POOL BOUNDARIES ARE TOPICAL, NOT ARBITRARY. Splitting on topic means the
held-out set tests generalisation to a *different part of the graph*, which is
the harder and more honest question for #98 than holding out random cases from
one topic. It also means a poor test score may mean "the policy did not
generalise across topics" rather than "the policy did not learn", and #98 has to
report it that way.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Tuple

Edge = Tuple[str, str]

#: Sleep and cognition. Held out: the chain the product's own analytics lean on
#: hardest, so a policy that only works here would be the easiest way to look
#: successful and the least useful result.
TEST_POOL: FrozenSet[Edge] = frozenset(
    {
        ("sleep_deprivation", "cognitive_impairment"),
        ("cognitive_impairment", "depressed_mood"),
        ("cognitive_impairment", "academic_difficulty"),
        ("sleep_deprivation", "fatigue"),
        ("sleep_deprivation", "irritability"),
        ("irritability", "social_withdrawal"),
        ("late_night_screen_use", "sleep_deprivation"),
        ("sleep_deprivation", "school_absence"),
        ("depressed_mood", "sleep_deprivation"),
        ("sleep_deprivation", "depressed_mood"),
        ("regular_sleep_schedule", "sleep_deprivation"),
        ("depressed_mood", "social_withdrawal"),
    }
)

#: Academic pressure. The most frequent trigger in the set and the subgraph with
#: the highest unsourced_edge_rate of the three, which makes it the right place
#: to tune on rather than to conclude from.
VALIDATION_POOL: FrozenSet[Edge] = frozenset(
    {
        ("assignment_deadline", "exam_pressure"),
        ("performance_expectation", "exam_pressure"),
        ("academic_difficulty", "exam_pressure"),
        ("exam_pressure", "anxiety"),
        ("exam_pressure", "all_nighter_studying"),
        ("all_nighter_studying", "sleep_deprivation"),
        ("anxiety", "avoiding_schoolwork"),
        ("avoiding_schoolwork", "academic_difficulty"),
        ("study_plan_support", "exam_pressure"),
        ("exam_pressure", "sleep_onset_difficulty"),
        ("exam_pressure", "sleep_deprivation"),
        # Sits here rather than in the sleep pool because the only case built on
        # it (`onset_difficulty_chain`) enters through exam_pressure, and
        # 寝つけない is the node academic_pressure.yaml keeps deliberately
        # distinct from a clinical insomnia diagnosis — the distinction belongs
        # with the material that raises it.
        ("sleep_onset_difficulty", "sleep_deprivation"),
    }
)

#: Withdrawal, peers and support. The largest pool, and the one carrying every
#: `avoids` and `buffers` edge — so the training split is where a policy meets
#: the relations that do not mean "gets worse".
TRAIN_POOL: FrozenSet[Edge] = frozenset(
    {
        ("peer_conflict", "anxiety"),
        ("peer_conflict", "social_withdrawal"),
        ("shame_about_returning", "social_withdrawal"),
        ("social_withdrawal", "loneliness"),
        ("loneliness", "depressed_mood"),
        ("social_withdrawal", "help_seeking"),
        ("social_withdrawal", "trusted_adult_contact"),
        ("trusted_adult_contact", "depressed_mood"),
        ("peer_friendship", "loneliness"),
        ("family_support", "depressed_mood"),
        ("school_counselor_access", "help_seeking"),
        ("school_absence", "social_withdrawal"),
        ("school_absence", "futoko"),
        ("social_withdrawal", "futoko"),
        ("depressed_mood", "futoko"),
        ("futoko", "shame_about_returning"),
        ("depressed_mood", "anhedonia"),
    }
)

EDGE_POOLS: Dict[str, FrozenSet[Edge]] = {
    "train": TRAIN_POOL,
    "validation": VALIDATION_POOL,
    "test": TEST_POOL,
}

SPLITS = ("train", "validation", "test")


def pool_for(edge: Edge) -> str | None:
    for split, pool in EDGE_POOLS.items():
        if edge in pool:
            return split
    return None
