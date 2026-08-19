#!/bin/bash
# Resets test data (as the postgres superuser, which bypasses RLS) so
# tests/test-rls.js can be run repeatedly, then runs it.
cd "$(dirname "$0")/.."

sudo -u postgres psql -d nakshatra_test -q -c "
truncate table
  public.community_likes,
  public.community_posts,
  public.chat_messages,
  public.gift_codes,
  public.unlocks,
  public.purchases,
  public.palm_reports,
  public.birth_data
cascade;
"

node tests/test-rls.js
RLS_EXIT=$?

echo ""
echo "== Extra check: handle_new_user() trigger auto-creates a profile on signup =="
sudo -u postgres psql -d nakshatra_test -q -c "
delete from auth.users where email = 'carol@example.com';
insert into auth.users (id, email, raw_user_meta_data)
values ('33333333-3333-3333-3333-333333333333', 'carol@example.com', '{\"name\":\"Carol\"}'::jsonb);
"
TRIGGER_ROW=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select name || '|' || email from public.profiles where id = '33333333-3333-3333-3333-333333333333';
")
if [ "$TRIGGER_ROW" = "Carol|carol@example.com" ]; then
  echo "PASS - signing up (insert into auth.users) auto-created a matching public.profiles row via the trigger"
  TRIGGER_EXIT=0
else
  echo "FAIL - expected profiles row 'Carol|carol@example.com', got: '$TRIGGER_ROW'"
  TRIGGER_EXIT=1
fi

if [ "$RLS_EXIT" -ne 0 ] || [ "$TRIGGER_EXIT" -ne 0 ]; then
  exit 1
fi
