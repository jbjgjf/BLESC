"""#213 — seeded statistical generator for 50×28 synthetic participants.

**What it produces.** Records in the shape of the pilot's research export
(`schema.py`): relative days 1–28, the five fixed items on their own scales and
each optional, a short synthetic diary text, a synthetic submission time, and
days with no record at all. Plus per-participant consent and withdrawal state,
so the consent gate (#212) can be exercised without a real person.

**What it does not take.** Any real participant data, real text or real
aggregate. `generate()` takes a config and nothing else; there is no parameter
through which real data could arrive, and the manifest records that.

**What its numbers are not.** The parameters below are assumptions picked so
that the code has something with day-to-day structure to work on: a persistent
latent "strain" (cf. S1, #149), last night's sleep depending on yesterday
(a lagged term), weekend effects, and missingness (cf. S4). They were not
estimated from anyone and must not be read as a population prior (#62, #99).

**The truth is a different object.** `generate()` returns a `GeneratedCohort`
holding the dataset *and* a `GenerationTruth` — the latent strain, the complete
values before any missingness, and the probabilities that decided what went
missing. Only the dataset is ever handed to an analysis. Both truth-bearing
types carry `CARRIES_GENERATION_TRUTH`, and the consent gate refuses anything
that does, so passing the cohort where the dataset belongs fails loudly.

**Missingness scenarios.** At least two are required (#213):

- `independent` — whether a day is submitted, and whether an item is skipped,
  does not depend on the participant's state (missing completely at random,
  given the participant's own rate);
- `state_dependent` — higher strain makes a submission less likely and makes
  skipping mood/stress more likely (missing not at random). The strength is a
  config value. This is a *synthetic* scenario: it is not a claim about how
  real students skip days, and its truth is never a fact about the pilot;
- `none` — nothing goes missing. Not realistic; it is the reference against
  which the sensitivity analysis (#216) measures what missingness changes.

The three scenarios share their random draws. The latent trajectory and the
complete values are identical across scenarios for a given seed, and the
missingness decisions use the same uniform numbers with scenario-specific
thresholds, so a difference between scenarios is caused by the missingness
rule and not by a different random path.

**No day depends on a later day.** Every draw for day *d* is made from
per-participant streams in day order, and no quantity uses the trajectory's
future (the state-dependent rule standardises strain by its analytic
stationary scale, not by the realised series). A test generates a shorter
study and checks that its days are a prefix of the longer one.

**Status.** Everything this produces is a *candidate (not frozen)*. Which
config and seed becomes the frozen synthetic set is P13 of the
pre-registration, and freezing it is a human step.
"""

from __future__ import annotations

import json
import math
import platform
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ..contracts.common import content_hash, file_hash
from ..contracts.errors import Code, ContractViolation
from . import CANDIDATE_STATUS, CANDIDATE_STATUS_JA, TRANSFER_STUDY_VERSION
from .schema import (
    CONSENT_DOCUMENT_VERSION,
    DATA_DICTIONARY_PATH,
    ITEM_BY_ID,
    ITEM_IDS,
    PROTOCOL_VERSION,
    SELF_REPORT_ITEMS,
    SELF_REPORT_SCHEMA_ID,
    SOURCE_SYNTHETIC,
    STUDY_DAYS,
    TARGET_PARTICIPANTS,
    DailyRecord,
    Enrollment,
    TransferDataset,
    protocol_shape,
)

GENERATOR_VERSION = "transfer-statistical-generator-v0"
MANIFEST_VERSION = "transfer-synthetic-manifest-v0"
GENERATOR_KIND = "statistical"

MISSINGNESS_SCENARIOS: Tuple[str, ...] = ("none", "independent", "state_dependent")

SYNTHETIC_PERMITTED_USES: Tuple[str, ...] = ("synthetic_training", "synthetic_evaluation")

#: A Monday, and obviously not the pilot. Day 1 of each synthetic participant
#: falls in the week after it, on that participant's own start weekday. The
#: research export carries no dates, so nothing downstream should read this.
SYNTHETIC_EPOCH = date(2001, 1, 1)
JST = timezone(timedelta(hours=9))

