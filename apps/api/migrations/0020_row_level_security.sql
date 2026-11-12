-- The Supabase Data API serves every table in public to anyone holding the project's publishable key, through the
-- anon and authenticated roles. Nothing in Stallkeeper uses that API: the service connects to Postgres directly as
-- the role that owns these tables, and an owner bypasses row-level security unless it is forced. Turning it on with
-- no policies therefore closes the Data API and leaves the service as it was (ADR 0006). Never force it: with no
-- policies, a forced table would refuse the service too.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- Local and test databases are plain Postgres with no Supabase roles.
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
  end if;
end $$;
