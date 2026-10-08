-- ============================================================================
-- Nakshatra — combined migrations 004, 005, 009, 010
-- For the real project where 002/003/006/007/008 are already applied
-- (confirmed: profiles exists, chat_messages_all_own policy exists,
-- profiles.name exists) but 004/005/009/010 are not yet (confirmed:
-- razorpay_orders, user_entitlements, experts, chat_sessions all absent).
--
-- Order: 004 -> 005 -> 009 -> 010.
--   004 must precede 005 (005 replaces functions 004 defines and needs
--   razorpay_orders to already exist).
--   009 needs razorpay_orders (004) and chat_messages_all_own (002, already
--   applied) to exist; its own header says order vs 005 doesn't matter, so
--   placing it after 005 is fine.
--   010 needs chat_sessions (009) and profiles (002, already applied).
--
-- NOTE: unlike 009/010, 004 is NOT purely additive on a live project — it
-- drops the gift_codes_insert_own policy (the old direct-insert gift flow
-- stops working the moment this runs) and widens purchases.payment_method's
-- check constraint. Confirm this is acceptable / that the Razorpay Edge
-- Functions are already deployed before running this against production.
-- ============================================================================

-- ############################################################################
-- ## 004_razorpay_payments.sql
-- ############################################################################
-- ============================================================================
-- Nakshatra — real Razorpay payments (004)
--
-- Replaces the test-mode-only checkout (record_test_purchase(), which just
-- trusted whatever tier/amount the browser sent) with a flow backed by an
-- actual payment gateway. The frontend (app/supabase-client.js,
-- createRazorpayOrder / verifyRazorpayPayment) already calls two Edge
-- Functions that this migration's tables/functions exist to support:
--   supabase/functions/create-razorpay-order/index.ts
--   supabase/functions/verify-razorpay-payment/index.ts
--
-- How it works, end to end:
--   1. Client calls create-razorpay-order with {tier, gift?}. The Edge
--      Function looks up the REAL price for that tier itself (never trusts
--      a price from the browser), asks Razorpay to create an order, and
--      records it here in razorpay_orders as status='created'.
--   2. Razorpay Checkout pops up in the browser and the user actually pays.
--   3. Razorpay's own handler callback hands the browser
--      {razorpay_order_id, razorpay_payment_id, razorpay_signature}. The
--      client forwards that, untouched, to verify-razorpay-payment.
--   4. That Edge Function independently recomputes the HMAC signature with
--      the account's secret key (never present in the browser) and, only if
--      it matches, calls complete_razorpay_order() below — which is the
--      ONLY place a purchase row, an unlock, or a gift code backed by real
--      money gets written.
--
-- How to apply it: same as every other file in this folder — Supabase
-- project -> SQL Editor -> New query -> paste this whole file -> Run. Run it
-- AFTER 002_schema.sql (needs the purchases/unlocks/gift_codes tables it
-- created) and after 003_account_deletion.sql (order doesn't matter between
-- those two, but this one is additive on top of both).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- razorpay_orders: one row per order created with Razorpay, from the moment
-- checkout starts until the payment is (or isn't) verified. This is what
-- lets verify-razorpay-payment look up "what was this order actually FOR"
-- (whose purchase, which tier, how much, plain purchase vs. gift) using only
-- the order_id Razorpay hands back — never trusting that detail from the
-- browser a second time at the verification step.
-- ---------------------------------------------------------------------------
create table public.razorpay_orders (
  order_id text primary key,                            -- Razorpay's own id, e.g. "order_ABC123"
  user_id uuid not null references auth.users(id) on delete cascade,
  tier text not null check (tier in ('onetime','bundle','subscription')),
  amount_paise int not null,
  gift_recipient_name text,                              -- null => this is a self-purchase, not a gift
  gift_message text,
  status text not null default 'created' check (status in ('created','verified','failed')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

alter table public.razorpay_orders enable row level security;

-- Deliberately NO policies and NO grant to authenticated/anon here. This
-- table is only ever touched by the two Edge Functions above, using the
-- service_role key — which (per Supabase's default project setup) already
-- has full access to every table and function in this schema regardless of
-- RLS or explicit grants, the same way service_role can already reach
-- handle_new_user() in sql/002_schema.sql despite that function also having
-- no explicit grant. A logged-in user's own session (the anon/authenticated
-- keys the browser actually holds) gets exactly zero access to this table,
-- by design — it should never be readable or writable from client code.

-- Real payments can come back with more methods than the test-mode checkout
-- ever offered (upi/card/netbanking) — Razorpay's own widget also supports
-- wallets, EMI, and pay-later. Widen the existing check constraint rather
-- than dropping it, so purchases.payment_method still can't silently accept
-- garbage.
alter table public.purchases drop constraint if exists purchases_payment_method_check;
alter table public.purchases add constraint purchases_payment_method_check
  check (payment_method in ('upi','card','netbanking','wallet','emi','paylater'));

-- A gift code used to be insertable directly by any authenticated client
-- (gift_codes_insert_own, in sql/002_schema.sql) — that was fine when
-- sending a gift had no cost attached. Now that a gift is a real purchase,
-- the ONLY way a gift_codes row should ever be created is inside
-- complete_razorpay_order() below, after Razorpay has actually confirmed the
-- charge. Removing this policy means a raw `insert into gift_codes` from an
-- authenticated client now fails RLS — including the app's own sendGift() in
-- supabase-client.js, which is kept only for local/offline testing against
-- sql/001_local_shim.sql and is expected to fail against a real project from
-- here on.
drop policy if exists "gift_codes_insert_own" on public.gift_codes;

-- ---------------------------------------------------------------------------
-- complete_razorpay_order(): the only place a Razorpay-backed purchase
-- actually gets credited. Only ever called by verify-razorpay-payment/
-- index.ts, using the service_role key, AFTER it has independently verified
-- Razorpay's HMAC signature on the (order_id, payment_id) pair — this
-- function itself does not (and can't) re-check the signature, so it must
-- never be reachable from anywhere else. See the missing grant note below.
--
-- Idempotent on purpose: if the Edge Function's call gets retried (a
-- network blip between Razorpay confirming and the client hearing back is
-- exactly the kind of thing that happens with real payments), calling this
-- twice for the same order_id does NOT double-credit the user or mint a
-- second gift code — it just returns the same result as the first call.
-- ---------------------------------------------------------------------------
create or replace function public.complete_razorpay_order(
  p_order_id text,
  p_payment_id text,
  p_payment_method text
)
returns table (tier text, gift_code text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_order public.razorpay_orders;
  v_code text;
begin
  select * into v_order from public.razorpay_orders where order_id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.status = 'verified' then
    -- Already completed by an earlier call (see the idempotency note
    -- above) — hand back the gift code that was generated that first time
    -- instead of silently doing nothing, so a retried client call still
    -- gets a usable response.
    return query
      select v_order.tier, gc.code
      from public.gift_codes gc
      where v_order.gift_recipient_name is not null
        and gc.sender_id = v_order.user_id
        and gc.tier = v_order.tier
        and gc.recipient_name = v_order.gift_recipient_name
        and gc.created_at >= v_order.verified_at - interval '1 minute'
      order by gc.created_at desc
      limit 1;
    if found then
      return;
    end if;
    return query select v_order.tier, null::text;
    return;
  end if;

  update public.razorpay_orders
    set status = 'verified', verified_at = now()
    where order_id = p_order_id;

  insert into public.purchases (user_id, tier, amount_paise, payment_method, status)
  values (v_order.user_id, v_order.tier, v_order.amount_paise, p_payment_method, 'razorpay_success');

  if v_order.gift_recipient_name is not null then
    -- Same code shape as the client's own generateGiftCode() in app.js
    -- (NKSH-XXXX-XXXX, no ambiguous 0/O/1/I) — generated server-side here
    -- since this is the one path a gift code is allowed to actually exist
    -- from now on.
    -- floor(...)::int, NOT ...::int alone — casting a float straight to int
    -- in Postgres ROUNDS to nearest rather than truncating, so
    -- (random()*32)::int can land on 32 itself (e.g. random() = 0.999...),
    -- one past this 32-character alphabet's last valid substr() position.
    -- substr() on an out-of-range position silently returns '' rather than
    -- erroring, which was shortening that character to nothing instead of
    -- raising anything — caught by tests/run-rls-tests.sh's gift-purchase
    -- check when it occasionally produced a 3-character group.
    loop
      v_code := 'NKSH-'
        || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), '') from generate_series(1, 4))
        || '-'
        || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), '') from generate_series(1, 4));
      exit when not exists (select 1 from public.gift_codes where code = v_code);
    end loop;

    insert into public.gift_codes (code, sender_id, tier, recipient_name, message)
    values (v_code, v_order.user_id, v_order.tier, v_order.gift_recipient_name, v_order.gift_message);

    return query select v_order.tier, v_code;
  else
    insert into public.unlocks (user_id, unlocked, tier, source)
    values (v_order.user_id, true, v_order.tier, 'purchase')
    on conflict (user_id) do update set unlocked = true, tier = excluded.tier, source = 'purchase', updated_at = now();

    return query select v_order.tier, null::text;
  end if;
