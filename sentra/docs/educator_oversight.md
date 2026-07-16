# Educator oversight — roles, consent, access & audit

How the educator/organization dashboard accesses student data, and the demo runbook.
Companion policies: [product_policy.md](product_policy.md), [safety_escalation_policy.md](safety_escalation_policy.md).

## Roles

| Role | Who | Can do |
| --- | --- | --- |
| `student` | Any app user (owns `participants` rows) | Everything about their own data; grant/revoke oversight consent (`/sharing`); see who viewed their data |
| `educator` | Active `organization_members` row, role `educator` | Read **derived signals** of students who are actively rostered to them **and** have granted consent; log/acknowledge alerts |
| `org_admin` | Active membership, role `org_admin` (org creator is bootstrapped) | Manage membership + roster links; read the org's access trail |

## Access matrix (enforced in RLS, not the UI)

| Data | Student (owner) | Educator (rostered + consented) | Educator otherwise |
| --- | --- | --- | --- |
| `entries` (incl. raw text) | full | **no access — no policy exists** | no access |
| `insights` (scores, graph summaries) | full | read | no access |
| `model_runs` | full | read, `safety_assessment` rows only | no access |
| `participants` | full | via `overseen_participants()` only (id/code/display_name — `notes` never) | no access |
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
2. **Roster** — needs-attention ordering puts HA (crisis) then RI (review) first.
3. **Alerts** — crisis alert for HA renders the escalation protocol; acknowledge it (logged); RI shows a signal spike; inactivity alerts for quiet students.
4. **Student overview** — HA: safety history + recurring derived themes; note the "this view is logged" notice.
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