#: Marker on every object that holds generated truth. The consent gate refuses
#: any input with it set (`generation_truth_in_model_input`).
CARRIES_GENERATION_TRUTH = "__carries_generation_truth__"

#: The latent model's fixed coefficients. Assumptions, not estimates. Recorded
#: whole in every manifest so that "the generator config" means all of it.
FIXED_PARAMETERS: Mapping[str, float] = {
    "mood_mean_mu": 6.0,
    "mood_mean_sd": 1.2,
    "stress_mean_mu": 4.5,
    "stress_mean_sd": 1.5,
    "sleep_quality_mean_mu": 6.0,
    "sleep_quality_mean_sd": 1.2,
    "sleep_hours_mean_mu": 7.0,
    "sleep_hours_mean_sd": 0.7,
    "event_mean_mu": 3.5,
    "event_mean_sd": 1.2,
    "strain_persistence_low": 0.3,
    "strain_persistence_high": 0.7,
    "strain_event_loading": 0.35,
    "strain_innovation_sd": 0.7,
    "event_daily_sd": 1.6,
    "event_weekend_shift": 1.2,
    "mood_strain_loading": -0.8,
    "stress_strain_loading": 1.0,
    "sleep_quality_prev_strain_loading": -0.5,
    "sleep_quality_daily_sd": 0.8,
    "sleep_hours_weekend_shift": 0.7,
    "sleep_hours_prev_strain_loading": -0.25,
    "sleep_hours_daily_sd": 0.6,
    "response_sd_low": 0.4,
    "response_sd_high": 0.9,
    "submit_strain_loading": -1.0,
    "item_skip_strain_loading": 0.8,
    "block_skip_strain_loading": 0.5,
    "preferred_minute_mu": 21.5 * 60,
    "preferred_minute_sd": 90.0,
    "daily_minute_sd": 60.0,
    "earliest_minute": 6 * 60,
    "latest_minute": 23 * 60 + 59,
    "verbosity_log_mu": math.log(2.0),
    "verbosity_log_sd": 0.4,
    "withdrawal_day_low": 8,
    "withdrawal_day_high": 24,
}

#: Only mood and stress get state-dependent item skipping: the scenario is
#: "a bad day makes the participant skip the questions about how the day felt",
#: which is one concrete MNAR story rather than every item at once.
STATE_DEPENDENT_SKIP_ITEMS: Tuple[str, ...] = ("mood", "stress")

# Synthetic diary sentences. Deliberately mundane and free of crisis
# vocabulary: these texts exist to give the audit something to count, not to
# imitate a student, and a generator that wrote distress would produce fixtures
# the safety pipeline then has to treat as disclosures.
_BASE_SENTENCES: Tuple[str, ...] = (
    "朝は少し早く起きた。",
    "授業で小テストがあった。",
    "昼ごはんは友だちと食べた。",
    "部活の練習があった。",
    "帰りに本屋に寄った。",
    "宿題を少し進めた。",
    "夜は家でゆっくりした。",
    "雨が降っていて歩くのが大変だった。",
    "天気がよくて気持ちよかった。",
    "好きな音楽を聴いた。",
    "家族と夕ごはんを食べた。",
    "数学の問題が難しかった。",
    "図書館で勉強した。",
    "電車が少し遅れた。",
    "今日は特に変わったことはなかった。",
)
_EVENT_SENTENCES: Tuple[str, ...] = (
    "今日は文化祭の準備で忙しかった。",
    "部活の試合があった。",
    "大きな発表があって緊張した。",
    "友だちと出かけて、いつもと違う一日だった。",
)
_HIGH_MOOD_SENTENCES: Tuple[str, ...] = ("楽しい一日だった。", "気分がよかった。")
_LOW_MOOD_SENTENCES: Tuple[str, ...] = ("少し疲れた。", "あまり気分が乗らなかった。")
_TEXT_DRAWS_PER_DAY = 10


