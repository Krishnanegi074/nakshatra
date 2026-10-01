-- Give the experts.is_online toggle a presence heartbeat behind it, so it
-- can actually be trusted. Before this, is_online was a plain boolean an
-- expert flipped by hand in the dashboard — if their tab died, they lost
-- connection, or their laptop just closed, the flag stayed true forever,
-- with no way for the matching logic (or a paying customer) to tell the
-- "online" expert wasn't really there anymore.
--
-- last_seen_at is updated by a heartbeat from the dashboard every ~30s
-- while an expert is online (see expert/index.html's startHeartbeat()).
-- Anywhere "is this expert really available" matters now checks BOTH
-- is_online = true AND a last_seen_at within the last 2 minutes — a
-- stale/dead session quietly stops being matched within a couple of
-- minutes instead of indefinitely, and self-heals the moment the
-- dashboard reconnects (no manual "mark yourself online again" needed).

alter table public.experts add column if not exists last_seen_at timestamptz;

-- The heartbeat is a plain client-side update from the expert's own
-- session, same path as the existing is_online toggle — needs the same
-- column-level grant 009_expert_chat.sql gave is_online/name/specialty.
-- experts_update_own's RLS (id = auth.uid()) already scopes it to the
-- expert's own row; this just adds the new column to what that policy is
-- allowed to touch.
grant update (last_seen_at) on public.experts to authenticated;

-- ---------------------------------------------------------------------------
-- experts_public: what a customer checks before paying (the "experts
-- online" indicator). Redefine it so a stale expert reads as offline here
-- too, not just in the real matching function below — customers never need
-- the raw timestamp, only an honest yes/no.
-- ---------------------------------------------------------------------------
create or replace view public.experts_public as
select id, name, specialty,
  (is_online and last_seen_at is not null and last_seen_at > now() - interval '2 minutes') as is_online
from public.experts;

-- CREATE OR REPLACE VIEW preserves an existing view's grants when its
-- column list is compatible (it is here), but this restates it explicitly
-- so this migration's intent is clear on its own, without having to
-- cross-reference 009_expert_chat.sql to confirm it's still anon-free,
-- authenticated-only.
grant select on public.experts_public to authenticated;

-- ---------------------------------------------------------------------------
-- complete_expert_session_order(): the actual enforcement point, since it
-- runs at payment-verification time after money has already moved. Same
-- body as 009_expert_chat.sql's version, with one change — the matching
-- loop's candidate query now requires a recent heartbeat too, not just the
-- raw flag.
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
    select id, name, specialty from public.experts
    where is_online = true
      and last_seen_at is not null
      and last_seen_at > now() - interval '2 minutes'
    order by id for update
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
    -- this order being created and payment clearing, nobody came online in
    -- that window at all, or the only "online" expert's heartbeat had
    -- already gone stale by the time payment cleared. The payment already
    -- succeeded on Razorpay's side by the time this is called —
    -- verify-expert-session-payment/index.ts must catch this exact error
    -- and issue a Razorpay refund (see the build plan's flagged item on
    -- this exact scenario). This is NOT the "no experts online" case the
    -- customer already saw before paying — that's checked client-side,
    -- pre-payment, against experts_public, purely for UX; this is the
    -- rarer race where that earlier check is now stale.
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
  'Verifies+claims a Razorpay-paid expert-chat session: atomically matches the caller to a free online expert (is_online AND a last_seen_at heartbeat within 2 minutes) and creates their chat_sessions row. Callable ONLY via the service_role key from supabase/functions/verify-expert-session-payment/index.ts, AFTER it independently verifies Razorpay''s payment signature — deliberately NOT granted to authenticated, same reasoning as complete_razorpay_order() in 004_razorpay_payments.sql.';

-- Re-stated defensively, not just inherited. CREATE OR REPLACE FUNCTION
-- preserves an existing function's privileges when the signature doesn't
-- change — but 012_lock_down_functions.sql's whole header comment exists
-- because Supabase's real-project auto-grant behavior (EXECUTE to
-- anon/authenticated on new public-schema functions) is a background
-- project-level automation this codebase has been bitten by twice already
-- (012 for the original 4 functions, 013 for the 2 Play Billing ones).
-- Whether a REPLACE re-triggers it the same way a bare CREATE does isn't
-- worth gambling on for a function that moves real money — restate the
-- lockdown every time this function's body changes, full stop.
revoke execute on function public.complete_expert_session_order(text, text, text) from public, anon, authenticated;
grant execute on function public.complete_expert_session_order(text, text, text) to service_role;
