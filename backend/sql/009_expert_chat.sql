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
-- This migration deliberately does NOT hardcode krishnanegikdp@gmail.com (or
-- any other expert's email) anywhere in application code — the email lives
-- ONLY in the Supabase Auth user record you create by hand, so swapping in
-- the real expert later is just "create a different auth user, insert a
-- different experts row", never a code change.
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user. Email
--    krishnanegikdp@gmail.com, set a password (give it to whoever's testing
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
