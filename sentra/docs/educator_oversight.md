# Educator oversight — roles, consent, access & audit

How the educator/organization dashboard accesses student data, and the demo runbook.
Companion policies: [product_policy.md](product_policy.md), [safety_escalation_policy.md](safety_escalation_policy.md).

## Roles

| Role | Who | Can do |
| --- | --- | --- |
| `student` | Any app user (owns `participants` rows) | Everything about their own data; grant/revoke oversight consent (`/sharing`); see who viewed their data |
| `educator` | Active `organization_members` row, role `educator` | Read **derived signals** of students who are actively rostered to them **and** have granted consent; log/acknowledge alerts |
| `org_admin` | Active membership, role `org_admin` (org creator is bootstrapped) | Manage membership + roster links; set class / 出席番号 (`class_placements`); read the org's access trail |

## Access matrix (enforced in RLS, not the UI)

| Data | Student (owner) | Educator (rostered + consented) | Educator otherwise |
| --- | --- | --- | --- |
| `entries` (incl. raw text) | full | **no access — no policy exists** | no access |
| `insights` (scores, graph summaries) | full | read | no access |
| `model_runs` | full | read, `safety_assessment` rows only | no access |
| `participants` | full | via `overseen_participants()` only (id/code + class/出席番号 — `display_name` and `notes` never, #466) | no access |
| `class_placements` | own row (read) | no direct access — reaches the educator only through `overseen_participants()` | no access |
| `oversight_roster` | rows about them | own assignments | own assignments |
| `oversight_consents` | full control (only writer) | observe status | observe status |
| `educator_access_log` | rows about them | own trail, **append-only** (no update/delete policy for anyone) | insert blocked by `educator_oversees()` |

Data-access path:

```
student data ──▶ [active roster link] AND [active student consent]   (educator_oversees)
                        │ no                                │ no
                        ▼                                   ▼
                    default-deny                       default-deny
                        │ yes + yes
                        ▼
        minimized educator view (derived signals only)
                        ▼
        educator_access_log row (append-only, student-visible)
```

## Consent model

- **Default-deny**: a roster link alone grants nothing. Consent is granted by the student on `/sharing`, org-wide or per-educator, versioned (`consent_version`).
- **Revocable**: revoking flips `status` (stamping `revoked_at`); the next educator read returns nothing. Proven in `supabase/tests/oversight_rls.test.sql`.
- **Transparent**: students see who requested oversight (org name), and every educator view of their data (`/sharing` → "Who viewed your data").

## クラス・出席番号の設定 (#466)

Educators identify a student by class and attendance number, never by name
(`educator_display_policy.md` → The field set). The values live in
`public.class_placements`, one row per (org, participant), both columns
nullable. Until they are set, the educator screens read 「クラス未設定」.

Only an active `org_admin` of the org can write them, and only for a
participant already on that org's `oversight_roster` (RLS:
`class_placements_insert_admin` / `_update_admin`). Within an org a
class + number pair is unique, since it is the only identifier the educator
has. There is no admin screen yet — the import format (CSV, or a
school-information-system feed) is still being agreed with schools. Until then:

- **As the org admin, through PostgREST** (the same session the admin uses for
  roster links):

  ```ts
  await supabase.from("class_placements").upsert(
    { org_id, participant_id, owner_user_id, class_label: "2-3", attendance_number: 12 },
    { onConflict: "org_id,participant_id" },
  );
  ```

- **As an operator, in SQL** (service role / SQL editor, which bypasses RLS —
  check the roster link yourself):

  ```sql
  insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
  select r.org_id, r.participant_id, r.owner_user_id, '2-3', 12
    from public.oversight_roster r
   where r.org_id = '<org uuid>' and r.participant_id = '<participant uuid>'
   limit 1
  on conflict (org_id, participant_id)
  do update set class_label = excluded.class_label,
                attendance_number = excluded.attendance_number;
  ```

- **Synthetic accounts:** `node scripts/seed-actors.mjs --count 30 --roster <org> --educator <user> --class 2-3`
  numbers the created students 1..N in class 2-3.

The student can read their own row, so what the school recorded about them is
visible to them.

## Escalation (educator-facing)

Crisis flags show the educator a non-clinical protocol (route to the school's designated support staff; emergencies follow the school's procedure) and require an acknowledgement, recorded as an `alert_ack` log row. Educators never see the underlying disclosure — only the flag, level, and derived reasons. Full policy: [safety_escalation_policy.md](safety_escalation_policy.md).

## Demo runbook (local, no live AI needed)

```bash
cd sentra
supabase start
supabase db reset                       # applies all migrations
docker exec -i supabase_db_sentra psql -U postgres -d postgres \
  < supabase/seed/educator_demo.seed.sql
cd frontend && npm ci && npm run dev    # local Supabase env vars in backend/.env.local pattern
```

Sign in as `educator@demo.blesc` / `demo-blesc-2026` → `/educator`:

1. **Overview** — 3 consented students (KO settled, RI review-spike, HA crisis); YU exists but has not consented → invisible (default-deny, live).
2. **Roster** — students appear as class + 出席番号 (2-1 1番 …), never by name; newest observation first, so HA (crisis) leads.
3. **Alerts** — crisis alert for HA renders the escalation protocol; acknowledge it (logged); RI shows a signal spike; inactivity alerts for quiet students.
4. **Student overview** — HA (2-1 3番): the observations, newest first, each with kind, time, input source and evidence; no name, no themes (#466); note the "this view is logged" notice.
5. Sign in as `student-ha@demo.blesc` → `/sharing` — see the educator's views in "Who viewed your data"; **revoke** consent, sign back in as the educator: HA is gone everywhere.

All data is seeded and deterministic — the demo runs fully offline (this is the fixture/mock path; live extraction is exercised by the normal student flow instead).

## Release checklist (gate for oversight changes)

- [ ] `supabase db reset` applies cleanly; RLS suite passes (`ALL OVERSIGHT RLS TESTS PASSED`)
- [ ] Educator `entries` reachability is **0 rows** in the suite (raw-text check)
- [ ] Default-deny + revocation assertions present and green
- [ ] Access log remains append-only (no update/delete policy added)
- [ ] `npm run lint` (0 errors) and `npm run build` pass
- [ ] No diagnostic/clinical language in educator-facing copy
- [ ] Demo runbook above verified on a fresh reset
