-- ============================================================================
-- LOCAL TESTING SHIM ONLY — never run this against a real Supabase project.
--
-- A real Supabase project already ships a real `auth` schema, a real
-- `auth.uid()`, and the `anon` / `authenticated` / `service_role` roles.
-- This sandbox can't run Supabase itself (Docker registries are blocked
-- here), so this file recreates just enough of that surface in plain local
-- Postgres to let sql/002_schema.sql's RLS policies be tested for real
-- before they ever touch a live project.
--
-- The `auth.uid()` implementation below is not a simplification — it is
-- exactly how Supabase implements it for real: read the `sub` claim out of
-- a `request.jwt.claims` GUC that PostgREST sets per request from the
-- caller's JWT. That means every RLS policy verified against this shim
-- behaves identically once pointed at the genuine auth.uid().
-- ============================================================================

create extension if not exists "pgcrypto";

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif((current_setting('request.jwt.claims', true))::json->>'sub', '')::uuid;
$$;

-- Test helper: call at the start of a session/transaction to make auth.uid()
-- behave as if this user were the one making the request — mirroring what
-- PostgREST does per-request in real Supabase.
create or replace function set_local_test_user(p_user_id uuid) returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user_id)::text, true);
$$;

create or replace function clear_local_test_user() returns void
language sql
as $$
  select set_config('request.jwt.claims', '', true);
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function set_local_test_user(uuid) to app_test_login;
grant execute on function clear_local_test_user() to app_test_login;

-- Every real Supabase project ships a `supabase_realtime` publication out
-- of the box; plain local Postgres has no such thing. Without this stub,
-- sql/009_expert_chat.sql's `alter publication supabase_realtime add table
-- ...` lines fail on a local run — and because a single -c/-f call runs its
-- whole SQL text as one implicit transaction, that failure would silently
-- roll back everything earlier in that same file too (the tables, RLS
-- policies, and function it defines), not just the two lines that actually
-- failed. Same idea as the fake `auth` schema above: just enough of the
-- real thing's surface to let real-project SQL run here unmodified.
-- CREATE PUBLICATION has no IF NOT EXISTS clause in Postgres, unlike most
-- other CREATE statements — hence the explicit existence check.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Auth.users normally gets rows via Supabase's real signup flow (GoTrue).
-- Here we just insert test users directly for the RLS test harness. Carol
-- (033...) is created fresh by run-rls-tests.sh's own trigger check, not
-- here. Expert/Expert2 (044.../055...) stand in for real expert accounts —
-- see sql/009_expert_chat.sql's chat_sessions/chat_messages tests, and
-- run-rls-tests.sh's complete_expert_session_order() checks (Expert2 exists
-- purely to give the concurrent-matching race test a second expert to
-- correctly match to, alongside Expert).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'expert@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'expert2@example.com')
on conflict (id) do nothing;