@dataclass(frozen=True)
class SyntheticCohortConfig:
    """Everything that decides a cohort, except the code itself.

    `seed` and `missingness` have no defaults on purpose. A default seed would
    quietly become "the" seed, and which seed and scenario become the frozen
    synthetic set is a pre-registration decision (P13), not a library default.
    The remaining defaults are dry-run assumptions, recorded in the manifest.
    """

    seed: int
    missingness: str
    n_participants: int = TARGET_PARTICIPANTS
    study_days: int = STUDY_DAYS
    mnar_strength: float = 1.0
    submit_rate_mean: float = 0.75
    submit_rate_concentration: float = 8.0
    item_skip_rate: float = 0.08
    self_report_skip_rate: float = 0.05
    raw_text_retention_rate: float = 0.7
    model_training_use_rate: float = 0.6
    withdrawals_keep: int = 2
    withdrawals_delete: int = 1
    no_research_consent: int = 0
    #: Rows written on or after the withdrawal day. The app stops research
    #: writes at withdrawal (protocol §5.2), so this is 0 except in the gate's
    #: dry run, which needs a defect to catch.
    stray_rows_after_withdrawal: int = 0
    #: True only if this config was changed after real data was seen (#214):
    #: such a cohort is exploratory and is never compared as if pre-registered.
    post_hoc_adjusted: bool = False
    dataset_label: Optional[str] = None

    def validate(self) -> None:
        if self.missingness not in MISSINGNESS_SCENARIOS:
            raise ContractViolation(
                Code.UNKNOWN_ENUM_VALUE,
                f"未知の欠測シナリオです: {self.missingness}",
                "config.missingness",
                {"allowed": list(MISSINGNESS_SCENARIOS)},
            )
        if self.n_participants < 1 or self.study_days < 1:
            raise ContractViolation(Code.EMPTY_VALUE, "参加者数と日数は1以上です。", "config")
        if not 0.0 < self.submit_rate_mean < 1.0:
            raise ContractViolation(Code.WRONG_TYPE, "submit_rate_meanは0より大きく1より小さい確率です。", "config.submit_rate_mean")
        for name in ("item_skip_rate", "self_report_skip_rate", "raw_text_retention_rate", "model_training_use_rate"):
            value = getattr(self, name)
            if not 0.0 <= value <= 1.0:
                raise ContractViolation(Code.WRONG_TYPE, f"{name}は0〜1の確率です。", f"config.{name}")
        if self.mnar_strength < 0:
            raise ContractViolation(Code.WRONG_TYPE, "mnar_strengthは0以上です。", "config.mnar_strength")
        special = self.withdrawals_keep + self.withdrawals_delete + self.no_research_consent
        if special > self.n_participants:
            raise ContractViolation(Code.WRONG_TYPE, "撤回・非同意の人数が参加者数を超えています。", "config")

    @property
    def dataset_id(self) -> str:
        if self.dataset_label:
            return self.dataset_label
        strength = f"-k{self.mnar_strength:g}" if self.missingness == "state_dependent" else ""
        return f"transfer-synthetic-{self.missingness}{strength}-seed{self.seed}"

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GenerationTruth:
    """What the generator knew and no model may see."""

    seed: int
    missingness: str
    complete_values: Mapping[str, Tuple[Tuple[float, ...], ...]]
    strain: Mapping[str, Tuple[float, ...]]
    submit_probability: Mapping[str, Tuple[float, ...]]
    submitted: Mapping[str, Tuple[bool, ...]]
    __carries_generation_truth__ = True

    def complete_value(self, research_code: str, day_index: int, item_id: str) -> float:
        return self.complete_values[research_code][day_index - 1][ITEM_IDS.index(item_id)]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "seed": self.seed,
            "missingness": self.missingness,
            "complete_values": {
                code: [list(day) for day in days] for code, days in sorted(self.complete_values.items())
            },
            "strain": {code: [round(value, 9) for value in days] for code, days in sorted(self.strain.items())},
            "submit_probability": {
                code: [round(value, 9) for value in days] for code, days in sorted(self.submit_probability.items())
            },
            "submitted": {code: list(days) for code, days in sorted(self.submitted.items())},
        }

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


