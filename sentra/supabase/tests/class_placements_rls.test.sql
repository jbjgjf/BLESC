-- クラス・出席番号 (#466) の RLS テスト。
--
-- 教員に見せる生徒の識別を、氏名からクラス・出席番号へ置き換えた
-- (20261018000000_class_placements_and_minimal_roster.sql)。ここで確かめること:
--
--   1. `overseen_participants()` は display_name を返さず、クラスと出席番号を返す。
--      未設定の生徒は NULL で返る（画面は「クラス未設定」と出す）。
--   2. 書けるのは組織の管理者だけで、その組織の名簿に載っている生徒に限る。
--   3. 同じ学校で同じクラス・出席番号は二人に付けられない。
--   4. 教員はテーブルを直接読めない。生徒本人は自分の行だけ読める。
--   5. 別の組織の管理者は読めず、書けない。
--
-- Run against a local Supabase database with all migrations applied:
--   supabase db reset   (from sentra/)
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/class_placements_rls.test.sql
--
-- One transaction, rolled back. Every assertion raises on violation.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values
  ('46600000-0000-0000-0000-00000000000a', 'student-a@test.local'),
  ('46600000-0000-0000-0000-00000000000b', 'student-b@test.local'),
  ('46600000-0000-0000-0000-00000000000c', 'student-c@test.local'),
  ('46600000-0000-0000-0000-00000000000e', 'educator@test.local'),
  ('46600000-0000-0000-0000-00000000000d', 'org-admin@test.local'),
  ('46600000-0000-0000-0000-00000000000f', 'other-admin@test.local');

-- display_name is set on purpose: the point is that it does not reach the educator.
insert into public.participants (id, owner_user_id, code, display_name)
values
  ('46600000-0000-0000-0000-0000000000a1', '46600000-0000-0000-0000-00000000000a', 'STUDENT_A', '山田 太郎'),
  ('46600000-0000-0000-0000-0000000000b1', '46600000-0000-0000-0000-00000000000b', 'STUDENT_B', '佐藤 花子'),
  ('46600000-0000-0000-0000-0000000000c1', '46600000-0000-0000-0000-00000000000c', 'STUDENT_C', '鈴木 次郎');

-- ---------------------------------------------------------------------------
-- 1. The function's shape: no display_name, class and number instead
-- ---------------------------------------------------------------------------

do $$
declare
  result text := pg_get_function_result('public.overseen_participants()'::regprocedure);
begin
  if result ilike '%display_name%' then
    raise exception 'FAIL: overseen_participants still returns display_name: %', result;
  end if;
  if result not ilike '%class_label text%' or result not ilike '%attendance_number integer%' then
    raise exception 'FAIL: overseen_participants does not return class and number: %', result;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Org admin sets up the school through RLS: org, educator, roster (A, B).
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "46600000-0000-0000-0000-00000000000d", "role": "authenticated"}';

insert into public.organizations (id, name, created_by)
values ('46600000-0000-0000-0000-000000000001', 'Test School 466', '46600000-0000-0000-0000-00000000000d');

insert into public.organization_members (org_id, member_user_id, role)
values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-00000000000e', 'educator');

insert into public.oversight_roster (org_id, educator_user_id, participant_id, owner_user_id, status)
values
  ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-00000000000e',
   '46600000-0000-0000-0000-0000000000a1', '46600000-0000-0000-0000-00000000000a', 'active'),
  ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-00000000000e',
   '46600000-0000-0000-0000-0000000000b1', '46600000-0000-0000-0000-00000000000b', 'active');

-- ---------------------------------------------------------------------------
-- 2. The admin writes a placement for a rostered student, and only for one.
-- ---------------------------------------------------------------------------

insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000a1',
        '46600000-0000-0000-0000-00000000000a', '2-3', 12);

do $$
begin
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000c1',
            '46600000-0000-0000-0000-00000000000c', '2-3', 13);
    raise exception 'FAIL: admin placed a student who is not on the org roster';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- 3. Two students cannot share a class and number in one school.
do $$
begin
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000b1',
            '46600000-0000-0000-0000-00000000000b', '2-3', 12);
    raise exception 'FAIL: two students were given 2-3 12番 in the same school';
  exception
    when unique_violation then null; -- expected
  end;
end $$;

