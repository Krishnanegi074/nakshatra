-- ============================================================================
-- Nakshatra — Database schema + Row Level Security policies
--
-- This is the REAL, PORTABLE schema. It assumes it is being run against an
-- actual Supabase project, which already provides the `auth` schema,
-- `auth.uid()`, and the `anon` / `authenticated` / `service_role` roles.
--
-- How to apply it to a real project:
--   1. Create a free project at supabase.com (takes ~2 minutes).
--   2. Open Project -> SQL Editor -> New query.
--   3. Paste this entire file in and click Run.
-- That's it — every table, policy, and function below gets created in one go.
--
-- Do NOT run sql/001_local_shim.sql against a real project — that file is a
-- stand-in for local testing only and would conflict with Supabase's real
-- auth schema.
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles: one row per user, mirrors auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Auto-create a profile row the moment someone signs up (from the metadata
-- passed to supabase.auth.signUp), so the client never has to race a
-- separate insert against email confirmation / first login.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- birth_data: one row per user — birth details + the deterministic chart
-- computed from them (sun/moon/ascendant sign indexes, moon phase).
-- ---------------------------------------------------------------------------
create table public.birth_data (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  year int not null,
  month int not null,
  day int not null,
  hour int not null default 12,
  minute int not null default 0,
  unknown_time boolean not null default false,
  city_name text,
  city_country text,
  city_lat double precision,
  city_lon double precision,
  city_utc double precision,
  sun_idx int,
  moon_idx int,
  asc_idx int,
  moon_phase text,
  updated_at timestamptz not null default now()
);

alter table public.birth_data enable row level security;

create policy "birth_data_all_own" on public.birth_data
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- palm_reports: one row per user — palmistry Q&A answers + generated report
-- ---------------------------------------------------------------------------
create table public.palm_reports (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  report jsonb,
  updated_at timestamptz not null default now()
);

alter table public.palm_reports enable row level security;

create policy "palm_reports_all_own" on public.palm_reports
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- purchases: payment records. TEST MODE ONLY right now — see the note by
-- record_test_purchase() below before wiring up a real payment gateway.
-- ---------------------------------------------------------------------------
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tier text not null check (tier in ('onetime','bundle','subscription')),
  amount_paise int not null,
  payment_method text not null check (payment_method in ('upi','card','netbanking')),
  status text not null default 'test_mode_success',
  created_at timestamptz not null default now()
);

alter table public.purchases enable row level security;

create policy "purchases_select_own" on public.purchases
  for select to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE policy: rows are only ever written by the
-- record_test_purchase() function below (SECURITY DEFINER), which always
-- uses auth.uid() as the owner — so a client can never write a fake
-- "success" row for themselves via a raw table insert, and definitely can't
-- write one crediting another account.

-- ---------------------------------------------------------------------------
-- unlocks: what content a user currently has access to
-- ---------------------------------------------------------------------------
create table public.unlocks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unlocked boolean not null default false,
  tier text,
  source text check (source in ('purchase','gift')),
  updated_at timestamptz not null default now()
);

alter table public.unlocks enable row level security;

create policy "unlocks_select_own" on public.unlocks
  for select to authenticated
  using (user_id = auth.uid());

-- Same reasoning as purchases: no direct insert/update policy. Only
-- record_test_purchase() and redeem_gift_code() can flip this on, and both
-- always target auth.uid() — never an arbitrary user_id supplied by the client.

-- ---------------------------------------------------------------------------
-- gift_codes
-- ---------------------------------------------------------------------------
create table public.gift_codes (
  code text primary key,
  sender_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tier text not null check (tier in ('onetime','bundle','subscription')),
  recipient_name text not null,
  message text,
  redeemed boolean not null default false,
  redeemed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);

alter table public.gift_codes enable row level security;

-- Senders can see the status of codes THEY sent. Nobody gets SELECT access
-- to codes they didn't send — redemption goes through redeem_gift_code()
-- below (exact-code lookup inside the function), never a raw table read, so
-- codes can't be listed/enumerated by any client.
create policy "gift_codes_select_own_sent" on public.gift_codes
  for select to authenticated
  using (sender_id = auth.uid());

create policy "gift_codes_insert_own" on public.gift_codes
  for insert to authenticated
  with check (sender_id = auth.uid());

-- ---------------------------------------------------------------------------
-- chat_messages: astrologer chat (Phase 4 demo). Rule-based, template-driven
-- replies generated client-side — not an LLM — so both "user" and "astro"
-- rows for a conversation are written by the owning user's own session.
-- ---------------------------------------------------------------------------
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  astrologer_id text not null,
  sender text not null check (sender in ('user','astro')),
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "chat_messages_all_own" on public.chat_messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index chat_messages_user_astro_idx on public.chat_messages (user_id, astrologer_id, created_at);