end;
$$;

comment on function public.complete_razorpay_order(text, text, text) is
  'Credits a Razorpay-verified purchase (unlock, or a gift code for a gift purchase). Callable ONLY via the service_role key from supabase/functions/verify-razorpay-payment/index.ts, AFTER it independently verifies Razorpay''s payment signature — deliberately NOT granted to authenticated, since nothing in this function''s own arguments proves a real payment happened.';

-- No `grant execute ... to authenticated` for complete_razorpay_order(),
-- deliberately. Unlike record_test_purchase() (still granted, in
-- sql/002_schema.sql — harmless since it was always test-mode-only and the
-- app no longer calls it), this function trusts p_order_id/p_payment_id
-- completely and credits whatever razorpay_orders row they point at. If a
-- logged-in user could call this directly, they could unlock any tier for
-- free just by guessing or replaying an order_id — the signature check that
-- makes this safe happens entirely inside the Edge Function, one layer
-- above, using a secret key the browser never has.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default —
-- that's true locally even though a real Supabase project's own default
-- privileges keep newly created functions un-exposed until explicitly
-- granted (see backend/supabase/config.toml's auto_expose_new_tables note).
-- Rather than lean on that platform default for the one function in this
-- whole schema that must never be client-callable, revoke it explicitly so
-- this is true everywhere this migration runs, not just on Supabase.
revoke execute on function public.complete_razorpay_order(text, text, text) from public;

-- ----------------------------------------------------------------------------
-- IMPORTANT — same caveat as sql/003_account_deletion.sql: this could not be
-- run against a real Supabase project or a real Razorpay account from the
-- sandbox this was written in (no network access to either supabase.co or
-- api.razorpay.com from here — see SETUP.md). The RLS/grant reasoning above
-- follows the exact pattern already verified for real in
-- tests/run-rls-tests.sh for the rest of this schema, but the one thing that
-- genuinely proves this works end to end is a real test payment: create a
-- Razorpay test-mode account, use one of Razorpay's published test card/UPI
-- numbers, and confirm in the Supabase Table Editor that razorpay_orders
-- goes created -> verified, a purchases row appears with status
-- 'razorpay_success', and unlocks (or gift_codes, for a gift) updates
-- correctly. Do that before switching the Razorpay account from test mode to
-- live keys.
-- ----------------------------------------------------------------------------


-- ############################################################################
-- ## 005_tier_entitlements.sql
-- ############################################################################
-- ============================================================================
-- Nakshatra — tier-specific entitlements (005)
--
-- Replaces public.unlocks (one boolean + one `tier` column per user, SILENTLY
-- OVERWRITTEN by every new purchase/redemption — see the `on conflict (user_id)
-- do update set tier = excluded.tier` clauses in 002_schema.sql's
-- record_test_purchase()/redeem_gift_code() and 004_razorpay_payments.sql's
-- complete_razorpay_order()) with public.user_entitlements: one row per
-- (user_id, tier) a user has actually purchased or been gifted, so owning the
-- ₹299 Horoscope Access Pass and later buying the ₹399 One-Time Report keeps
-- BOTH, instead of the second purchase silently erasing the first. This is
-- the #1 fix requested in the full-site QA pass: "Replace the single
-- `unlocked` boolean with tier-specific entitlements."
--
-- How to apply: same as every other file in this folder — Supabase project
-- -> SQL Editor -> New query -> paste this whole file -> Run. Run it AFTER
-- 002_schema.sql, 003_account_deletion.sql, and 004_razorpay_payments.sql.
-- Apply it BEFORE (or in the same release as) deploying the updated
-- app/supabase-client.js + app/app.js in this same change, since those now
-- read from user_entitlements instead of unlocks.
-- ============================================================================

create table public.user_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  tier text not null check (tier in ('onetime','bundle','subscription')),
  source text not null check (source in ('purchase','gift')),
  granted_at timestamptz not null default now(),
  primary key (user_id, tier)
);

