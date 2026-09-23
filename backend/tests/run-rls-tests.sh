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
  public.razorpay_orders,
  public.user_entitlements,
  public.unlocks,
  public.purchases,
  public.palm_reports,
  public.birth_data,
  public.kundli_waitlist
cascade;

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

if [ "$RLS_EXIT" -ne 0 ] || [ "$TRIGGER_EXIT" -ne 0 ] || [ "$PAY_EXIT" -ne 0 ]; then
  exit 1
fi
