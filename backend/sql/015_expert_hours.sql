-- Fixed daily hours for experts. The first real experts are people who
-- commit to a daily window ("6-10 pm IST") rather than being on call all
-- day, so availability now means: the expert flipped themselves online,
-- their dashboard is heartbeating (014_expert_presence.sql), AND the clock
-- (India Standard Time, fixed -- all customers and experts are in India)
-- is inside their window. NULL hours = no fixed window, i.e. exactly the
-- pre-015 behaviour (the existing Test Expert row is unaffected).
--
-- Hours are set by the site admin (SQL editor / the future add-expert
-- script), deliberately NOT by the expert: they are part of the written
-- agreement, so no column-level UPDATE grant is added for `authenticated`.
-- The dashboard can still READ its own hours -- 009 already grants table-
-- level SELECT, scoped to the expert's own row by experts_select_own.
--
-- To set hours (example: 6 pm to 10 pm IST):
--   update public.experts set hours_start = '18:00', hours_end = '22:00'
--   where id = '<expert uuid>';
-- A window may cross midnight (hours_start '22:00', hours_end '02:00').
-- hours_start = hours_end is treated as all day.

-- Fail loudly if 014 hasn't been applied yet (this file's view and function
-- both read last_seen_at).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'experts' and column_name = 'last_seen_at'
  ) then
    raise exception 'Run 014_expert_presence.sql before 015_expert_hours.sql';
  end if;
end
$$;

alter table public.experts add column if not exists hours_start time;
alter table public.experts add column if not exists hours_end time;

-- One definition of "inside the window", used by the experts_public view
-- and complete_expert_session_order() below (and, through the view, by
-- the create-expert-session-order pre-check). It reveals nothing -- it only
-- compares two times against the clock -- so, unlike the SECURITY DEFINER
-- functions in 012/013, it needs no EXECUTE lockdown.
create or replace function public.expert_within_hours(p_start time, p_end time)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when p_start is null or p_end is null then true
    when p_start = p_end then true
    when p_start < p_end then
      (now() at time zone 'Asia/Kolkata')::time >= p_start
      and (now() at time zone 'Asia/Kolkata')::time < p_end
    else
      (now() at time zone 'Asia/Kolkata')::time >= p_start
      or (now() at time zone 'Asia/Kolkata')::time < p_end
  end
$$;

-- experts_public: what customers see before paying. is_online now also
-- requires being inside daily hours, and the hours themselves are exposed
-- so the app can say "Experts are available 6 pm - 10 pm IST" when nobody
-- is on. New columns go at the END so CREATE OR REPLACE VIEW stays legal.
create or replace view public.experts_public as
select id, name, specialty,
  (is_online
    and last_seen_at is not null
    and last_seen_at > now() - interval '2 minutes'
    and public.expert_within_hours(hours_start, hours_end)) as is_online,
  hours_start, hours_end
from public.experts;

grant select on public.experts_public to authenticated;
-- The create-expert-session-order edge function now asks this view (so the
-- pre-check and the real matching share one definition of "available").
grant select on public.experts_public to service_role;

-- ---------------------------------------------------------------------------
-- complete_expert_session_order(): same as 014, plus the hours check in the
-- candidate query. Still the real enforcement point at payment time.
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
      and public.expert_within_hours(hours_start, hours_end)
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
    -- already gone stale (or its daily hours had just ended) by the time
    -- payment cleared. The payment already
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
  'Verifies+claims a Razorpay-paid expert-chat session: atomically matches the caller to a free online expert (is_online, a last_seen_at heartbeat within 2 minutes, AND inside the expert''s daily hours when they have any) and creates their chat_sessions row. Callable ONLY via the service_role key from supabase/functions/verify-expert-session-payment/index.ts, AFTER it independently verifies Razorpay''s payment signature — deliberately NOT granted to authenticated, same reasoning as complete_razorpay_order() in 004_razorpay_payments.sql.';

revoke execute on function public.complete_expert_session_order(text, text, text) from public, anon, authenticated;
grant execute on function public.complete_expert_session_order(text, text, text) to service_role;
