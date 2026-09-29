#!/bin/bash
# Resets test data (as the postgres superuser, which bypasses RLS) so
# tests/test-rls.js can be run repeatedly, then runs it.
cd "$(dirname "$0")/.."

sudo -u postgres psql -d nakshatra_test -q -c "
truncate table
  public.chat_sessions,
  public.experts,
  public.community_likes,
  public.community_posts,
  public.chat_messages,
  public.gift_codes,
  public.razorpay_orders,
  public.user_entitlements,
  public.unlocks,
  public.purchases,
  public.palm_reports,
  public.birth_data,
  public.kundli_waitlist
cascade;

-- Alice/Bob need a public.profiles row for Group 1 (and everything after
-- it — most of this suite assumes it exists), but they get one auto-created
-- by handle_new_user() only when their auth.users row is inserted AFTER
-- that trigger exists. sql/001_local_shim.sql's own Alice/Bob insert runs
-- BEFORE sql/002_schema.sql creates the trigger (001 has to — 002's tables
-- reference auth.users as a foreign key, so the auth schema and its rows
-- need to exist first), so the trigger never actually fires for them. Carol
-- doesn't have this problem — she's inserted fresh, after 002 already
-- exists, specifically to test the trigger firing (see below). This is a
-- one-time backfill, not something that needs redoing per run: profiles
-- isn't in the truncate list above, so `on conflict do nothing` just makes
-- repeat runs of this script a no-op here.
insert into public.profiles (id, name, email) values
  ('11111111-1111-1111-1111-111111111111', 'Alice', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'Bob', 'bob@example.com')
on conflict (id) do nothing;

-- Fixture for test-rls.js's Group 11 (sql/009_expert_chat.sql) and this
-- script's own complete_expert_session_order() checks further down. Two
-- online experts — Expert2 exists purely so the concurrent-matching race
-- test below has a second expert to correctly match to instead of either
-- both landing on Expert or one failing with NO_EXPERT_AVAILABLE.
insert into public.experts (id, name, specialty, is_online) values
  ('44444444-4444-4444-4444-444444444444', 'Test Expert', 'General readings', true),
  ('55555555-5555-5555-5555-555555555555', 'Second Expert', 'General readings', true);

-- A pre-existing session for test-rls.js's Group 11 to check SELECT/UPDATE
-- RLS boundaries against (Alice the customer, Expert the assigned expert,
-- Bob a third party who should see neither). status='ended' (not 'active')
-- deliberately — otherwise Expert would already be 'busy' by the time this
-- script's own matching tests run further down, and the concurrent-race
-- test below specifically needs exactly one free expert slot for its two
-- simultaneous claimants, not zero.
insert into public.chat_sessions (id, user_id, expert_id, status, amount_paise, ended_at) values
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'ended', 19900, now());
insert into public.chat_messages (session_id, user_id, sender, text) values
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'user', 'Hi, I had a question about my chart.'),
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'astro', 'Happy to help — what''s on your mind?');

-- Fixture for test-rls.js Group 5 (gift redemption flow). Inserted as the
-- postgres superuser (bypasses RLS) standing in for what
-- complete_razorpay_order() would have inserted for a real gift purchase —
-- direct client inserts into gift_codes are blocked since
-- sql/004_razorpay_payments.sql removed gift_codes_insert_own.
insert into public.gift_codes (code, sender_id, tier, recipient_name) values
  ('NKSH-TEST-0001', '11111111-1111-1111-1111-111111111111', 'onetime', 'A Friend');
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

echo ""
echo "== Extra check: complete_razorpay_order() — self-purchase, gift, idempotency, not-found =="
# Run as the postgres superuser, standing in for service_role (which
# bypasses RLS/grants the same way — see sql/004_razorpay_payments.sql).
# test-rls.js's own Group 8 already proves `authenticated` CANNOT call this
# function at all; this checks what it actually does when called correctly.
PAY_EXIT=0

sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, tier, amount_paise, status) values
  ('order_test_self', '11111111-1111-1111-1111-111111111111', 'onetime', 39900, 'created');
"
SELF_RESULT=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select tier || '|' || coalesce(gift_code, 'NULL') from public.complete_razorpay_order('order_test_self', 'pay_test_self', 'upi');
")
if [ "$SELF_RESULT" = "onetime|NULL" ]; then
  echo "PASS - self-purchase: complete_razorpay_order() returns (tier=onetime, gift_code=NULL)"
else
  echo "FAIL - self-purchase: expected 'onetime|NULL', got '$SELF_RESULT'"; PAY_EXIT=1
fi
# Scoped to tier='onetime' specifically — by this point in the script Alice
# (same UUID) already holds a separate 'bundle' entitlement from
# test-rls.js's own Group 4 (run just above, in the same database), which is
# itself proof the fix works: the old single-row unlocks table would have
# had that earlier 'bundle' row silently overwritten by this one.
SELF_ENTITLEMENT=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select tier || '|' || source from public.user_entitlements where user_id = '11111111-1111-1111-1111-111111111111' and tier = 'onetime';
")
if [ "$SELF_ENTITLEMENT" = "onetime|purchase" ]; then
  echo "PASS - self-purchase correctly granted a onetime entitlement (source=purchase)"
else
  echo "FAIL - self-purchase entitlement row wrong: '$SELF_ENTITLEMENT'"; PAY_EXIT=1
fi
SELF_PURCHASE_COUNT=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select count(*) from public.purchases where user_id = '11111111-1111-1111-1111-111111111111' and status = 'razorpay_success';
")
if [ "$SELF_PURCHASE_COUNT" = "1" ]; then
  echo "PASS - self-purchase logged exactly one purchases row with status=razorpay_success"
else
  echo "FAIL - expected exactly 1 razorpay_success purchases row, got $SELF_PURCHASE_COUNT"; PAY_EXIT=1
fi

# Idempotency: calling it again for the SAME order_id must not double-credit.
sudo -u postgres psql -d nakshatra_test -q -c "
select public.complete_razorpay_order('order_test_self', 'pay_test_self', 'upi');
" > /dev/null
REPEAT_PURCHASE_COUNT=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select count(*) from public.purchases where user_id = '11111111-1111-1111-1111-111111111111' and status = 'razorpay_success';
")
if [ "$REPEAT_PURCHASE_COUNT" = "1" ]; then
  echo "PASS - calling complete_razorpay_order() again for the same order_id did NOT create a second purchases row (idempotent)"
else
  echo "FAIL - expected the retried call to stay idempotent (1 row), got $REPEAT_PURCHASE_COUNT"; PAY_EXIT=1
fi

# Gift purchase: should mint a gift code and NOT touch the sender's own
# unlock. Uses Carol (created fresh by the handle_new_user trigger check
# just above, with no purchase/unlock/gift history of her own) rather than
# Bob, who already picked up an unlocks row earlier in this same run when
# he redeemed Alice's gift code in test-rls.js's Group 5 — reusing his id
# here would make this check pass or fail based on unrelated test order.
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, tier, amount_paise, gift_recipient_name, gift_message, status) values
  ('order_test_gift', '33333333-3333-3333-3333-333333333333', 'bundle', 59900, 'A Friend', 'Enjoy!', 'created');
"
GIFT_CODE=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select gift_code from public.complete_razorpay_order('order_test_gift', 'pay_test_gift', 'card');
")
if [[ "$GIFT_CODE" =~ ^NKSH-[A-Z0-9]{4}-[A-Z0-9]{4}$ ]]; then
  echo "PASS - gift purchase: complete_razorpay_order() minted a code shaped like NKSH-XXXX-XXXX ($GIFT_CODE)"