@dataclass(frozen=True)
class GeneratedCohort:
    dataset: TransferDataset
    truth: GenerationTruth
    config: SyntheticCohortConfig
    manifest: Mapping[str, Any]
    __carries_generation_truth__ = True


# --------------------------------------------------------------------------
# Streams
# --------------------------------------------------------------------------

_STREAM_PARAMETERS = 1
_STREAM_LATENT = 2
_STREAM_MISSING = 3
_STREAM_TEXT = 4
_STREAM_TIME = 5
_STREAM_COHORT = 6


def _stream(seed: int, stream: int, index: Optional[int] = None) -> np.random.Generator:
    """One independent stream per (purpose, participant).

    Separate streams are what make the scenarios share their latent path: the
    missingness stream can be thresholded differently without moving a single
    draw in the latent stream.
    """

    key = [int(seed), stream] if index is None else [int(seed), stream, int(index)]
    return np.random.default_rng(key)


def _sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def _logit(probability: float) -> float:
    clipped = min(max(probability, 1e-9), 1 - 1e-9)
    return math.log(clipped / (1.0 - clipped))


def _research_code(config: SyntheticCohortConfig, index: int) -> str:
    # "SYN-" so that a synthetic row can never be mistaken for a minted
    # research code, wherever it ends up.
    return f"SYN-{config.seed}-{index:03d}"


# --------------------------------------------------------------------------
# One participant
# --------------------------------------------------------------------------


@dataclass
class _Participant:
    research_code: str
    start_weekday: int
    means: Dict[str, float]
    persistence: float
    response_sd: float
    submit_rate: float
    preferred_minute: float
    verbosity: float
    strain_scale: float


def _draw_participant(config: SyntheticCohortConfig, index: int) -> _Participant:
    p = FIXED_PARAMETERS
    rng = _stream(config.seed, _STREAM_PARAMETERS, index)
    means = {
        "mood": float(np.clip(rng.normal(p["mood_mean_mu"], p["mood_mean_sd"]), 2.0, 9.0)),
        "stress": float(np.clip(rng.normal(p["stress_mean_mu"], p["stress_mean_sd"]), 1.0, 8.5)),
        "sleep_quality": float(np.clip(rng.normal(p["sleep_quality_mean_mu"], p["sleep_quality_mean_sd"]), 2.0, 9.0)),
        "sleep_hours": float(np.clip(rng.normal(p["sleep_hours_mean_mu"], p["sleep_hours_mean_sd"]), 5.0, 9.0)),
        "event_intensity": float(np.clip(rng.normal(p["event_mean_mu"], p["event_mean_sd"]), 0.5, 7.0)),
    }
    persistence = float(rng.uniform(p["strain_persistence_low"], p["strain_persistence_high"]))
    response_sd = float(rng.uniform(p["response_sd_low"], p["response_sd_high"]))
    alpha = config.submit_rate_mean * config.submit_rate_concentration
    beta = (1.0 - config.submit_rate_mean) * config.submit_rate_concentration
    submit_rate = float(rng.beta(alpha, beta))
    preferred_minute = float(
        np.clip(rng.normal(p["preferred_minute_mu"], p["preferred_minute_sd"]), p["earliest_minute"], p["latest_minute"])
    )
    verbosity = float(rng.lognormal(p["verbosity_log_mu"], p["verbosity_log_sd"]))
    start_weekday = int(rng.integers(0, 7))
    innovation_variance = (p["strain_event_loading"] * p["event_daily_sd"]) ** 2 + p["strain_innovation_sd"] ** 2
    strain_scale = math.sqrt(innovation_variance / (1.0 - persistence**2))
    return _Participant(
        research_code=_research_code(config, index),
        start_weekday=start_weekday,
        means=means,
        persistence=persistence,
        response_sd=response_sd,
        submit_rate=submit_rate,
        preferred_minute=preferred_minute,
        verbosity=verbosity,
        strain_scale=strain_scale,
    )