-- An update keeps the roster check too.
update public.class_placements set attendance_number = 14
 where participant_id = '46600000-0000-0000-0000-0000000000a1';

do $$
begin
  if (select attendance_number from public.class_placements
       where participant_id = '46600000-0000-0000-0000-0000000000a1') <> 14 then
    raise exception 'FAIL: admin could not update a placement';
  end if;
end $$;

-- Students A and B consent (B has no placement yet).
set local request.jwt.claims = '{"sub": "46600000-0000-0000-0000-00000000000a", "role": "authenticated"}';
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('46600000-0000-0000-0000-0000000000a1', '46600000-0000-0000-0000-00000000000a',
        '46600000-0000-0000-0000-000000000001');

-- 4b. The student reads their own row, and cannot write one.
do $$
begin
  if (select count(*) from public.class_placements) <> 1 then
    raise exception 'FAIL: student A should see exactly their own placement';
  end if;
  begin
    update public.class_placements set attendance_number = 1;
    if (select attendance_number from public.class_placements) <> 14 then
      raise exception 'FAIL: student A changed their own attendance number';
    end if;
  end;
end $$;

set local request.jwt.claims = '{"sub": "46600000-0000-0000-0000-00000000000b", "role": "authenticated"}';
insert into public.oversight_consents (participant_id, owner_user_id, org_id)
values ('46600000-0000-0000-0000-0000000000b1', '46600000-0000-0000-0000-00000000000b',
        '46600000-0000-0000-0000-000000000001');

do $$
begin
  if (select count(*) from public.class_placements) <> 0 then
    raise exception 'FAIL: student B sees another student''s placement';
  end if;
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000b1',
            '46600000-0000-0000-0000-00000000000b', '2-3', 1);
    raise exception 'FAIL: a student wrote their own placement';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 1b / 4a. The educator: class and number through the function, never the
-- name, and no direct access to the table.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "46600000-0000-0000-0000-00000000000e", "role": "authenticated"}';

do $$
declare
  a record;
  b record;
begin
  if (select count(*) from public.overseen_participants()) <> 2 then
    raise exception 'FAIL: educator should oversee 2 students';
  end if;
  select * into a from public.overseen_participants() where participant_id = '46600000-0000-0000-0000-0000000000a1';
  if a.class_label is distinct from '2-3' or a.attendance_number is distinct from 14 then
    raise exception 'FAIL: educator got % %, expected 2-3 14', a.class_label, a.attendance_number;
  end if;
  select * into b from public.overseen_participants() where participant_id = '46600000-0000-0000-0000-0000000000b1';
  if b.class_label is not null or b.attendance_number is not null then
    raise exception 'FAIL: an unset placement should come back as NULL, got % %', b.class_label, b.attendance_number;
  end if;
  if exists (select 1 from public.overseen_participants() p where row_to_json(p)::text like '%山田%') then
    raise exception 'FAIL: the student''s name reached the educator';
  end if;

  if (select count(*) from public.class_placements) <> 0 then
    raise exception 'FAIL: educator reads class_placements directly';
  end if;
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000b1',
            '46600000-0000-0000-0000-00000000000b', '2-3', 2);
    raise exception 'FAIL: an educator wrote a placement';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Another org's admin can neither read nor write this school's placements.
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "46600000-0000-0000-0000-00000000000f", "role": "authenticated"}';

insert into public.organizations (id, name, created_by)
values ('46600000-0000-0000-0000-000000000002', 'Other Org 466', '46600000-0000-0000-0000-00000000000f');

do $$
begin
  if (select count(*) from public.class_placements) <> 0 then
    raise exception 'FAIL: another org''s admin reads this school''s placements';
  end if;
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000002', '46600000-0000-0000-0000-0000000000a1',
            '46600000-0000-0000-0000-00000000000a', '1-1', 1);
    raise exception 'FAIL: an admin placed a student who is on no roster of theirs';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into public.class_placements (org_id, participant_id, owner_user_id, class_label, attendance_number)
    values ('46600000-0000-0000-0000-000000000001', '46600000-0000-0000-0000-0000000000b1',
            '46600000-0000-0000-0000-00000000000b', '1-1', 1);
    raise exception 'FAIL: an admin wrote into another org';
  exception
    when insufficient_privilege then null; -- expected
  end;
end $$;

reset role;

select 'ALL CLASS PLACEMENT RLS TESTS PASSED' as result;

rollback;
