-- Automatic end + refund when a matched expert never replies.
--
-- The gap this closes: a customer pays Rs.199, is matched to an expert
-- (014/015 make sure that expert is genuinely present and inside their
-- daily hours), sends their question... and the expert simply doesn't
-- answer (distracted, walked away with the tab open, phone call). Until now
-- the customer's only recourse was to end the session themselves and
-- complain, and the expert stayed blocked on that dead session (one live
-- session per expert at a time).
--
-- Rule (deliberately narrow, so it can never refund a conversation that
-- actually happened): an ACTIVE session where the customer has written at
-- least one message, the expert has written NONE, and the customer's first
-- message is more than `p_grace` old (default 5 minutes). Such a session is
-- ended (ended_reason = 'expert_silent', freeing the expert) and a refund is
-- queued. Not covered, on purpose: a customer who paid but never wrote
-- anything (nothing was asked, so nothing went unanswered), and an expert
-- who replied once and then went quiet (a real conversation started; that
-- is a judgement call for support, not an automatic refund).
--
-- How it runs: the edge function sweep-silent-expert-sessions calls the two
-- functions below once a minute (scheduled with pg_cron + pg_net; see
-- backend/sql/optional_schedule_silent_sweep.sql and SETUP.md), issues the
-- Razorpay refund, and records the outcome here. Run AFTER 009 and 013.

-- ---------------------------------------------------------------------------
-- chat_sessions.ended_reason: why a session ended. Only the sweep sets it
-- today ('expert_silent'); the customer app reads it from the realtime
-- UPDATE event to explain what happened. NOT added to the column-level
-- UPDATE grant 009 gave authenticated (status, ended_at), so neither a
-- customer nor an expert can write it.
-- ---------------------------------------------------------------------------
alter table public.chat_sessions
  add column if not exists ended_reason text
  check (ended_reason in ('customer', 'expert', 'expert_silent'));

-- ---------------------------------------------------------------------------
-- expert_session_refunds: the refund ledger. Separate from chat_sessions on
-- purpose: customers and experts can SELECT their own chat_sessions rows
-- (including via Realtime), and a refund's retry bookkeeping / raw gateway
-- errors are internal. RLS is on with NO policies and every grant to
-- anon/authenticated is revoked, so only the service_role key (the edge
-- function, the SQL Editor) can touch it.
--   pending  - waiting for the sweep to refund it (retried every minute)
--   refunded - Razorpay confirmed
--   manual   - not a Razorpay payment (Google Play purchase): refund it by
--              hand in the Play Console
--   failed   - gave up after max attempts: look at last_error, refund by hand
-- ---------------------------------------------------------------------------
create table if not exists public.expert_session_refunds (
  session_id uuid primary key references public.chat_sessions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'refunded', 'manual', 'failed')),
  amount_paise int not null,
  razorpay_order_id text,
  play_purchase_token text,
  refund_id text,
  attempts int not null default 0,
  leased_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);

alter table public.expert_session_refunds enable row level security;

-- Supabase's project-level automation can hand new public tables to
-- anon/authenticated; restate the lockdown (same bug class as 012/013).
revoke all on public.expert_session_refunds from public, anon, authenticated;
grant select, insert, update on public.expert_session_refunds to service_role;

-- ---------------------------------------------------------------------------
-- claim_silent_expert_sessions(): atomically end every qualifying session
-- and queue its refund. Safe to run concurrently or repeatedly (rows are
-- taken with FOR UPDATE SKIP LOCKED and an ended session never qualifies
-- again). A reply the expert sends in the same millisecond window as this
-- statement can be missed by its snapshot - accepted: the cost is a refund
-- for a conversation that was a hair away from starting.
-- ---------------------------------------------------------------------------
create or replace function public.claim_silent_expert_sessions(
  p_grace interval default interval '5 minutes',
  p_limit int default 20
)
returns table (claimed_session_id uuid)
language plpgsql
security definer set search_path = public
as $$
#variable_conflict use_column
begin
  return query
  with silent as (
    select cs.id
    from public.chat_sessions cs
    where cs.status = 'active'
      and exists (
        select 1 from public.chat_messages m
        where m.session_id = cs.id and m.sender = 'user'
      )
      and not exists (
        select 1 from public.chat_messages m
        where m.session_id = cs.id and m.sender = 'astro'
      )
      and (
        select min(m.created_at) from public.chat_messages m
        where m.session_id = cs.id and m.sender = 'user'
      ) < now() - p_grace
    order by cs.created_at
    limit p_limit
    for update of cs skip locked
  ),
  ended as (
    update public.chat_sessions cs
       set status = 'ended', ended_at = now(), ended_reason = 'expert_silent'
      from silent
     where cs.id = silent.id
    returning cs.id, cs.amount_paise, cs.razorpay_order_id, cs.play_purchase_token
  ),
  queued as (
    insert into public.expert_session_refunds
      (session_id, amount_paise, razorpay_order_id, play_purchase_token, status)
    select id, amount_paise, razorpay_order_id, play_purchase_token,
           case when razorpay_order_id is null then 'manual' else 'pending' end
    from ended
    returning session_id
  )
  select q.session_id from queued q;
end;
$$;

comment on function public.claim_silent_expert_sessions(interval, int) is
  'Ends active expert-chat sessions where the customer wrote but the expert never replied within p_grace, and queues a refund for each in expert_session_refunds. Callable ONLY via service_role (the sweep-silent-expert-sessions edge function) - it ends sessions and starts refunds, so it must never be reachable by anon/authenticated.';

revoke execute on function public.claim_silent_expert_sessions(interval, int) from public, anon, authenticated;
grant execute on function public.claim_silent_expert_sessions(interval, int) to service_role;

-- ---------------------------------------------------------------------------
-- lease_expert_refunds(): hand the sweep a batch of pending refunds, each
-- leased for p_lease so two overlapping sweeps can never refund the same
-- session twice. Each lease counts as an attempt; after p_max_attempts a
-- still-pending row is parked as 'failed' for a human.
-- ---------------------------------------------------------------------------
create or replace function public.lease_expert_refunds(
  p_limit int default 10,
  p_lease interval default interval '3 minutes',
  p_max_attempts int default 8
)
returns table (
  leased_session_id uuid,
  amount_paise int,
  razorpay_order_id text,
  attempts int
)
language plpgsql
security definer set search_path = public
as $$
#variable_conflict use_column
begin
  update public.expert_session_refunds r
     set status = 'failed',
         last_error = coalesce(r.last_error, 'gave up after ' || p_max_attempts || ' attempts')
   where r.status = 'pending'
     and r.attempts >= p_max_attempts
     and (r.leased_at is null or r.leased_at < now() - p_lease);

  return query
  update public.expert_session_refunds r
     set attempts = r.attempts + 1, leased_at = now()
   where r.session_id in (
     select r2.session_id from public.expert_session_refunds r2
     where r2.status = 'pending'
       and r2.attempts < p_max_attempts
       and (r2.leased_at is null or r2.leased_at < now() - p_lease)
     order by r2.created_at
     limit p_limit
     for update skip locked
   )
  returning r.session_id, r.amount_paise, r.razorpay_order_id, r.attempts;
end;
$$;

comment on function public.lease_expert_refunds(int, interval, int) is
  'Leases a batch of pending expert-session refunds to the sweep-silent-expert-sessions edge function so overlapping runs never refund one session twice. Callable ONLY via service_role.';

revoke execute on function public.lease_expert_refunds(int, interval, int) from public, anon, authenticated;
grant execute on function public.lease_expert_refunds(int, interval, int) to service_role;