def _simulate_latent(config: SyntheticCohortConfig, index: int, person: _Participant) -> Tuple[List[float], List[Tuple[float, ...]]]:
    """Strain and complete item values for days 1..study_days, in day order."""

    p = FIXED_PARAMETERS
    rng = _stream(config.seed, _STREAM_LATENT, index)
    previous = float(rng.normal(0.0, person.strain_scale))
    strains: List[float] = []
    values: List[Tuple[float, ...]] = []
    for day in range(1, config.study_days + 1):
        weekday = (person.start_weekday + day - 1) % 7
        weekend = 1.0 if weekday >= 5 else 0.0
        event_raw = person.means["event_intensity"] + p["event_weekend_shift"] * weekend + float(rng.normal(0.0, p["event_daily_sd"]))
        strain = (
            person.persistence * previous
            + p["strain_event_loading"] * (event_raw - person.means["event_intensity"])
            + float(rng.normal(0.0, p["strain_innovation_sd"]))
        )
        raw = {
            "mood": person.means["mood"] + p["mood_strain_loading"] * strain + float(rng.normal(0.0, person.response_sd)),
            "stress": person.means["stress"] + p["stress_strain_loading"] * strain + float(rng.normal(0.0, person.response_sd)),
            # Last night's sleep is a function of *yesterday's* strain — a
            # lagged term, so a model that reads history has something to find.
            "sleep_quality": person.means["sleep_quality"]
            + p["sleep_quality_prev_strain_loading"] * previous
            + float(rng.normal(0.0, p["sleep_quality_daily_sd"])),
            "sleep_hours": person.means["sleep_hours"]
            + p["sleep_hours_weekend_shift"] * weekend
            + p["sleep_hours_prev_strain_loading"] * previous
            + float(rng.normal(0.0, p["sleep_hours_daily_sd"])),
            "event_intensity": event_raw,
        }
        values.append(tuple(ITEM_BY_ID[item_id].quantise(raw[item_id]) for item_id in ITEM_IDS))
        strains.append(strain)
        previous = strain
    return strains, values


def _missingness(
    config: SyntheticCohortConfig, index: int, person: _Participant, strains: Sequence[float]
) -> Tuple[List[bool], List[bool], List[Tuple[bool, ...]], List[float]]:
    """Per day: submitted?, self-report block skipped?, per-item skipped?, P(submit)."""

    p = FIXED_PARAMETERS
    rng = _stream(config.seed, _STREAM_MISSING, index)
    submitted: List[bool] = []
    block_skipped: List[bool] = []
    item_skipped: List[Tuple[bool, ...]] = []
    probabilities: List[float] = []
    base_submit = _logit(person.submit_rate)
    base_item = _logit(config.item_skip_rate) if config.item_skip_rate > 0 else -math.inf
    base_block = _logit(config.self_report_skip_rate) if config.self_report_skip_rate > 0 else -math.inf

    for day in range(config.study_days):
        # Fixed number of draws per day, whatever the scenario: the scenarios
        # must consume the stream identically to stay comparable.
        u_submit = float(rng.random())
        u_block = float(rng.random())
        u_items = [float(value) for value in rng.random(len(ITEM_IDS))]

        if config.missingness == "none":
            submitted.append(True)
            block_skipped.append(False)
            item_skipped.append(tuple(False for _ in ITEM_IDS))
            probabilities.append(1.0)
            continue

        z = strains[day] / person.strain_scale if config.missingness == "state_dependent" else 0.0
        k = config.mnar_strength if config.missingness == "state_dependent" else 0.0
        p_submit = _sigmoid(base_submit + k * p["submit_strain_loading"] * z)
        p_block = 0.0 if base_block == -math.inf else _sigmoid(base_block + k * p["block_skip_strain_loading"] * z)
        skips = []
        for item_id, u_item in zip(ITEM_IDS, u_items):
            if base_item == -math.inf:
                skips.append(False)
                continue
            loading = p["item_skip_strain_loading"] if item_id in STATE_DEPENDENT_SKIP_ITEMS else 0.0
            skips.append(u_item < _sigmoid(base_item + k * loading * z))
        submitted.append(u_submit < p_submit)
        block_skipped.append(u_block < p_block)
        item_skipped.append(tuple(skips))
        probabilities.append(p_submit)
    return submitted, block_skipped, item_skipped, probabilities


