-- ============================================================================
-- Nakshatra — self-service account deletion (003)
--
-- Adds delete_own_account(), called from the app's Settings screen so a user
-- can permanently delete their own account and every row of their data in
-- one action — the "right to erasure" a real app storing real PII (name,
-- email, birth date/time/place) should offer, and something India's DPDP
-- Act 2023 in particular expects apps to support.
--
-- How to apply it: same as 002_schema.sql — Supabase project -> SQL Editor
-- -> New query -> paste this whole file -> Run. It only ADDS a function; it
-- doesn't touch any existing table, so it's safe to run any time after
-- 002_schema.sql is already in place.
-- ============================================================================

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Gift codes this user REDEEMED (sent by someone else) reference them via
  -- redeemed_by, which has no "on delete cascade" — deleting auth.users
  -- below would otherwise fail with a foreign-key violation. Releasing the
  -- reference here just forgets who redeemed the code; the code stays
  -- marked redeemed and the sender's own record is untouched.
  update public.gift_codes set redeemed_by = null where redeemed_by = uid;

  -- Deleting the auth user cascades — via the "on delete cascade" already
  -- defined on every foreign key in sql/002_schema.sql — to remove:
  -- profiles, birth_data, palm_reports, purchases, unlocks, gift_codes this
  -- user SENT, chat_messages, community_posts, and community_likes. One
  -- statement, nothing left behind.
  delete from auth.users where id = uid;
end;
$$;

grant execute on function public.delete_own_account() to authenticated;

comment on function public.delete_own_account() is
  'Permanently deletes the calling user''s auth account and all associated data (profile, birth chart, palm report, purchases, unlocks, gift codes sent, chat history, community posts/likes). Called from the app''s Settings -> Delete My Account flow. Irreversible.';

-- ----------------------------------------------------------------------------
-- IMPORTANT — this could not be tested against a real Supabase project from
-- the sandbox this was written in (see SETUP.md: this environment's network
-- is firewalled and cannot reach *.supabase.co at all). The pattern —a
-- SECURITY DEFINER function created via the SQL Editor deleting straight
-- from auth.users — is a commonly used, documented approach for self-serve
-- deletion in Supabase projects, and it relies on cascades that were
-- verified for real in 002_schema.sql's own RLS test suite. But "commonly
-- used" isn't "verified against your actual project." Before this goes live
-- for real users: sign up a real throwaway test account, delete it through
-- the app's new Settings screen, and confirm in the Supabase Table Editor
-- that the row is gone from auth.users AND from every table that used to
-- reference it (birth_data, palm_reports, etc.) — that's the one thing that
-- genuinely proves this works end to end, the same way the original signup
-- flow needed a real-browser test before it could be trusted.
-- ----------------------------------------------------------------------------
