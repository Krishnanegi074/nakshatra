-- ============================================================================
-- Nakshatra — expert chat: Broadcast-from-Database delivery (011)
--
-- Why: live postgres_changes delivery of chat_messages never reached the
-- customer or the expert on the real project (tests/realtime-test.js: 5/7),
-- because Realtime's postgres_changes authorization couldn't evaluate
-- chat_messages_session_participants — its USING clause is a correlated
-- subquery joining chat_sessions. Supabase's recommended pattern for
-- membership-based authorization is Broadcast from Database: a trigger
-- publishes each new row to a per-session PRIVATE topic, and an RLS policy
-- on realtime.messages decides who may subscribe to that topic.
--
-- This ADDS delivery only. It does not touch chat_messages' own RLS, which
-- still governs who can read/write rows. The client stops using
-- postgres_changes for chat_messages (see supabase-client.js and
-- expert/index.html); chat_sessions still uses postgres_changes (its
-- policies are plain column comparisons, no subquery).
--
-- Topic convention: 'session:<chat_sessions.id>'.
--
-- How to apply: Supabase SQL Editor -> paste -> Run. Needs 009 applied.
-- Idempotent (safe to re-run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Trigger: every real-session message is broadcast to its session topic.
-- Demo rows (session_id null) are skipped — nothing subscribes to them.
-- SECURITY DEFINER so it can write to realtime.messages regardless of the
-- inserting user's privileges; empty search_path + fully-qualified names so
-- it can't be hijacked by a shadowing object.
-- ---------------------------------------------------------------------------
create or replace function public.broadcast_chat_message()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.session_id is not null then
    perform realtime.broadcast_changes(
      'session:' || new.session_id::text,  -- topic
      tg_op,                               -- event name: 'INSERT'
      tg_op,                               -- operation
      tg_table_name,
      tg_table_schema,
      new,
      null
    );
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_chat_message() from public;

drop trigger if exists chat_messages_broadcast on public.chat_messages;
create trigger chat_messages_broadcast
  after insert on public.chat_messages
  for each row execute function public.broadcast_chat_message();

-- ---------------------------------------------------------------------------
-- Authorization: who may RECEIVE on a private 'session:<id>' topic — exactly
-- the two participants of that session. realtime.topic() is the topic of the
-- channel being joined. The regex guard makes the uuid cast safe (a
-- malformed topic simply matches no policy). Compared as text, not cast to
-- uuid, because Postgres doesn't guarantee AND short-circuits, and a cast
-- on a malformed topic could raise.
--
-- SELECT only: clients never send broadcasts themselves (messages go through
-- chat_messages inserts), so no INSERT policy is granted on realtime.messages
-- — a client cannot forge a broadcast into someone's session.
-- ---------------------------------------------------------------------------
drop policy if exists "session_participants_receive_broadcast" on realtime.messages;
create policy "session_participants_receive_broadcast" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() ~ '^session:[0-9a-fA-F-]{36}$'
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id::text = lower(substring(realtime.topic() from 9))
        and (cs.user_id = auth.uid() or cs.expert_id = auth.uid())
    )
  );

-- Perf (per Supabase guidance): the policy filters chat_sessions by id (PK,
-- already indexed); no extra index needed.