def _texts(config: SyntheticCohortConfig, index: int, person: _Participant, values: Sequence[Tuple[float, ...]]) -> List[str]:
    """One synthetic text per day, from that day's values only."""

    rng = _stream(config.seed, _STREAM_TEXT, index)
    mood_index = ITEM_IDS.index("mood")
    event_index = ITEM_IDS.index("event_intensity")
    texts: List[str] = []
    for day_values in values:
        draws = [float(value) for value in rng.random(_TEXT_DRAWS_PER_DAY)]
        event = day_values[event_index]
        mood = day_values[mood_index]
        expected = person.verbosity * (1.0 + 0.1 * event)
        count = 1 + min(5, int(draws[0] * 2.0 * expected))
        chosen: List[str] = []
        for draw in draws[1 : 1 + count]:
            sentence = _BASE_SENTENCES[int(draw * len(_BASE_SENTENCES)) % len(_BASE_SENTENCES)]
            if sentence not in chosen:
                chosen.append(sentence)
        if event >= 7:
            chosen.insert(0, _EVENT_SENTENCES[int(draws[7] * len(_EVENT_SENTENCES)) % len(_EVENT_SENTENCES)])
        if mood >= 7:
            chosen.append(_HIGH_MOOD_SENTENCES[int(draws[8] * len(_HIGH_MOOD_SENTENCES)) % len(_HIGH_MOOD_SENTENCES)])
        elif mood <= 3:
            chosen.append(_LOW_MOOD_SENTENCES[int(draws[8] * len(_LOW_MOOD_SENTENCES)) % len(_LOW_MOOD_SENTENCES)])
        texts.append("".join(chosen))
    return texts


def _submission_times(config: SyntheticCohortConfig, index: int, person: _Participant) -> List[datetime]:
    """Synthetic local submission times, kept inside the same local calendar day.

    Clipped to 06:00–23:59 JST so that a submission never crosses midnight:
    the export assigns `day_index` by local calendar day, and a synthetic
    timestamp on the wrong side of midnight would disagree with its own day.
    """

    p = FIXED_PARAMETERS
    rng = _stream(config.seed, _STREAM_TIME, index)
    start = datetime(SYNTHETIC_EPOCH.year, SYNTHETIC_EPOCH.month, SYNTHETIC_EPOCH.day, tzinfo=JST) + timedelta(
        days=7 + person.start_weekday
    )
    times: List[datetime] = []
    for day in range(1, config.study_days + 1):
        minute = int(round(float(np.clip(person.preferred_minute + rng.normal(0.0, p["daily_minute_sd"]), p["earliest_minute"], p["latest_minute"]))))
        local = start + timedelta(days=day - 1, minutes=minute)
        times.append(local.astimezone(timezone.utc))
    return times


# --------------------------------------------------------------------------
# The cohort
# --------------------------------------------------------------------------


def _cohort_assignments(config: SyntheticCohortConfig) -> Dict[str, Any]:
    p = FIXED_PARAMETERS
    rng = _stream(config.seed, _STREAM_COHORT)
    order = [int(value) for value in rng.permutation(config.n_participants)]
    withdrawal_days = [
        int(value)
        for value in rng.integers(
            int(p["withdrawal_day_low"]), int(p["withdrawal_day_high"]) + 1, size=config.n_participants
        )
    ]
    retention = [bool(value) for value in rng.random(config.n_participants) < config.raw_text_retention_rate]
    training = [bool(value) for value in rng.random(config.n_participants) < config.model_training_use_rate]
    keep = set(order[: config.withdrawals_keep])
    delete = set(order[config.withdrawals_keep : config.withdrawals_keep + config.withdrawals_delete])
    start_no_consent = config.withdrawals_keep + config.withdrawals_delete
    no_consent = set(order[start_no_consent : start_no_consent + config.no_research_consent])
    return {
        "keep": keep,
        "delete": delete,
        "no_consent": no_consent,
        "withdrawal_days": withdrawal_days,
        "retention": retention,
        "training": training,
    }


