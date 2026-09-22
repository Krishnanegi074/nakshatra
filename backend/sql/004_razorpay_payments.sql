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
