-- ============================================================================
-- Nakshatra — Google Play Billing for the Android app (013)
--
-- Why this exists: Google Play policy requires any app-side purchase of
-- digital content/features to go through Google Play's own billing system
-- (see support.google.com/googleplay/android-developer/answer/9858738) —
-- Razorpay checkout, as used on the website, isn't allowed inside the
-- Android app once it leaves Internal testing. This migration adds a SECOND,
-- parallel crediting path for the exact same two paid features
-- (004_razorpay_payments.sql's report tiers, 009_expert_chat.sql's expert
-- sessions), driven by a verified Google Play purchase instead of a verified
-- Razorpay payment. The web app keeps using Razorpay untouched; the Android
-- app's app.js now calls the Play path instead when running natively — see
-- the isNativeApp() branch in app/app.js's initCheckout()/initExpertChat().
--
-- How it works, end to end (no "create order" step — unlike Razorpay, Play
-- Billing purchases are started directly against a product already priced
-- in the Play Console, so there's nothing to look up first):
--   1. The Android app calls the @capawesome-team/capacitor-purchases plugin
--      directly to buy a product id (report_onetime / report_bundle /
--      report_subscription / expert_session) — Google Play handles the
--      actual payment UI natively, no Nakshatra server involved yet.
--   2. The plugin resolves with a purchase token. The client sends that
--      token (never a price, never "did it succeed") to one of the two new
--      Edge Functions below.
--   3. That Edge Function calls the Google Play Developer API itself
--      (server-to-server, using a service account — see SETUP.md) to ask
--      Google directly whether this token is real and paid for. Only THEN
--      does it call the matching complete_play_*() function here to credit
--      the purchase — same "never trust the client" shape as
--      complete_razorpay_order().
--
-- Gifting a report (state.giftInProgress in app.js) is deliberately OUT of
-- scope here — Play Billing ties a purchase to the Google account that paid
-- for it, and there's no clean "buy this for someone else" primitive the
-- way Razorpay's flat checkout allows. The Android app's gift flow still
-- shows the gift screens (unchanged), but app.js's native branch refuses to
-- start a Play purchase when state.giftInProgress is set and tells the
-- customer to send gifts from the website instead — see the comment at that
-- branch in app.js for the full reasoning.
--
-- How to apply: same as every other file in this folder — Supabase project
-- -> SQL Editor -> New query -> paste this whole file -> Run. Run it after
-- 004_razorpay_payments.sql and 009_expert_chat.sql (needs purchases,
-- unlocks, and chat_sessions, all created there).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- play_purchases: one row per Google Play purchase token this backend has
-- ever been asked to verify. Exists for the same reason razorpay_orders
-- does — it's what lets a retried/duplicate verify call recognize "I've
-- already credited this exact token" instead of crediting it twice (Play
-- Billing clients are expected to retry a purchase-acknowledgement call
-- that didn't get a clean response, so this WILL happen in normal use, not
-- just as an edge case). purchase_token is Google's own id for the
-- purchase and is therefore the primary key, the same way razorpay_orders
-- keys off Razorpay's order_id.
-- ---------------------------------------------------------------------------
create table public.play_purchases (
  purchase_token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  product_type text not null check (product_type in ('report','expert_session')),
  tier text check (tier in ('onetime','bundle','subscription')),  -- null for expert_session
  amount_paise int not null,
  status text not null default 'created' check (status in ('created','verified','failed')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

alter table public.play_purchases enable row level security;

-- Deliberately NO policies and NO grant to authenticated/anon — same
-- reasoning as razorpay_orders in 004_razorpay_payments.sql. Only the two
-- Edge Functions below (service_role key) ever touch this table.

-- Widen the existing payment_method check (004_razorpay_payments.sql already
-- widened it once for Razorpay's own method names) to also accept Play
-- Billing purchases.
alter table public.purchases drop constraint if exists purchases_payment_method_check;
alter table public.purchases add constraint purchases_payment_method_check
  check (payment_method in ('upi','card','netbanking','wallet','emi','paylater','google_play'));

-- chat_sessions.razorpay_order_id is nullable and only ever set for a
-- Razorpay-backed session (009_expert_chat.sql) — add a sibling nullable
-- column the same way for a Play-backed session instead. A session has
-- exactly one of the two set; nothing enforces that with a CHECK because
-- both columns being null never happens in practice (every session is
-- created by one of the two complete_*_session_order() functions, each of
-- which sets only its own column) and a strict XOR constraint would be one
-- more thing to keep in sync by hand for no real safety benefit here.
alter table public.chat_sessions add column play_purchase_token text references public.play_purchases(purchase_token);

-- ---------------------------------------------------------------------------
-- complete_play_report_purchase(): the Play-Billing twin of
-- complete_razorpay_order()'s non-gift branch. Only ever called by
-- verify-play-report-purchase/index.ts, using the service_role key, AFTER
-- it has independently confirmed the purchase with Google's own API — this
-- function itself does not (and can't) re-check that, so it must never be
-- reachable from anywhere else (see the missing grant at the bottom).
--
-- Idempotent on purpose, same reasoning as complete_razorpay_order().
-- ---------------------------------------------------------------------------
create or replace function public.complete_play_report_purchase(
  p_user_id uuid,
  p_purchase_token text,
  p_product_id text,
  p_tier text,
  p_amount_paise int
)
returns table (tier text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing public.play_purchases;
begin
  select * into v_existing from public.play_purchases where purchase_token = p_purchase_token for update;

  if found then
    if v_existing.user_id is distinct from p_user_id then
      raise exception 'TOKEN_OWNED_BY_ANOTHER_USER';
    end if;
    -- Already credited by an earlier call — hand back the same tier rather
    -- than crediting a second time.
    return query select v_existing.tier;
    return;
  end if;

  insert into public.play_purchases (purchase_token, user_id, product_id, product_type, tier, amount_paise, status, verified_at)
  values (p_purchase_token, p_user_id, p_product_id, 'report', p_tier, p_amount_paise, 'verified', now());

  insert into public.purchases (user_id, tier, amount_paise, payment_method, status)
  values (p_user_id, p_tier, p_amount_paise, 'google_play', 'google_play_success');

  insert into public.unlocks (user_id, unlocked, tier, source)
  values (p_user_id, true, p_tier, 'purchase')
  on conflict (user_id) do update set unlocked = true, tier = excluded.tier, source = 'purchase', updated_at = now();

  return query select p_tier;
end;
$$;

comment on function public.complete_play_report_purchase(uuid, text, text, text, int) is
  'Credits a Google-Play-verified report purchase. Callable ONLY via the service_role key from supabase/functions/verify-play-report-purchase/index.ts, AFTER it independently confirms the purchase token with the Google Play Developer API — deliberately NOT granted to authenticated.';

revoke execute on function public.complete_play_report_purchase(uuid, text, text, text, int) from public, anon, authenticated;
-- Same gotcha 012_lock_down_functions.sql fixed for the Razorpay-era
-- functions: Supabase grants EXECUTE on new public-schema functions to
-- anon/authenticated explicitly at creation time, separately from the
-- PUBLIC pseudo-role — revoking only "from public" does not remove those.
-- This function takes p_user_id as a plain parameter and trusts its caller
-- entirely (by design — the Google-verification already happened in the
-- edge function), so leaving it reachable by authenticated would let any
-- signed-in user credit an arbitrary purchase to any user id. Only
-- service_role may ever call it.
grant execute on function public.complete_play_report_purchase(uuid, text, text, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- complete_play_expert_session_order(): the Play-Billing twin of
-- complete_expert_session_order() in 009_expert_chat.sql — same
-- online-and-free expert matching loop, same NO_EXPERT_AVAILABLE failure
-- mode (the caller, verify-play-expert-session-purchase/index.ts, must
-- react to that by consuming/refunding the Play purchase the same way the
-- Razorpay path issues a refund — see that file for how).
-- ---------------------------------------------------------------------------
create or replace function public.complete_play_expert_session_order(
  p_user_id uuid,
  p_purchase_token text,
  p_product_id text,
  p_amount_paise int
)
returns table (session_id uuid, expert_name text, expert_specialty text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing public.play_purchases;
  v_expert_id uuid;
  v_expert_name text;
  v_expert_specialty text;
  v_candidate record;
  v_new_session_id uuid;
begin
  select * into v_existing from public.play_purchases where purchase_token = p_purchase_token for update;

  if found then
    if v_existing.user_id is distinct from p_user_id then
      raise exception 'TOKEN_OWNED_BY_ANOTHER_USER';
    end if;
    return query
      select cs.id, e.name, e.specialty
      from public.chat_sessions cs join public.experts e on e.id = cs.expert_id
      where cs.play_purchase_token = p_purchase_token
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
    -- Same race as complete_expert_session_order()'s own comment: the Play
    -- purchase already succeeded by the time this runs. Record it as
    -- 'failed' so the Edge Function can tell this case apart from a brand
    -- new token and knows to consume/refund it via the Play Developer API.
    insert into public.play_purchases (purchase_token, user_id, product_id, product_type, amount_paise, status)
    values (p_purchase_token, p_user_id, p_product_id, 'expert_session', p_amount_paise, 'failed');
    raise exception 'NO_EXPERT_AVAILABLE';
  end if;

  insert into public.play_purchases (purchase_token, user_id, product_id, product_type, amount_paise, status, verified_at)
  values (p_purchase_token, p_user_id, p_product_id, 'expert_session', p_amount_paise, 'verified', now());

  insert into public.chat_sessions (user_id, expert_id, amount_paise, play_purchase_token)
  values (p_user_id, v_expert_id, p_amount_paise, p_purchase_token)
  returning id into v_new_session_id;

  return query select v_new_session_id, v_expert_name, v_expert_specialty;
end;
$$;

comment on function public.complete_play_expert_session_order(uuid, text, text, int) is
  'Credits a Google-Play-verified expert-chat session. Callable ONLY via the service_role key from supabase/functions/verify-play-expert-session-purchase/index.ts, AFTER it independently confirms the purchase token with the Google Play Developer API — deliberately NOT granted to authenticated.';

revoke execute on function public.complete_play_expert_session_order(uuid, text, text, int) from public, anon, authenticated;
-- Same reasoning as complete_play_report_purchase() above.
grant execute on function public.complete_play_expert_session_order(uuid, text, text, int) to service_role;

-- ----------------------------------------------------------------------------
-- IMPORTANT — same caveat every prior payments migration in this folder
-- carries: this could not be run against a real Supabase project, and
-- obviously could not be tested against a real Google Play purchase, from
-- the sandbox this was written in (no network access to supabase.co or
-- Google's APIs from here). Before relying on this in Closed testing or
-- Production: create a real Play Billing product, make one License-Tester
-- test purchase on a real device, and confirm in the Supabase Table Editor
-- that play_purchases goes created -> verified (or 'failed' for the
-- NO_EXPERT_AVAILABLE path), a purchases row appears with payment_method
-- 'google_play', and unlocks / chat_sessions update correctly — same
-- end-to-end check 004_razorpay_payments.sql asked for on the Razorpay side.
-- ----------------------------------------------------------------------------