def generate(config: SyntheticCohortConfig) -> GeneratedCohort:
    """Build one synthetic cohort, its sealed truth and its manifest."""

    config.validate()
    cohort = _cohort_assignments(config)
    records: List[DailyRecord] = []
    enrollments: List[Enrollment] = []
    complete: Dict[str, Tuple[Tuple[float, ...], ...]] = {}
    strain_truth: Dict[str, Tuple[float, ...]] = {}
    probability_truth: Dict[str, Tuple[float, ...]] = {}
    submitted_truth: Dict[str, Tuple[bool, ...]] = {}

    for index in range(config.n_participants):
        person = _draw_participant(config, index)
        strains, values = _simulate_latent(config, index, person)
        submitted, block_skipped, item_skipped, probabilities = _missingness(config, index, person, strains)
        texts = _texts(config, index, person, values)
        times = _submission_times(config, index, person)

        withdrawn_day: Optional[int] = None
        choice: Optional[str] = None
        if index in cohort["keep"] or index in cohort["delete"]:
            withdrawn_day = cohort["withdrawal_days"][index]
            choice = "keep" if index in cohort["keep"] else "delete"
        enrollment = Enrollment(
            research_code=person.research_code,
            cohort="synthetic",
            research_analysis=index not in cohort["no_consent"],
            raw_text_retention=cohort["retention"][index],
            model_training_use=cohort["training"][index],
            withdrawn_day=withdrawn_day,
            withdrawal_data_choice=choice,
            start_weekday=person.start_weekday,
        )
        enrollments.append(enrollment)

        stray_left = config.stray_rows_after_withdrawal
        for day in range(1, config.study_days + 1):
            position = day - 1
            if not submitted[position]:
                continue
            if withdrawn_day is not None and day >= withdrawn_day:
                if stray_left <= 0:
                    continue
                stray_left -= 1
            report: Optional[Tuple[Optional[float], ...]]
            if block_skipped[position]:
                report = None
            else:
                report = tuple(
                    None if skipped else value for value, skipped in zip(values[position], item_skipped[position])
                )
                if all(value is None for value in report):
                    report = None
            records.append(
                DailyRecord(
                    research_code=person.research_code,
                    day_index=day,
                    self_report=report,
                    text=texts[position] if enrollment.raw_text_retention else None,
                    model_training_use=enrollment.model_training_use,
                    submitted_at=times[position],
                )
            )

        complete[person.research_code] = tuple(values)
        strain_truth[person.research_code] = tuple(strains)
        probability_truth[person.research_code] = tuple(probabilities)
        submitted_truth[person.research_code] = tuple(submitted)

    dataset = TransferDataset(
        dataset_id=config.dataset_id,
        source_kind=SOURCE_SYNTHETIC,
        records=tuple(records),
        enrollments=tuple(enrollments),
        permitted_uses=SYNTHETIC_PERMITTED_USES,
        study_days=config.study_days,
    )
    dataset.validate()
    truth = GenerationTruth(
        seed=config.seed,
        missingness=config.missingness,
        complete_values=complete,
        strain=strain_truth,
        submit_probability=probability_truth,
        submitted=submitted_truth,
    )
    manifest = build_manifest(config, dataset, truth)
    return GeneratedCohort(dataset=dataset, truth=truth, config=config, manifest=manifest)


def generator_source_hash() -> str:
    """Hash of this file: the "generation code" #213 asks to fix alongside the seed."""

    return file_hash(str(Path(__file__)))


