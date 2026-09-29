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
