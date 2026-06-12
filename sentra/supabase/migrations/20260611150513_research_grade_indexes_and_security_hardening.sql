do $$
declare
  fk record;
  index_name text;
begin
  for fk in
    select
      con.conname,
      con.conrelid::regclass as table_name,
      string_agg(quote_ident(att.attname), ', ' order by key_position.ordinality) as column_list
    from pg_constraint con
    join pg_namespace nsp on nsp.oid = con.connamespace
    join unnest(con.conkey) with ordinality as key_position(attnum, ordinality) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = key_position.attnum
    where con.contype = 'f'
      and nsp.nspname = 'public'
    group by con.conname, con.conrelid
  loop
    index_name := left(
      'idx_' || replace(fk.table_name::text, '.', '_') || '_' || fk.conname,
      63
    );
    execute format(
      'create index if not exists %I on %s (%s)',
      index_name,
      fk.table_name,
      fk.column_list
    );
  end loop;
end $$;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from anon';
    execute 'revoke execute on function public.rls_auto_enable() from authenticated';
    execute 'revoke execute on function public.rls_auto_enable() from public';
  end if;
end $$;