def build_manifest(config: SyntheticCohortConfig, dataset: TransferDataset, truth: GenerationTruth) -> Dict[str, Any]:
    """The record #213 requires: kind, code, config, seed, shape, hashes — no wall clock.

    A creation timestamp would make two generations from one seed differ, and
    "the same seed gives the same hash" is the property being recorded.
    """

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "transfer_study_version": TRANSFER_STUDY_VERSION,
        "status": CANDIDATE_STATUS,
        "status_ja": CANDIDATE_STATUS_JA,
        "dataset_id": dataset.dataset_id,
        "source_kind": dataset.source_kind,
        "generator": {
            "kind": GENERATOR_KIND,
            "module": "research_engine.transfer.generator",
            "version": GENERATOR_VERSION,
            "source_sha256": generator_source_hash(),
            "fixed_parameters": dict(FIXED_PARAMETERS),
            "missingness_scenarios_available": list(MISSINGNESS_SCENARIOS),
        },
        "config": config.as_dict(),
        "config_hash": content_hash(config.as_dict()),
        # The random streams are numpy's. NumPy does not promise that every
        # distribution method yields the same stream across versions, so the
        # version that produced the data is part of what re-creating it needs.
        "environment": {"numpy": np.__version__, "python": platform.python_version()},
        "seed": config.seed,
        "missingness_scenario": config.missingness,
        "shape": protocol_shape(dataset),
        "schema": {
            "self_report_schema_id": SELF_REPORT_SCHEMA_ID,
            "items": [item.as_dict() for item in SELF_REPORT_ITEMS],
            "relative_day": {"first": 1, "last": dataset.study_days, "zero_based": False},
            "period_split": None,
            "protocol_version": PROTOCOL_VERSION,
            "consent_document_version": CONSENT_DOCUMENT_VERSION,
            "data_dictionary": str(DATA_DICTIONARY_PATH.relative_to(DATA_DICTIONARY_PATH.parents[2])),
            "submitted_at_note_ja": "submitted_at は合成データだけが持つ。研究exportでは相対日に変換され、時刻は出ない（data dictionary）。",
        },
        "inputs": {
            "real_participant_data": False,
            "real_text": False,
            "real_data_aggregates": False,
            "note_ja": "生成器は設定とseedだけを入力にとる。実参加者データ・実本文・実データの集計値を入力にしない（#213）。",
        },
        "llm": {
            "used": False,
            "provider_calls": 0,
            "model_version": None,
            "prompt_template_hash": None,
            "cost_usd": 0.0,
        },
        "post_hoc_adjusted": config.post_hoc_adjusted,
        "not_a_population_prior_ja": (
            "生成器の分布は動作確認のための仮定であり、実測の母集団事前分布ではない（#62・#99）。"
        ),
        "hashes": {"dataset_hash": dataset.content_hash(), "truth_hash": truth.content_hash()},
        "reproduce": {
            "command": (
                "cd sentra/backend && python -m research_engine.transfer.cli generate "
                f"--seed {config.seed} --missingness {config.missingness} --out <dir>"
            ),
            "requires_real_data": False,
        },
    }
    return manifest


def manifest_hash(manifest: Mapping[str, Any]) -> str:
    return content_hash(dict(manifest))


def write_cohort(cohort: GeneratedCohort, out_dir: Path) -> Dict[str, Path]:
    """Dataset and manifest side by side; the truth in its own directory.

    The split on disk mirrors the split in memory: a person handing the
    dataset directory to a model author hands over no truth by accident.
    """

    out = Path(out_dir)
    truth_dir = out / "sealed_truth"
    truth_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "dataset": out / "dataset.json",
        "manifest": out / "manifest.json",
        "truth": truth_dir / "truth.json",
    }
    _write_json(paths["dataset"], cohort.dataset.as_dict())
    _write_json(paths["manifest"], {**cohort.manifest, "manifest_hash": manifest_hash(cohort.manifest)})
    _write_json(paths["truth"], cohort.truth.as_dict())
    return paths


def read_dataset(dataset_path: Path, manifest_path: Optional[Path] = None) -> TransferDataset:
    """Load a dataset and, when a manifest is given, refuse one whose hash drifted."""

    dataset = TransferDataset.from_dict(json.loads(Path(dataset_path).read_text(encoding="utf-8")))
    if manifest_path is not None:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        expected = manifest["hashes"]["dataset_hash"]
        if dataset.content_hash() != expected:
            raise ContractViolation(
                Code.STATUS_PAYLOAD_MISMATCH,
                "datasetのhashがmanifestと一致しません。生成後に内容が変わっています。",
                str(dataset_path),
                {"expected": expected, "got": dataset.content_hash()},
            )
    return dataset


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
