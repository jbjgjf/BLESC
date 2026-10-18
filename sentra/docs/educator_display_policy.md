# Educator display policy

**Decided 2026-08-06.** The educator surface shows observations. It does not
show a risk classification.

**Narrowed 2026-10-18 (#466).** The educator surface shows a fixed set of
fields and nothing else — see [The field set](#the-field-set-466).

## The field set (#466)

blesc.jp promises:

> 先生に表示されるのは、クラス、出席番号、観測された表現の種類、時刻だけです。

and its educator mock shows, for each observation, the input source
(ジャーナル／チャット／音声) and 「根拠: 記述との一致 / 推論なし」, newest first.
Until #466 the product did not match: the roster and the student screen showed
the student's **name** (`participants.display_name`), the student screen listed
**繰り返し見られる話題** counted from the student's diary graph, and neither
screen had a class or attendance number to show instead. On 2026-10-18 the
owner chose to change the product rather than the site (option B).

What an educator screen (`/educator`, `/educator/roster`,
`/educator/student/[participantId]`) may show about a student:

| field | source | when unset |
| --- | --- | --- |
| クラス | `class_placements.class_label`, via `overseen_participants()` | 「クラス未設定」 |
| 出席番号 | `class_placements.attendance_number`, via `overseen_participants()` | 「出席番号未設定」 |
| 観測の種類 | the matched safety reasons (`t.safety.reason`) | the observation is not shown (rule 2) |
| 時刻 | when the observation was recorded | — |
| 入力元 | `journal` / `chat` / `voice` (`t.safety.surface`) | omitted |
| 根拠 | fixed: 「根拠: 記述との一致 / 推論なし」 | — |

Lists are ordered **newest observation first**; students with no showable
observation follow, by class and number. The 「要確認」 chip, the crisis routing
note, the access-logged notice and the non-diagnostic notice stay — they are
about the screen, not about the student.

The overview's three tiles are counts over the cohort (consented students,
recorded in the last 7 days, observations), suppressed below three students.
They are not per-student fields and stay.

**Never a fallback to the name.** A student with no class or number set reads
「クラス未設定」. It does not fall back to `display_name`, and it does not fall
back to the internal `code` either — an id on a teacher's screen invites a
lookup table, which is a name list by another route.

**Enforced in the payload, not only in the JSX** — the lesson recorded below,
twice. `overseen_participants()` no longer returns `display_name`
(`supabase/migrations/20261018000000_class_placements_and_minimal_roster.sql`).
`EducatorStudentStatus` has no name field and no baseline fields;
`getStudentOverviewForEducator` returns `{ student, observations }` and no
longer reads `insights` at all, so neither themes nor the days written reach the
browser. `frontend/tests/educator-fields.test.mjs` pins the exact keys of the
type and the demo payload, the migration's return columns, and which student
properties the screens read.

Removed from the educator screens in the same change, because they are outside
the field set:

- the student's name, and the internal `code` printed beside it;
- 繰り返し見られる話題 (themes) and the module that filtered them,
  `src/lib/educatorThemes.ts` (#100), which had no other caller;
- the list of days the student wrote (「最近の観測」);
- 「最後の記録 YYYY/MM/DD」 on each roster row, and the 「記録が途切れている」
  filter, which disclosed the same thing by list membership;
- the baseline context line (rule 4).

`code`, `org_id`, `owner_user_id` and `participant_id` are still in the payload:
they route the link, key alerts and the access log, and match shared
summaries. They are not rendered. `last_active_day` is still in the payload for
the overview's suppressed 7-day count and the derived inactivity alert.

**Not covered by #466: `/oversight`.** The counsellor view of support summaries
a student *chose* to share still shows the summary's sections (including its
recent themes), the internal `student_code` and the last entry date. It is a
separate, student-initiated share rather than what an educator sees by default,
and whether the site's sentence is meant to cover it is an open question for the
owner.

## The distinction

Two different products can be built from the same data:

| | claim | what it needs |
| --- | --- | --- |
| **triage aid** | "the student wrote a direct statement about self-harm at 22:14" | nothing — it is constitutively true |
| **screening instrument** | "depression risk: high" | ground-truth labels, IRB, prospective study, sensitivity and specificity |

"They wrote 死にたい" is a fact. "Risk: high" is an inference about a minor's
internal state. Both come from the same data; they are not the same object, and
only one of them needs validating.

## Why the band was removed rather than validated

Not a validation deficiency — arithmetic. A school of 1000 students at 5%
prevalence of serious depression:

| sensitivity / specificity | flagged | true | false | PPV |
| --- | --- | --- | --- | --- |
| 80% / 90% | 135 | 40 | 95 | **30%** |
| 90% / 95% | 93 | 45 | 48 | **49%** |
| 95% / 99% | 57 | 48 | 10 | **83%** |

Established instruments such as PHQ-9 reach roughly 80–90% sensitivity and
specificity against structured interview, so the realistic row is the first:
**seven in ten students shown "risk: high" would not be cases.** The third row
is not reachable from conversational text at all.

Better models move these numbers. They do not fix them. Any binary judgement
imposed on a low-prevalence population carries this, so completing the clinical
validation in M-02 would not make the band safe to display — which is why the
display change does not wait on M-02, and why M-02 finishing would not
retroactively justify the band.

## Rules

1. **No risk classification is rendered.** `state_band` and `latest_score` are
   still computed and stored; they are not shown, not counted in a tile, and
   not used to order a list. Ordering by band would put the classification back
   into the interface through the sort.
2. **Every observation carries its evidence and timestamp.** An observation
   with no reasons is not displayed at all — a flag an educator cannot trace
   back to something the student wrote is worse than no flag.
3. **Provenance is stated.** 「根拠: 記述との一致 / 推論なし」 appears under
   each observation, so an educator can tell a lexicon match from a model
   judgement. (Until #466 it read 「safety.py の決定的マッチ」, which named a file
   to a teacher; the wording now matches the site.)
4. **No baseline context on the educator surface (#466).** The comparison
   line is not one of the promised fields, so it was removed from the educator
   screens, and the baseline fields are off `EducatorStudentStatus`. The rule
   it replaced is kept for the record, because if context ever returns it
   returns under it: *context only against a settled baseline* — while
   `baseline_provenance.is_provisional` is true, the comparison line is
   replaced by "基準値の学習中（残り N 日）", and no score reaches the band or
   the alert list. Originally this was because the ramp-up comparison ran
   against guessed population statistics (D-04). Those were deleted in #91, so
   there is now no comparison at all during ramp-up — the rule stands unchanged
   and its reason is simpler: there is nothing to compare against yet.
5. **Every educator surface states that the tool does not diagnose.**

## What is still written

`anomaly_score` is **no longer written** to `insights` as of this change; the
column and existing rows remain. Retention of a risk classification attached to
an identifiable minor is the compliance question, and it is not answered by
hiding the value — so new writes stopped at the same time as the display
change. Deleting historical rows is irreversible and waits on legal advice.

**Correction, and how long it took to notice.** "New writes stopped" was true
only of the FastAPI backend, which honoured `PERSIST_ANOMALY_SCORE = False` from
2026-08-06. Production does not use that backend: submissions go to the Next.js
route handler and every row lands in Supabase. That path went on writing a score
on every submission for the two months after this policy was decided — and the
value it wrote had no baseline behind it, being
`1 + triggers*0.8 - protective*0.25 + relations*0.05` over a single entry.
`longitudinal_features.latest_anomaly_score` accumulated the same value into a
time series. Both are now gated on the same constant, and reads are gated too,
so rows written during that window stop rendering as measurements. See
`production_baseline_path.md`.

The general lesson is worth keeping: a policy enforced in one of two
implementations is not enforced. This one was written as a decision about the
product and applied to the codebase that happened to be in front of the person
applying it.

**It happened twice more, and the lesson above predicted both.** #175 found them
on 2026-09-16, forty-one days after this policy was decided:

- `/educator/class` — the demo class screen painted every student's cell by
  risk band, counted students per band in a legend, and put 「名前 ・ 高リスク」 in
  the cell's `title`. The rule had been applied to `src/app/educator/` (real
  data) and not to `src/lib/blesc/` (the planning-document demo). The demo is
  what schools are shown.
- `/educator/student/[participantId]` — the **real-data** screen rendered
  `anomaly_score.toFixed(2)` beside each day, for a named student. This one was
  not a demo. It survived because the 2026-08-06 change was applied to the
  roster and the class list, and this screen was not read.

Both are removed. Two things changed beyond the deletions, because deleting the
render is what was done in August and it did not hold:

2026-09-18 visual audit found a remaining classification under a different
name: demo `FollowUpItem.state` used `improving`/`worsening`, and the alerts
screen included students based on `worsening`. Its copy also claimed emotional
improvement or lack of improvement. The state field and state-based inclusion
are removed; follow-up reminders now depend only on an unregistered next
meeting. The demo observation detail no longer infers helplessness. Regression
checks include these identifiers and phrases. The earlier tests passed while
this remained, so their success alone was not proof of compliance.

- The score no longer reaches the browser. `getStudentOverviewForEducator` stops
  selecting `anomaly_score`, and `latest_score` / `state_band` are off
  `EducatorStudentStatus` entirely. A value a screen can reach is a value the
  next edit to that screen can render.
- `frontend/tests/educator-display-policy.test.mjs` sweeps the educator sources
  for the band and score identifiers and for the labels 高リスク / 要注意 /
  悪化傾向 / 改善傾向. It matches names, not meaning — a band renamed would pass
  — so it is a tripwire on the known shape of this mistake, not a proof.

Also removed in the same pass: the `anomaly_spike` alert in `getCohortAlerts`,
which built the sentence 「変化の大きさが 3.40 で、確認の目安（2.0）を超えています」
from `state_band === "review"`. No screen rendered it, which is exactly why it
was still there — a classification nothing renders *yet* is one the next screen
renders by accident.

`state_band` was derived client-side from `anomaly_score` and never stored. It
no longer exists.

## Outputs without an attributable observation path (#100, #102)

#102 makes it non-negotiable that no result is shown without traceable source
observations, and #100 restates it for learned models. There is no learned
model, so on 2026-10-11 the rule was applied to every educator-facing output
that exists. Where each one is produced, and what enforces the rule there:

| output | produced in | check |
| --- | --- | --- |
| ~~繰り返し見られる話題 (themes) on `/educator/student/[participantId]`~~ | — | **Removed (#466).** Was counted from `key_nodes` through `src/lib/educatorThemes.ts`, which withheld fallback-template nodes (#100). The output itself is now outside the field set, so the output and its filter are both gone, and the query no longer reads `insights` |
| ~~days written (`signals`)~~ | — | **Removed (#466)**, outside the field set |
| safety observation on the roster / alerts | `getCohortRoster`, `hasShowableObservation` (`src/lib/educatorIdentity.ts`) | rule 2 above — no reasons, no display |
| safety history (`observations`) on the student screen | `getStudentOverviewForEducator` | now carries the reasons and the surface, so each row shows kind, time, input source and evidence like the roster. A row **without** reasons (written before reasons were stored) is still shown, with the level's wording in place of the kind: withholding a safety display has its own risk, and the safety lexicon has its own owner. Needs a decision |
| relation paths, `GET /api/graph/traverse?audience=educator` (FastAPI, local only) | `traversal.walk.filter_reportable` (#96) | paths without a source snapshot, or for a participant whose cross-day identity is unusable, are withheld with reasons |
| any future model output | `app/ontology/educator_exposure.py` | needs a resolvable observation of the same participant and a breakdown; a **learned** output is also withheld while the Stage 3 entry gate (`learning_gates.evaluate_stage3_entry_gate`) is closed, which it is |

The demo library (`src/lib/blesc`) is fictional data and is not in this table.

## Relationship to the landing page

The field set above is the product side of the LP sentence
「先生に表示されるのは、クラス、出席番号、観測された表現の種類、時刻だけです。」
(#466). Rows ② (second clause) and ④ of the LP's technical claims are changed to match
this policy. Leaving the LP claiming a risk judgement the product no longer
makes would be the least defensible of the available states. See
`M-01` in the external review and `docs/lp_claim_alignment.md`.

## Open

- How schools load class and attendance numbers at scale (CSV import, or a
  school-information-system integration). Until then an org admin sets them
  through RLS-checked writes to `class_placements`; see
  `educator_oversight.md` → 「クラス・出席番号の設定」.
- Whether `/oversight` (student-initiated summary sharing) falls under the
  field set. See above.
- Ordering is newest-first, as the site shows. Before #466 crisis observations
  were weighted to the top of the roster; a crisis older than an elevated
  observation can now sit below it. Crisis observations are still pushed
  (`crisis_escalation.md`) and carry the 「要確認」 chip.

- Legal review of retention and SaMD applicability, before deployment.
- M-02 remains open, but is no longer a blocker for the educator surface.
