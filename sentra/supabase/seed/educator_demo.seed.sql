-- Educator oversight demo seed (issue #38).
--
-- Seeds a deterministic demo cohort against a LOCAL Supabase database:
--   * org "Aoi Gakuen Demo" with an org admin and an educator (password logins)
--   * 4 students in distinct states: settled, review-spike, crisis, inactive
--   * consents: 3 granted, 1 deliberately missing (default-deny demo)
--   * two weeks of insights history + safety runs — no live AI needed
--
-- Usage (local only — NEVER against production):
--   supabase db reset
--   docker exec -i supabase_db_sentra psql -U postgres -d postgres \
--     < supabase/seed/educator_demo.seed.sql
--
-- Demo logins (local): educator@demo.blesc / demo-blesc-2026
--                      admin@demo.blesc    / demo-blesc-2026
--                      student-ko@demo.blesc / demo-blesc-2026 (and ri/ha/yu)
--
-- Re-runnable: deletes previous demo rows (by fixed uuids) first.

begin;

-- Clean previous demo data (cascades cover children).
delete from public.organizations where id = '11111111-0000-0000-0000-000000000001';
delete from auth.users where id in (
  '11111111-0000-0000-0000-00000000000d',
  '11111111-0000-0000-0000-00000000000e',
  '11111111-0000-0000-0000-0000000000aa',
  '11111111-0000-0000-0000-0000000000bb',
  '11111111-0000-0000-0000-0000000000cc',
  '11111111-0000-0000-0000-0000000000dd'
);

-- ---------------------------------------------------------------------------
-- Auth users with working password logins (local GoTrue).
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', ids.id, 'authenticated', 'authenticated',
  ids.email, crypt('demo-blesc-2026', gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('display_name', ids.display_name),
  now(), now()
from (values
  ('11111111-0000-0000-0000-00000000000d'::uuid, 'admin@demo.blesc',      'Demo Org Admin'),
  ('11111111-0000-0000-0000-00000000000e'::uuid, 'educator@demo.blesc',   'Demo Educator'),
  ('11111111-0000-0000-0000-0000000000aa'::uuid, 'student-ko@demo.blesc', 'Student KO'),
  ('11111111-0000-0000-0000-0000000000bb'::uuid, 'student-ri@demo.blesc', 'Student RI'),
  ('11111111-0000-0000-0000-0000000000cc'::uuid, 'student-ha@demo.blesc', 'Student HA'),
  ('11111111-0000-0000-0000-0000000000dd'::uuid, 'student-yu@demo.blesc', 'Student YU')
) as ids(id, email, display_name);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where u.id::text like '11111111-%';

-- ---------------------------------------------------------------------------
-- Participants (one per student), org, membership, roster, consents.
-- ---------------------------------------------------------------------------

insert into public.participants (id, owner_user_id, code, display_name)
values
  ('11111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-0000000000aa', 'DEMO_KO', 'Demo student KO'),
  ('11111111-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-0000000000bb', 'DEMO_RI', 'Demo student RI'),
  ('11111111-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-0000000000cc', 'DEMO_HA', 'Demo student HA'),
  ('11111111-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-0000000000dd', 'DEMO_YU', 'Demo student YU');

insert into public.organizations (id, name, created_by)
values ('11111111-0000-0000-0000-000000000001', 'Aoi Gakuen Demo', '11111111-0000-0000-0000-00000000000d');
-- (bootstrap trigger added the admin membership)

insert into public.organization_members (org_id, member_user_id, role)
values ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-00000000000e', 'educator');

insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
select '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-00000000000e', p.id, p.owner_user_id, 'active'
from public.participants p where p.id::text like '11111111-%';

-- Consents: KO, RI, HA grant; YU stays pending (default-deny demo).
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
select p.id, p.owner_user_id, '11111111-0000-0000-0000-000000000001'
from public.participants p
where p.id in (
  '11111111-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-0000000000b1',
  '11111111-0000-0000-0000-0000000000c1'
);

-- ---------------------------------------------------------------------------
-- Derived data: two weeks of insights + safety runs. No raw text anywhere.
-- ---------------------------------------------------------------------------

-- KO: settled — steady low signal, active yesterday.
insert into public.insights (owner_user_id, participant_id, day, anomaly_score, graph_summary_json)
select '11111111-0000-0000-0000-0000000000aa', '11111111-0000-0000-0000-0000000000a1',
  (current_date - offs)::date, 0.6 + (offs % 3) * 0.1,
  '{"key_nodes": [{"label": "club activities"}, {"label": "steady sleep"}]}'::jsonb
from generate_series(1, 12, 3) as offs;

-- RI: review spike — recent scores above the 2.0 threshold.
insert into public.insights (owner_user_id, participant_id, day, anomaly_score, graph_summary_json)
values
  ('11111111-0000-0000-0000-0000000000bb', '11111111-0000-0000-0000-0000000000b1', current_date - 1, 2.4,
   '{"key_nodes": [{"label": "exam pressure"}, {"label": "short sleep"}]}'),
  ('11111111-0000-0000-0000-0000000000bb', '11111111-0000-0000-0000-0000000000b1', current_date - 3, 2.1,
   '{"key_nodes": [{"label": "exam pressure"}, {"label": "skipped lunch"}]}'),
  ('11111111-0000-0000-0000-0000000000bb', '11111111-0000-0000-0000-0000000000b1', current_date - 6, 1.1,
   '{"key_nodes": [{"label": "exam pressure"}]}');

-- HA: crisis safety flag on the latest reflection.
insert into public.insights (owner_user_id, participant_id, day, anomaly_score, graph_summary_json)
values
  ('11111111-0000-0000-0000-0000000000cc', '11111111-0000-0000-0000-0000000000c1', current_date - 1, 1.6,
   '{"key_nodes": [{"label": "feeling isolated"}, {"label": "conflict at home"}]}'),
  ('11111111-0000-0000-0000-0000000000cc', '11111111-0000-0000-0000-0000000000c1', current_date - 4, 1.2,
   '{"key_nodes": [{"label": "feeling isolated"}]}');

insert into public.model_runs (owner_user_id, participant_id, artifact_type, provider, model, prompt_version, retrieval_config_json)
values
  ('11111111-0000-0000-0000-0000000000cc', '11111111-0000-0000-0000-0000000000c1', 'safety_assessment',
   'rules', 'safety-assessment-v1', 'safety-assessment-v1',
   '{"risk_level": "crisis", "escalation_required": true, "reasons": ["support_seeking_disclosure"], "policy_refs": ["safety-policy-1"]}'),
  ('11111111-0000-0000-0000-0000000000bb', '11111111-0000-0000-0000-0000000000b1', 'safety_assessment',
   'rules', 'safety-assessment-v1', 'safety-assessment-v1',
   '{"risk_level": "none", "escalation_required": false, "reasons": [], "policy_refs": []}');

-- YU: inactive — one old reflection (12 days ago), no consent granted.
insert into public.insights (owner_user_id, participant_id, day, anomaly_score, graph_summary_json)
values
  ('11111111-0000-0000-0000-0000000000dd', '11111111-0000-0000-0000-0000000000d1', current_date - 12, 0.9,
   '{"key_nodes": [{"label": "part-time job"}]}');

commit;

select 'EDUCATOR DEMO SEEDED — educator@demo.blesc / demo-blesc-2026' as result;
