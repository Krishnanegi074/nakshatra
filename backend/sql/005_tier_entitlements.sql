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