alter table public.user_entitlements enable row level security;

create policy "user_entitlements_select_own" on public.user_entitlements
  for select to authenticated
  using (user_id = auth.uid());

-- Same reasoning as public.unlocks before it: no insert/update/delete policy
-- and no insert/update/delete grant. Only the security-definer functions
-- below (grant_entitlement + the three purchase/redeem entry points that
-- call it) can ever write a row here.
grant select on public.user_entitlements to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: carry forward whatever's already recorded, so nobody who
-- previously purchased loses access the moment this migration runs.
--
-- Pass 1, from public.unlocks: covers the common case (one tier per user).
-- Pass 2, from public.purchases (which — unlike unlocks — never overwrote
-- anything): also recovers a user who genuinely bought more than one
-- DIFFERENT tier over time, which pass 1 alone can't, since unlocks only
-- ever remembered the most recent one.
-- Both are `on conflict do nothing`, so running this file twice is safe.
-- ---------------------------------------------------------------------------
insert into public.user_entitlements (user_id, tier, source, granted_at)
select user_id, tier, coalesce(source, 'purchase'), updated_at
from public.unlocks
where unlocked = true and tier is not null
on conflict (user_id, tier) do nothing;

insert into public.user_entitlements (user_id, tier, source, granted_at)
select user_id, tier, 'purchase', min(created_at)
from public.purchases
where status in ('razorpay_success', 'test_mode_success')
group by user_id, tier
on conflict (user_id, tier) do nothing;