else
  echo "FAIL - gift purchase: expected an NKSH-XXXX-XXXX code, got '$GIFT_CODE'"; PAY_EXIT=1
fi
GIFT_ROW=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select sender_id || '|' || tier || '|' || recipient_name from public.gift_codes where code = '$GIFT_CODE';
")
if [ "$GIFT_ROW" = "33333333-3333-3333-3333-333333333333|bundle|A Friend" ]; then
  echo "PASS - the minted gift_codes row has the right sender, tier, and recipient"
else
  echo "FAIL - gift_codes row wrong: '$GIFT_ROW'"; PAY_EXIT=1
fi
SENDER_ENTITLEMENTS_AFTER_GIFT=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select count(*) from public.user_entitlements where user_id = '33333333-3333-3333-3333-333333333333';
")
if [ "$SENDER_ENTITLEMENTS_AFTER_GIFT" = "0" ]; then
  echo "PASS - buying a gift did NOT grant the sender anything (only the eventual redeemer gets an entitlement)"
else
  echo "FAIL - expected no user_entitlements row for the gift sender, found $SENDER_ENTITLEMENTS_AFTER_GIFT"; PAY_EXIT=1
fi

# THE core fix, exercised via complete_razorpay_order() too (not just
# record_test_purchase()): Alice already holds 'bundle' (test-rls.js Group 4)
# and 'onetime' (order_test_self, above) — buying a THIRD, different tier
# (subscription) via the real Razorpay path must ADD a third row, not
# overwrite either of the first two.
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, tier, amount_paise, status) values
  ('order_test_self_2', '11111111-1111-1111-1111-111111111111', 'subscription', 29900, 'created');
select public.complete_razorpay_order('order_test_self_2', 'pay_test_self_2', 'upi');
" > /dev/null
SELF_ENTITLEMENT_COUNT_2=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select count(*) from public.user_entitlements where user_id = '11111111-1111-1111-1111-111111111111';
")
if [ "$SELF_ENTITLEMENT_COUNT_2" = "3" ]; then
  echo "PASS - THE FIX: a third, different-tier purchase (via complete_razorpay_order) ADDS an entitlement instead of overwriting the earlier ones (now holds all 3: bundle, onetime, subscription)"
else
  echo "FAIL - expected 3 entitlement rows after a third different-tier purchase, got $SELF_ENTITLEMENT_COUNT_2"; PAY_EXIT=1
fi

# Unknown order_id should fail cleanly (ORDER_NOT_FOUND), not silently no-op.
NOTFOUND_ERR=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select public.complete_razorpay_order('order_does_not_exist', 'pay_x', 'upi');
" 2>&1)
if echo "$NOTFOUND_ERR" | grep -q "ORDER_NOT_FOUND"; then
  echo "PASS - completing an unknown order_id fails cleanly with ORDER_NOT_FOUND"
else
  echo "FAIL - expected an ORDER_NOT_FOUND error, got: $NOTFOUND_ERR"; PAY_EXIT=1
fi

echo ""
echo "== Extra check: complete_expert_session_order() — matching, idempotency, no-expert, wrong-order-type, not-found, and the concurrent-matching race =="
# Run as the postgres superuser, standing in for service_role, same as the
# complete_razorpay_order() block above. Uses Expert/Expert2 seeded at the
# top of this script and Carol (created fresh by the trigger check above).
EXPERT_EXIT=0

# Proves this function refuses to touch an order that isn't its kind — a
# fresh 'report'-product order (tier set, as razorpay_orders_tier_matches_product
# requires).
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, tier, product, amount_paise, status) values
  ('order_test_wrong_type', '11111111-1111-1111-1111-111111111111', 'onetime', 'report', 39900, 'created');
"
WRONGTYPE_ERR=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select public.complete_expert_session_order('order_test_wrong_type', 'pay_x', 'upi');
" 2>&1)
if echo "$WRONGTYPE_ERR" | grep -q "WRONG_ORDER_TYPE"; then
  echo "PASS - calling complete_expert_session_order() on a 'report' order fails cleanly with WRONG_ORDER_TYPE"
