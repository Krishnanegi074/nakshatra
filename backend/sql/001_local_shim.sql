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

-- Auth.users normally gets rows via Supabase's real signup flow (GoTrue).
-- Here we just insert two test users directly for the RLS test harness.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com')
on conflict (id) do nothing;