-- ---------------------------------------------------------------------------
-- grant_entitlement(): the one place a user_entitlements row is ever added.
-- Idempotent (on conflict do nothing) — granting a tier the user already has
-- is a no-op, not an error, matching complete_razorpay_order()'s own
-- idempotency guarantee for retried calls.
-- ---------------------------------------------------------------------------
create or replace function public.grant_entitlement(p_user_id uuid, p_tier text, p_source text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_entitlements (user_id, tier, source)
  values (p_user_id, p_tier, p_source)
  on conflict (user_id, tier) do nothing;
end;
$$;

revoke execute on function public.grant_entitlement(uuid, text, text) from public;
-- Not granted to `authenticated` either, deliberately — this must only ever
-- be called from the other security-definer functions below, which have
-- already verified a real purchase or a valid, not-self, not-already-redeemed
-- gift code. A client that could call this directly could grant itself any
-- tier for free.

-- ---------------------------------------------------------------------------
-- record_test_purchase() — replaces the version in 002_schema.sql (test-mode
-- only; no real money moves; harmless to leave callable) to grant a
-- tier-specific entitlement instead of overwriting public.unlocks.
-- ---------------------------------------------------------------------------
create or replace function public.record_test_purchase(p_tier text, p_amount_paise int, p_payment_method text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.purchases (user_id, tier, amount_paise, payment_method, status)
  values (auth.uid(), p_tier, p_amount_paise, p_payment_method, 'test_mode_success');

  perform public.grant_entitlement(auth.uid(), p_tier, 'purchase');
end;
$$;

-- ---------------------------------------------------------------------------
-- redeem_gift_code() — replaces the version in 002_schema.sql to grant a
-- tier-specific entitlement instead of overwriting public.unlocks. Every
-- validation rule (not found / already redeemed / can't self-redeem) is
-- unchanged.
-- ---------------------------------------------------------------------------
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

  perform public.grant_entitlement(auth.uid(), v_row.tier, 'gift');

  return query select v_row.tier, v_row.recipient_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_razorpay_order() — replaces the version in 004_razorpay_payments.sql
-- to grant a tier-specific entitlement instead of overwriting public.unlocks.
-- Everything else (idempotency on a retried call, gift-code minting for a
-- gift order) is unchanged from 004.
-- ---------------------------------------------------------------------------
create or replace function public.complete_razorpay_order(
  p_order_id text,
  p_payment_id text,
  p_payment_method text
)
returns table (tier text, gift_code text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_order public.razorpay_orders;
  v_code text;
begin
  select * into v_order from public.razorpay_orders where order_id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.status = 'verified' then
    return query
      select v_order.tier, gc.code
      from public.gift_codes gc
      where v_order.gift_recipient_name is not null
        and gc.sender_id = v_order.user_id
        and gc.tier = v_order.tier
        and gc.recipient_name = v_order.gift_recipient_name
        and gc.created_at >= v_order.verified_at - interval '1 minute'
      order by gc.created_at desc
      limit 1;
    if found then
      return;
    end if;
    return query select v_order.tier, null::text;
    return;
  end if;

  update public.razorpay_orders
    set status = 'verified', verified_at = now()
    where order_id = p_order_id;

  insert into public.purchases (user_id, tier, amount_paise, payment_method, status)
  values (v_order.user_id, v_order.tier, v_order.amount_paise, p_payment_method, 'razorpay_success');

  if v_order.gift_recipient_name is not null then
    loop
      v_code := 'NKSH-'
        || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), '') from generate_series(1, 4))
        || '-'
        || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), '') from generate_series(1, 4));
      exit when not exists (select 1 from public.gift_codes where code = v_code);
    end loop;

    insert into public.gift_codes (code, sender_id, tier, recipient_name, message)
    values (v_code, v_order.user_id, v_order.tier, v_order.gift_recipient_name, v_order.gift_message);

    return query select v_order.tier, v_code;
  else
    perform public.grant_entitlement(v_order.user_id, v_order.tier, 'purchase');
    return query select v_order.tier, null::text;
  end if;
end;
$$;

-- Unchanged reasoning from 004: never grant this to `authenticated` or `public`.
revoke execute on function public.complete_razorpay_order(text, text, text) from public;

-- public.unlocks itself is left in place (not dropped) so this migration
-- stays additive/low-risk and a rollback is just "go back to the versions of
-- these three functions defined in 002/004". Drop it in a later migration
-- once user_entitlements has been live for a while with no issues.