else
  echo "FAIL - expected WRONG_ORDER_TYPE, got: $WRONGTYPE_ERR"; EXPERT_EXIT=1
fi

NOTFOUND_ERR2=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select public.complete_expert_session_order('order_does_not_exist_either', 'pay_x', 'upi');
" 2>&1)
if echo "$NOTFOUND_ERR2" | grep -q "ORDER_NOT_FOUND"; then
  echo "PASS - completing an unknown expert-session order_id fails cleanly with ORDER_NOT_FOUND"
else
  echo "FAIL - expected ORDER_NOT_FOUND, got: $NOTFOUND_ERR2"; EXPERT_EXIT=1
fi

# Normal match: Bob pays, gets matched to one of the two online experts.
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, product, amount_paise, status) values
  ('order_test_session_bob', '22222222-2222-2222-2222-222222222222', 'expert_session', 19900, 'created');
"
BOB_MATCH=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select session_id || '|' || expert_name from public.complete_expert_session_order('order_test_session_bob', 'pay_bob', 'upi');
")
BOB_SESSION_ID=$(echo "$BOB_MATCH" | cut -d'|' -f1)
BOB_EXPERT_NAME=$(echo "$BOB_MATCH" | cut -d'|' -f2)
if { [ "$BOB_EXPERT_NAME" = "Test Expert" ] || [ "$BOB_EXPERT_NAME" = "Second Expert" ]; } && [ -n "$BOB_SESSION_ID" ]; then
  echo "PASS - Bob's payment matched him to an online expert ($BOB_EXPERT_NAME) and returned a session_id"
else
  echo "FAIL - expected a matched expert name and session_id, got: '$BOB_MATCH'"; EXPERT_EXIT=1
fi
BOB_SESSION_ROW=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select user_id || '|' || amount_paise || '|' || status from public.chat_sessions where id = '$BOB_SESSION_ID';
")
if [ "$BOB_SESSION_ROW" = "22222222-2222-2222-2222-222222222222|19900|active" ]; then
  echo "PASS - the chat_sessions row has the right customer, amount, and status=active"
else
  echo "FAIL - chat_sessions row wrong: '$BOB_SESSION_ROW'"; EXPERT_EXIT=1
fi

# Idempotency: retrying the same order_id returns the SAME session, not a
# second one.
BOB_MATCH_RETRY=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select session_id from public.complete_expert_session_order('order_test_session_bob', 'pay_bob', 'upi');
")
SESSIONS_FOR_BOB_ORDER=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select count(*) from public.chat_sessions where razorpay_order_id = 'order_test_session_bob';
")
if [ "$BOB_MATCH_RETRY" = "$BOB_SESSION_ID" ] && [ "$SESSIONS_FOR_BOB_ORDER" = "1" ]; then
  echo "PASS - retrying the same order_id returns the same session_id and did not create a second chat_sessions row (idempotent)"
else
  echo "FAIL - expected retry to return '$BOB_SESSION_ID' with exactly 1 session row, got session_id='$BOB_MATCH_RETRY' count=$SESSIONS_FOR_BOB_ORDER"; EXPERT_EXIT=1
fi

# THE race condition sql/009_expert_chat.sql's locked matching loop exists
# to prevent: two DIFFERENT customers (Alice, Carol) pay at the same
# instant, with Bob's session above already occupying one of the two online
# experts — so there's exactly one free slot left for two simultaneous
# claimants. Fired as two genuinely-parallel psql processes (backgrounded,
# not sequential calls), which is the only way this actually exercises the
# lock instead of just proving the single-call logic is right.
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, product, amount_paise, status) values
  ('order_test_race_alice', '11111111-1111-1111-1111-111111111111', 'expert_session', 19900, 'created'),
  ('order_test_race_carol', '33333333-3333-3333-3333-333333333333', 'expert_session', 19900, 'created');