-- ---------------------------------------------------------------------------
-- community_posts / community_likes
-- ---------------------------------------------------------------------------
create table public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  avatar text not null default '✦',
  sign_idx int not null,
  caption text not null,
  image_url text,
  created_at timestamptz not null default now()
);

alter table public.community_posts enable row level security;

create policy "community_posts_select_all" on public.community_posts
  for select to authenticated
  using (true);

create policy "community_posts_insert_own" on public.community_posts
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "community_posts_delete_own" on public.community_posts
  for delete to authenticated
  using (user_id = auth.uid());

create table public.community_likes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id uuid not null references public.community_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

alter table public.community_likes enable row level security;

create policy "community_likes_select_all" on public.community_likes
  for select to authenticated
  using (true);

create policy "community_likes_insert_own" on public.community_likes
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "community_likes_delete_own" on public.community_likes
  for delete to authenticated
  using (user_id = auth.uid());

-- Convenience view: posts + live like count + whether *I* liked it, so the
-- client can render the feed in one query instead of three.
create view public.community_feed as
select
  p.id, p.user_id, p.name, p.avatar, p.sign_idx, p.caption, p.image_url, p.created_at,
  (select count(*) from public.community_likes l where l.post_id = p.id) as like_count,
  exists (select 1 from public.community_likes l where l.post_id = p.id and l.user_id = auth.uid()) as liked_by_me
from public.community_posts p
order by p.created_at desc;

-- ---------------------------------------------------------------------------
-- Security-definer functions: the only way certain rows get written, so a
-- client can never grant itself paid access or redeem someone else's code
-- via a raw table write, no matter what it sends over the REST API.
-- ---------------------------------------------------------------------------

-- Record a TEST-MODE purchase (no real money moves) for the CALLING user
-- only, and flip their unlock on.
--
-- ** Before a real public launch: ** this function trusts its inputs, which
-- is fine ONLY because nothing here is backed by real money yet. Once a real
-- gateway (Razorpay/Stripe) is wired up, this must be replaced by a function
-- that is only ever called from a verified server-side webhook (using the
-- service_role key, never the anon/authenticated client key) after the
-- gateway confirms the charge actually succeeded — never trust a "payment
-- succeeded" claim coming directly from the browser.
create or replace function public.record_test_purchase(p_tier text, p_amount_paise int, p_payment_method text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.purchases (user_id, tier, amount_paise, payment_method, status)
  values (auth.uid(), p_tier, p_amount_paise, p_payment_method, 'test_mode_success');

  insert into public.unlocks (user_id, unlocked, tier, source)
  values (auth.uid(), true, p_tier, 'purchase')
  on conflict (user_id) do update set unlocked = true, tier = excluded.tier, source = 'purchase', updated_at = now();
end;
$$;

grant execute on function public.record_test_purchase(text, int, text) to authenticated;

-- Redeem a gift code for the CALLING user. Atomic (row-locked), fails
-- cleanly if the code doesn't exist, is already redeemed, or belongs to the
-- caller themselves.
create or replace function public.redeem_gift_code(p_code text)
returns table (tier text, recipient_name text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.gift_codes;
begin
  select * into v_row from public.gift_codes where code = p_code for update;

  if not found then
    raise exception 'GIFT_CODE_NOT_FOUND';
  end if;
  if v_row.redeemed then
    raise exception 'GIFT_CODE_ALREADY_REDEEMED';
  end if;
  if v_row.sender_id = auth.uid() then
    raise exception 'GIFT_CODE_SELF_REDEEM';
  end if;

  update public.gift_codes
    set redeemed = true, redeemed_by = auth.uid(), redeemed_at = now()
    where code = p_code;

  insert into public.unlocks (user_id, unlocked, tier, source)
  values (auth.uid(), true, v_row.tier, 'gift')
  on conflict (user_id) do update set unlocked = true, tier = excluded.tier, source = 'gift', updated_at = now();

  return query select v_row.tier, v_row.recipient_name;
end;
$$;

grant execute on function public.redeem_gift_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Base table privileges. RLS policies above filter which ROWS a statement
-- can touch — these grants are what allow the `authenticated` role to run
-- the statement at all. (Recent Supabase projects don't auto-expose new
-- tables to API roles by default, so this step is required.)
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.birth_data, public.palm_reports, public.purchases,
  public.unlocks, public.gift_codes, public.chat_messages,
  public.community_posts, public.community_likes
to authenticated;
grant select on public.community_feed to authenticated;