-- ----------------------------------------------------------------------------
-- IMPORTANT — same caveat as 003/004: this could not be run against a real
-- Supabase project from the sandbox it was written in (no network access to
-- supabase.co from here). Apply it via the Supabase SQL Editor, then verify:
--   1. An existing user who had unlocks.unlocked = true still appears in
--      user_entitlements after the backfill (check both INSERT statements
--      above ran without error and returned the row count you expect).
--   2. A fresh test purchase of one tier, followed by a test purchase of a
--      DIFFERENT tier by the same test user, leaves BOTH rows in
--      user_entitlements — this is the actual bug this migration fixes;
--      confirm it doesn't regress.
--   3. redeem_gift_code() and complete_razorpay_order() still return the
--      same shape (tier, gift_code) / (tier, recipient_name) the frontend
--      already expects — this migration doesn't change their signatures,
--      only what they write internally.
-- ----------------------------------------------------------------------------


-- ############################################################################
-- ## 009_expert_chat.sql
-- ############################################################################
-- ============================================================================
-- Nakshatra — real expert chat: schema (009)
--
-- Phase 1 of the real-expert-chat feature (see the plan this was built
-- from — matching, flat-fee Razorpay payment, a separate expert web
-- dashboard, Realtime delivery). This file is schema + the one piece of
-- business logic that MUST live in the database rather than an Edge
-- Function: the atomic "find and claim a free expert" match, which has to
-- happen under a row lock to be race-safe (see complete_expert_session_order()
-- below).
--
-- This does NOT touch or remove the existing demo chat (chat_messages rows
-- with astrologer_id set, ASTROLOGERS/generateAstrologerReply() in
-- app.js/rules.js) — that keeps working exactly as it does today. It adds a
-- second, parallel way to use the SAME chat_messages table: rows with
-- session_id set instead of astrologer_id, belonging to a real paid
-- chat_sessions row instead of a simulated conversation.
--
-- How to apply: same as every other file here — Supabase project -> SQL
-- Editor -> New query -> paste this whole file -> Run. Run it after
-- 002_schema.sql and 004_razorpay_payments.sql (needs chat_messages,
-- razorpay_orders, and the purchases/handle_new_user machinery those set
-- up). Order relative to 005/006/007/008 doesn't matter.
--
-- After running this, see the SEEDING THE TEST EXPERT block at the very
-- bottom for the one manual step (creating the actual auth account) this
-- file can't do for you.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- experts: one row per real expert. `id` IS their auth.users.id — an expert
-- signs in through the exact same Supabase Auth as a customer, just on a
-- separate login page (the expert dashboard), and this table is what turns
-- "a signed-in user" into "a signed-in user who's allowed to see the expert
-- dashboard and get matched to paying customers".
--
-- Deliberately NOT self-serve: nothing in this migration lets a client
-- INSERT into experts. An account only becomes an expert because someone
-- with direct database access (you, via the SQL Editor or Table Editor) put
-- a row here — see the seeding block at the bottom. This is the one place
-- in the whole schema where "signed up" and "has access" are intentionally
-- different things.
-- ---------------------------------------------------------------------------
create table public.experts (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  specialty text not null,
  is_online boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.experts enable row level security;

-- An expert can read and update their OWN row (the dashboard's online/
-- offline toggle is just `update experts set is_online = ... where id =
-- auth.uid()`, which this policy is what actually allows).
create policy "experts_select_own" on public.experts
  for select to authenticated
  using (id = auth.uid());

create policy "experts_update_own" on public.experts
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Customers need to know WHETHER anyone is online before they pay — that's
-- new territory for this schema (every other table so far is strictly
-- single-owner-only). Rather than open the real `experts` table to broad
-- reads (which would also expose every expert's row to every other expert,
-- not just customers), expose a narrow view with no email/PII: just enough
-- to render "N experts online" / a name+specialty once matched. Same
-- pattern as community_feed in 002_schema.sql.
create view public.experts_public as
select id, name, specialty, is_online from public.experts;

grant select on public.experts_public to authenticated;
grant select, update (is_online, name, specialty) on public.experts to authenticated;

-- ---------------------------------------------------------------------------
-- chat_sessions: one row per paid expert-chat session. Rows are created
-- ONLY by complete_expert_session_order() below, after a verified Razorpay
-- payment — never by a direct client insert (no insert grant to
-- authenticated at all, same "the only way in is through the
-- security-definer function" pattern 004_razorpay_payments.sql uses for
-- gift_codes).
-- ---------------------------------------------------------------------------
create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expert_id uuid not null references public.experts(id),
  status text not null default 'active' check (status in ('active','ended')),
  amount_paise int not null,
  razorpay_order_id text references public.razorpay_orders(order_id),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

alter table public.chat_sessions enable row level security;

-- Two separate policies (Postgres OR's every applicable policy together for
-- a given role/command), one per side of the conversation, rather than one
-- policy with an OR inside it — easier to read, and easier to reason about
-- independently if one side's rules ever need to change.
create policy "chat_sessions_select_customer" on public.chat_sessions
  for select to authenticated
  using (user_id = auth.uid());

create policy "chat_sessions_select_expert" on public.chat_sessions
  for select to authenticated
  using (expert_id = auth.uid());

-- Either side can end a session ("End Session" button — see the build
-- plan's v1 default: no auto-timeout). Column-level grants below restrict
-- this to ONLY status/ended_at — a customer or expert updating their own
-- visible row can't rewrite amount_paise or reassign expert_id, which a
-- blanket `using (user_id = auth.uid())` UPDATE policy would otherwise
-- allow (RLS's USING/WITH CHECK constrain which ROWS you can touch, not
-- which COLUMNS within them — that's what column-level grants are for).
create policy "chat_sessions_update_customer" on public.chat_sessions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "chat_sessions_update_expert" on public.chat_sessions
  for update to authenticated
  using (expert_id = auth.uid())
  with check (expert_id = auth.uid());

grant select on public.chat_sessions to authenticated;
grant update (status, ended_at) on public.chat_sessions to authenticated;
-- No insert/delete grant, deliberately — see the table comment above.

-- ---------------------------------------------------------------------------
-- chat_messages: extend the existing demo table rather than build a new
-- one. A row now belongs to EITHER the old demo shape (astrologer_id set,
-- session_id null — completely unchanged, existing chat_messages_all_own
-- policy still governs these exactly as before) OR a real session
-- (session_id set, astrologer_id null) — never both, never neither.
-- ---------------------------------------------------------------------------
alter table public.chat_messages add column session_id uuid references public.chat_sessions(id) on delete cascade;
alter table public.chat_messages alter column astrologer_id drop not null;
alter table public.chat_messages add constraint chat_messages_demo_xor_session
  check ((astrologer_id is not null) <> (session_id is not null));

-- chat_messages_all_own (sql/002_schema.sql) predates session_id and,
-- being a blanket "user_id = auth.uid() -> do anything" PERMISSIVE policy,
-- doesn't care about `sender` or `session_id` at all. Left as-is it would
-- silently defeat chat_messages_session_participants' sender-role rule
-- below: PostgreSQL ORs every applicable PERMISSIVE policy's WITH CHECK
-- together, and a customer's own session rows always have user_id equal to
-- their own id (by design — see that policy's comment), so this older
-- policy would ALWAYS let them through regardless of what sender they
-- claim, regardless of what the new policy says. Re-scope it to demo rows
-- only (session_id is null — always true for a demo row, per the XOR
-- constraint above, so this is a no-op for existing demo behavior) so it
-- no longer applies to real sessions at all; chat_messages_session_
-- participants becomes the ONLY policy governing those.
drop policy "chat_messages_all_own" on public.chat_messages;
create policy "chat_messages_all_own" on public.chat_messages
  for all to authenticated
  using (user_id = auth.uid() and session_id is null)
  with check (user_id = auth.uid() and session_id is null);

-- The one new policy this whole feature actually hinges on: lets a SECOND
-- real user (the assigned expert) read and write into a conversation that
-- isn't "their own" by the original user_id = auth.uid() rule. This is
-- additive — chat_messages_all_own above still applies unchanged to every
-- demo row (now explicitly scoped to those), and to a customer's own
-- real-session rows
-- too (user_id is always the customer's id — see the WITH CHECK below —
-- so chat_messages_all_own alone already covers the customer's own read/
-- write access to their real-session messages; this policy's job is
-- specifically to let the EXPERT in as well).
--
-- WITH CHECK also pins `sender` to match who's actually writing: a
-- customer can only ever insert sender='user' rows here, an expert only
-- sender='astro' — unlike the demo, where the customer's own session
-- writes BOTH sides to simulate the conversation. That's the one place
-- real-session behavior deliberately diverges from demo behavior, and it's
-- enforced here, not just by client code choosing to behave.
create policy "chat_messages_session_participants" on public.chat_messages
  for all to authenticated
  using (
    session_id is not null
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = chat_messages.session_id
        and (cs.user_id = auth.uid() or cs.expert_id = auth.uid())
    )
  )
  with check (
    session_id is not null
    -- NOTE: chat_sessions (aliased cs below) has its own user_id column, so
    -- this comparison MUST be qualified on both sides — an unqualified
    -- `user_id = cs.user_id` here would resolve the left side to cs.user_id
    -- too (a subquery's own FROM-clause columns shadow the outer query's),
    -- silently collapsing this into an always-true `cs.user_id = cs.user_id`
    -- and defeating the whole check.
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = chat_messages.session_id
        and chat_messages.user_id = cs.user_id
        and (
          (cs.user_id = auth.uid() and sender = 'user')
          or (cs.expert_id = auth.uid() and sender = 'astro')
        )
    )
  );

-- ---------------------------------------------------------------------------
-- razorpay_orders: widen to cover a second kind of purchase. `product`
-- distinguishes what an order is FOR; `tier` only applies to product =
-- 'report' (the razorpay_orders_tier_matches_product constraint enforces
-- this pairing — NULL already satisfies the original `tier in (...)` check
-- as-is, per standard SQL NULL-in-CHECK semantics, so that original
-- constraint from 002_schema.sql needs no change).
-- ---------------------------------------------------------------------------
alter table public.razorpay_orders add column product text not null default 'report' check (product in ('report','expert_session'));
alter table public.razorpay_orders alter column tier drop not null;
alter table public.razorpay_orders add constraint razorpay_orders_tier_matches_product
  check ((product = 'report' and tier is not null) or (product = 'expert_session' and tier is null));

-- ---------------------------------------------------------------------------
-- complete_expert_session_order(): the ONLY place a chat_sessions row gets
-- created. Mirrors complete_razorpay_order()'s shape exactly (same
-- signature, same idempotency-on-retry handling, same "only reachable via
-- service_role from the verify Edge Function" lockdown below) — the one
-- genuinely new piece is the locked matching loop.
--
-- THE RACE CONDITION THIS EXISTS TO PREVENT: two customers paying at
-- almost the same instant must never both get matched to the same expert.
-- The fix is walking online experts in a FIXED order (order by id — same
-- order for every concurrent call, which is what makes them actually
-- contend with each other instead of racing past each other) and locking
-- each candidate with FOR UPDATE one at a time. Whoever's transaction
-- acquires a given expert's lock SECOND re-checks "does this expert already
-- have an active session?" FRESH, after acquiring the lock — never trusting
-- the loop's original WHERE clause, which FOR UPDATE does NOT force
-- Postgres to re-evaluate once a lock is granted. That fresh re-check is
-- what makes this correct rather than just "probably fine most of the
-- time". (Locks acquired this way are held until the transaction ends, so
-- with a LARGE pool of online experts under heavy concurrent load this
-- would serialize more than strictly necessary — a non-issue at the scale
-- of a handful of experts, worth revisiting only if that ever changes.)
-- ---------------------------------------------------------------------------
create or replace function public.complete_expert_session_order(
  p_order_id text,
  p_payment_id text,
  p_payment_method text
)
returns table (session_id uuid, expert_name text, expert_specialty text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_order public.razorpay_orders;
  v_expert_id uuid;
  v_expert_name text;
  v_expert_specialty text;
  v_candidate record;
  v_new_session_id uuid;
begin
  select * into v_order from public.razorpay_orders where order_id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.product is distinct from 'expert_session' then
    raise exception 'WRONG_ORDER_TYPE';
  end if;

  if v_order.status = 'verified' then
    -- Idempotent retry (see complete_razorpay_order()'s own comment for why
    -- this matters for real payments) — hand back the session already
    -- created the first time around, rather than erroring or trying to
    -- match a second one for the same payment.
    return query
      select cs.id, e.name, e.specialty
      from public.chat_sessions cs join public.experts e on e.id = cs.expert_id
      where cs.razorpay_order_id = p_order_id
      order by cs.created_at desc limit 1;
    return;
  end if;

  for v_candidate in
    select id, name, specialty from public.experts where is_online = true order by id for update
  loop
    if not exists (
      select 1 from public.chat_sessions
      where expert_id = v_candidate.id and status = 'active'
    ) then
      v_expert_id := v_candidate.id;
      v_expert_name := v_candidate.name;
      v_expert_specialty := v_candidate.specialty;
      exit;
    end if;
  end loop;

  if v_expert_id is null then
    -- Every online expert got claimed by someone else in the window between
    -- this order being created and payment clearing, or nobody came online
    -- in that window at all. The payment already succeeded on Razorpay's
    -- side by the time this is called — verify-expert-session-payment/
    -- index.ts must catch this exact error and issue a Razorpay refund
    -- (see the build plan's flagged item on this exact scenario). This is
    -- NOT the "no experts online" case the customer already saw before
    -- paying — that's checked client-side, pre-payment, against
    -- experts_public, purely for UX; this is the rarer race where that
    -- earlier check is now stale.
    raise exception 'NO_EXPERT_AVAILABLE';
  end if;

  update public.razorpay_orders set status = 'verified', verified_at = now() where order_id = p_order_id;

  insert into public.chat_sessions (user_id, expert_id, amount_paise, razorpay_order_id)
  values (v_order.user_id, v_expert_id, v_order.amount_paise, p_order_id)
  returning id into v_new_session_id;

  return query select v_new_session_id, v_expert_name, v_expert_specialty;
end;
$$;

comment on function public.complete_expert_session_order(text, text, text) is
  'Verifies+claims a Razorpay-paid expert-chat session: atomically matches the caller to a free online expert and creates their chat_sessions row. Callable ONLY via the service_role key from supabase/functions/verify-expert-session-payment/index.ts, AFTER it independently verifies Razorpay''s payment signature — deliberately NOT granted to authenticated, same reasoning as complete_razorpay_order() in 004_razorpay_payments.sql.';

-- Same explicit revoke as complete_razorpay_order() in 004 — see that
-- file's comment for why this can't just rely on Supabase's real-project
-- default of not auto-exposing new functions (true on a real project, not
-- true for a plain `create function` against local Postgres, which grants
-- EXECUTE to PUBLIC by default).
revoke execute on function public.complete_expert_session_order(text, text, text) from public;

-- ---------------------------------------------------------------------------
-- Realtime: both the customer and the expert dashboard need INSERTs on
-- chat_messages to arrive live, and the expert dashboard needs INSERTs on
-- chat_sessions to arrive live too (a new session landing in their queue
-- without a manual refresh). Every Supabase project ships a
-- `supabase_realtime` publication already — this just adds these two
-- tables to it. (First time this codebase uses Realtime at all — nothing
-- to add for chat_messages' EXISTING demo rows, since nothing subscribes to
-- those.)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.chat_sessions;

-- ============================================================================
-- SEEDING THE TEST EXPERT
--
-- This migration deliberately does NOT hardcode the expert's email (or
-- any other expert's email) anywhere in application code — the email lives
-- ONLY in the Supabase Auth user record you create by hand, so swapping in
-- the real expert later is just "create a different auth user, insert a
-- different experts row", never a code change.
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user. Email
--    the expert's email, set a password (give it to whoever's testing
--    the expert dashboard), and use "Auto Confirm User" so it doesn't need
--    a real confirmation email.
-- 2. Copy the UUID that user gets assigned (shown in the Users list).
-- 3. SQL Editor -> run, with that UUID pasted in:
--
--      insert into public.experts (id, name, specialty, is_online)
--      values ('PASTE-THE-UUID-HERE', 'Test Expert', 'General readings', false);
--
-- That's it — this account can now sign in at the expert dashboard (once
-- built) and will show up as available whenever it toggles online.
--
-- Note for local/CI testing only: unlike every real Supabase project, the
-- local shim (001_local_shim.sql) has no real GoTrue signup flow — its own
-- auth.users rows are inserted directly by hand (see that file and
-- run-rls-tests.sh), so the "Add user" dashboard step above doesn't apply
-- there; a local test just inserts directly into the shim's auth.users the
-- same way Alice/Bob/Carol already are.
-- ============================================================================


-- ############################################################################
-- ## 010_expert_customer_name.sql
-- ############################################################################
-- ============================================================================
-- Nakshatra — expert dashboard: let an expert see their customer's name (010)
--
-- The gap this closes: public.profiles is strictly own-row-only
-- (profiles_select_own, sql/002_schema.sql) — nothing in
-- sql/009_expert_chat.sql opened an equivalent exception for an expert to
-- see the name of the customer they're actually assigned to. Without this,
-- the expert dashboard (expert/index.html) can only show
-- "Customer #a1b2c3d4" (a truncated user id) instead of a name.
--
-- Deliberately a separate migration rather than editing 009: that file just
-- passed 84/84 real local-Postgres checks (see SETUP.md), and reopening it
-- for what's genuinely an additive, independent piece of exposure risks
-- that verified baseline for no reason. This migration only ADDS a new
-- view + grant; it does not touch any table, policy, or function 009
-- created.
--
-- How to apply: same as every other file here — Supabase project -> SQL
-- Editor -> New query -> paste this whole file -> Run. Run it after
-- 009_expert_chat.sql (needs chat_sessions) and 002_schema.sql (needs
-- profiles).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- expert_customer_names: exactly one column of actual data (customer_name)
-- beyond the session_id it's keyed on — no email, no birth details, nothing
-- else from profiles. A plain Postgres view (not security_invoker) runs
-- with its OWNER's privileges by default, which is what lets this join
-- profiles at all despite profiles_select_own — same mechanism
-- community_feed (sql/002_schema.sql) already relies on to compute a
-- like_count across every user's community_likes rows. What keeps this
-- narrow isn't the owner-privilege execution itself, it's the `where
-- cs.expert_id = auth.uid()` below: that clause evaluates auth.uid() as
-- the CALLING user on every query regardless of view ownership, so a
-- given expert only ever gets rows for sessions actually assigned to them
-- — never another expert's, never every customer's name in one query.
-- ---------------------------------------------------------------------------
create view public.expert_customer_names as
select cs.id as session_id, p.name as customer_name
from public.chat_sessions cs
join public.profiles p on p.id = cs.user_id
where cs.expert_id = auth.uid();

grant select on public.expert_customer_names to authenticated;