"
sudo -u postgres psql -d nakshatra_test -t -A -c "
select expert_name from public.complete_expert_session_order('order_test_race_alice', 'pay_alice', 'upi');
" > /tmp/nakshatra_race_alice.txt 2>&1 &
RACE_PID_ALICE=$!
sudo -u postgres psql -d nakshatra_test -t -A -c "
select expert_name from public.complete_expert_session_order('order_test_race_carol', 'pay_carol', 'upi');
" > /tmp/nakshatra_race_carol.txt 2>&1 &
RACE_PID_CAROL=$!
wait $RACE_PID_ALICE
wait $RACE_PID_CAROL
RACE_ALICE_EXPERT=$(cat /tmp/nakshatra_race_alice.txt)
RACE_CAROL_EXPERT=$(cat /tmp/nakshatra_race_carol.txt)
rm -f /tmp/nakshatra_race_alice.txt /tmp/nakshatra_race_carol.txt
# Exactly ONE of them should have matched "Second Expert" (the only
# actually-free one at this point) and the OTHER should have gotten a clean
# NO_EXPERT_AVAILABLE — never both succeeding (which, if they'd both landed
# on Second Expert, is exactly the double-booking this whole test exists to
# catch) and never both failing. An earlier version of this check only
# verified the two results were non-empty and different from each other,
# which would have also accepted "one succeeded, one got some unrelated
# error" as a pass — this is the precise invariant instead.
if { [ "$RACE_ALICE_EXPERT" = "Second Expert" ] && echo "$RACE_CAROL_EXPERT" | grep -q "NO_EXPERT_AVAILABLE"; } || \
   { [ "$RACE_CAROL_EXPERT" = "Second Expert" ] && echo "$RACE_ALICE_EXPERT" | grep -q "NO_EXPERT_AVAILABLE"; }; then
  echo "PASS - two customers paying at the same instant, with only one free expert slot left (Second Expert), resolved correctly: exactly one matched it and the other cleanly got NO_EXPERT_AVAILABLE — neither double-booked Second Expert, neither failed spuriously (Alice->$RACE_ALICE_EXPERT, Carol->$RACE_CAROL_EXPERT)"
else
  echo "FAIL - expected exactly one of Alice/Carol to match 'Second Expert' and the other to get NO_EXPERT_AVAILABLE, got Alice='$RACE_ALICE_EXPERT' Carol='$RACE_CAROL_EXPERT'"; EXPERT_EXIT=1
fi

# With both experts now busy, a THIRD customer paying right now must get a
# clean NO_EXPERT_AVAILABLE, not silently double-book someone.
sudo -u postgres psql -d nakshatra_test -q -c "
insert into public.razorpay_orders (order_id, user_id, product, amount_paise, status) values
  ('order_test_no_expert', '22222222-2222-2222-2222-222222222222', 'expert_session', 19900, 'created');
"
NOEXPERT_ERR=$(sudo -u postgres psql -d nakshatra_test -t -A -c "
select public.complete_expert_session_order('order_test_no_expert', 'pay_x', 'upi');
" 2>&1)
if echo "$NOEXPERT_ERR" | grep -q "NO_EXPERT_AVAILABLE"; then
  echo "PASS - with every online expert already in an active session, a new payment fails cleanly with NO_EXPERT_AVAILABLE"
else
  echo "FAIL - expected NO_EXPERT_AVAILABLE, got: $NOEXPERT_ERR"; EXPERT_EXIT=1
fi

if [ "$RLS_EXIT" -ne 0 ] || [ "$TRIGGER_EXIT" -ne 0 ] || [ "$PAY_EXIT" -ne 0 ] || [ "$EXPERT_EXIT" -ne 0 ]; then
  exit 1
fi
