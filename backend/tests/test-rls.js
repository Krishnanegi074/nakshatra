// Rigorous test of sql/002_schema.sql's Row Level Security policies against
// a REAL local Postgres (via sql/001_local_shim.sql — see that file's header
// for why this is a faithful stand-in for Supabase's real auth.uid()).
//
// This connects as `app_test_login`, a plain LOGIN role granted membership
// in anon/authenticated/service_role (exactly the roles Supabase's own
// PostgREST would run queries as) — NOT as the postgres superuser, which
// bypasses RLS entirely and would make this test meaningless.
//
// Every check simulates two real accounts (Alice / Bob) and asserts the
// cross-user boundaries a live app depends on: nobody can read, write, or
// forge ownership of someone else's private data; the community feed is
// readable by any authenticated user but only writable as yourself; gift
// codes and tier entitlements (user_entitlements — see
// sql/005_tier_entitlements.sql) can only be granted through the SECURITY
// DEFINER functions, never by a direct table write.
const { Client } = require("pg");

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const results = [];
function check(label, cond) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

async function client() {
  const c = new Client({
    host: "127.0.0.1",
    user: "app_test_login",
    password: "testpass123",
    database: "nakshatra_test",
  });
  await c.connect();
  return c;
}

// Run `fn` as a given simulated user under the `authenticated` role, in its
// own transaction (set_local_test_user uses set_config(..., true) — local to
// the transaction — so each call gets a clean slate).
async function asUser(c, userId, fn) {
  await c.query("begin");
  try {
    await c.query("set local role authenticated");
    await c.query("select set_local_test_user($1)", [userId]);
    return await fn();
  } finally {
    await c.query("commit").catch(() => c.query("rollback"));
  }
}

// Run `fn` as the anon role (a not-signed-in visitor — no user id at all,
// matching how the public Kundli Matching waitlist form is hit before
// anyone has an account) in its own transaction.
async function asAnon(c, fn) {
  await c.query("begin");
  try {
    await c.query("set local role anon");
    return await fn();
  } finally {
    await c.query("commit").catch(() => c.query("rollback"));
  }
}

async function expectError(promise, label) {
  try {
    await promise;
    check(label, false);
  } catch (e) {
    check(label, true);
  }
}

(async () => {
  const c = await client();

  console.log("== Group 1: profiles — each user sees only their own row ==");
  {
    const aliceProfile = await asUser(c, ALICE, () => c.query("select * from public.profiles"));
    check("Alice's SELECT on profiles returns exactly 1 row (her own)", aliceProfile.rows.length === 1 && aliceProfile.rows[0].id === ALICE);

    const bobProfile = await asUser(c, BOB, () => c.query("select * from public.profiles"));
    check("Bob's SELECT on profiles returns exactly 1 row (his own, not Alice's)", bobProfile.rows.length === 1 && bobProfile.rows[0].id === BOB);

    // RLS silently filters an UPDATE's target rows rather than throwing, so
    // an out-of-scope UPDATE "succeeds" with 0 rows affected — verify that
    // directly instead of expecting an error.
    await asUser(c, ALICE, () => c.query("update public.profiles set name = 'Hacked' where id = $1", [BOB]));
    const bobNameCheck = await asUser(c, BOB, () => c.query("select name from public.profiles where id = $1", [BOB]));
    check("Alice's UPDATE targeting Bob's profile row did not change it (RLS filtered it to 0 rows)", bobNameCheck.rows[0].name === "Bob");
  }

  console.log("\n== Group 2: birth_data — private per-user, no cross-user read/write ==");
  {
    // city_tz (006_city_timezone.sql — the IANA-timezone/DST fix) is exercised
    // here too, alongside the pre-existing city_name check, so this also proves
    // the new column round-trips correctly through RLS-scoped access.
    await asUser(c, ALICE, () => c.query(
      `insert into public.birth_data (user_id, year, month, day, city_name, city_utc, city_tz, sun_idx, moon_idx, asc_idx)
       values ($1, 1990, 8, 10, 'Mumbai', 5.5, 'Asia/Kolkata', 4, 1, 7)`, [ALICE]
    ));
    await asUser(c, BOB, () => c.query(
      `insert into public.birth_data (user_id, year, month, day, city_name, city_utc, city_tz, sun_idx, moon_idx, asc_idx)
       values ($1, 1988, 3, 2, 'Delhi', 5.5, 'Asia/Kolkata', 11, 5, 2)`, [BOB]
    ));

    const aliceSees = await asUser(c, ALICE, () => c.query("select * from public.birth_data"));
    check("Alice's SELECT on birth_data returns only her own row", aliceSees.rows.length === 1 && aliceSees.rows[0].city_name === "Mumbai");
    check("...and her city_tz round-tripped correctly", aliceSees.rows[0].city_tz === "Asia/Kolkata");

    const bobSees = await asUser(c, BOB, () => c.query("select * from public.birth_data"));
    check("Bob's SELECT on birth_data returns only his own row", bobSees.rows.length === 1 && bobSees.rows[0].city_name === "Delhi");

    await expectError(
      asUser(c, ALICE, () => c.query(
        `insert into public.birth_data (user_id, year, month, day) values ($1, 2000, 1, 1)`, [BOB]
      )),
      "Alice cannot INSERT a birth_data row claiming to be Bob (user_id must equal auth.uid())"
    );

    const bobUnaffected = await asUser(c, BOB, () => c.query("select count(*) from public.birth_data where user_id = $1", [BOB]));
    check("...and the forged insert did not actually land in Bob's data", Number(bobUnaffected.rows[0].count) === 1);
  }

  console.log("\n== Group 3: palm_reports — same per-user isolation ==");
  {
    await asUser(c, ALICE, () => c.query(
      `insert into public.palm_reports (user_id, answers, report) values ($1, '{"q1":"long"}'::jsonb, '{"summary":"Alice report"}'::jsonb)`, [ALICE]
    ));
    const bobTriesAliceReport = await asUser(c, BOB, () => c.query("select * from public.palm_reports where user_id = $1", [ALICE]));
    check("Bob's SELECT filtered to Alice's user_id returns 0 rows (RLS hides it, not just app-layer filtering)", bobTriesAliceReport.rows.length === 0);
  }

  console.log("\n== Group 4: purchases/user_entitlements — cannot be written directly by a client ==");
  {
    await expectError(
      asUser(c, ALICE, () => c.query(
        `insert into public.purchases (user_id, tier, amount_paise, payment_method) values ($1, 'bundle', 59900, 'upi')`, [ALICE]
      )),
      "Alice cannot directly INSERT into purchases (no insert policy — must go through record_test_purchase())"
    );
    await expectError(
      asUser(c, ALICE, () => c.query(
        `insert into public.user_entitlements (user_id, tier, source) values ($1, 'bundle', 'purchase')`, [ALICE]
      )),
      "Alice cannot directly INSERT into user_entitlements (must go through grant_entitlement() via record_test_purchase()/redeem_gift_code()/complete_razorpay_order())"
    );
    await expectError(
      asUser(c, ALICE, () => c.query("select public.grant_entitlement($1, 'bundle', 'purchase')", [ALICE])),
      "Alice cannot call grant_entitlement() directly either (not granted to authenticated — would let anyone unlock any tier for free)"
    );

    const beforeEntitlements = await asUser(c, ALICE, () => c.query("select * from public.user_entitlements where user_id = $1", [ALICE]));
    check("Alice holds no entitlements before any purchase", beforeEntitlements.rows.length === 0);

    await asUser(c, ALICE, () => c.query("select public.record_test_purchase('bundle', 59900, 'upi')"));

    const afterFirstPurchase = await asUser(c, ALICE, () => c.query("select * from public.user_entitlements where user_id = $1", [ALICE]));
    check("record_test_purchase() correctly grants Alice a bundle entitlement (source=purchase)", afterFirstPurchase.rows.length === 1 && afterFirstPurchase.rows[0].tier === "bundle" && afterFirstPurchase.rows[0].source === "purchase");

    const alicePurchases = await asUser(c, ALICE, () => c.query("select * from public.purchases where user_id = $1", [ALICE]));
    check("record_test_purchase() logged a purchases row for Alice", alicePurchases.rows.length === 1 && Number(alicePurchases.rows[0].amount_paise) === 59900);

    const bobSeesAlicePurchase = await asUser(c, BOB, () => c.query("select * from public.purchases where user_id = $1", [ALICE]));
    check("Bob cannot see Alice's purchase row", bobSeesAlicePurchase.rows.length === 0);

    const bobSeesAliceEntitlement = await asUser(c, BOB, () => c.query("select * from public.user_entitlements where user_id = $1", [ALICE]));
    check("Bob cannot see Alice's entitlement row", bobSeesAliceEntitlement.rows.length === 0);

    // THE core fix this migration exists for: buying a SECOND, DIFFERENT
    // tier must ADD a row, not overwrite the first — the exact bug the old
    // single-row public.unlocks table had (on conflict (user_id) do update).
    await asUser(c, ALICE, () => c.query("select public.record_test_purchase('onetime', 39900, 'upi')"));
    const afterSecondPurchase = await asUser(c, ALICE, () => c.query("select tier, source from public.user_entitlements where user_id = $1 order by tier", [ALICE]));
    check("THE FIX: after buying a second, different tier, Alice holds BOTH entitlements (bundle AND onetime) — the second purchase did not erase the first",
      afterSecondPurchase.rows.length === 2 &&
      afterSecondPurchase.rows.some(r => r.tier === "bundle") &&
      afterSecondPurchase.rows.some(r => r.tier === "onetime"));

    // Idempotency: buying a tier you already hold again must not duplicate the row.
    await asUser(c, ALICE, () => c.query("select public.record_test_purchase('onetime', 39900, 'upi')"));
    const afterRepeatPurchase = await asUser(c, ALICE, () => c.query("select * from public.user_entitlements where user_id = $1 and tier = 'onetime'", [ALICE]));
    check("grant_entitlement() is idempotent — re-buying the same tier does not create a duplicate row", afterRepeatPurchase.rows.length === 1);
  }

  console.log("\n== Group 5: gift_codes — no direct insert, sender-only visibility, redeem via function only ==");
  {
    // sql/004_razorpay_payments.sql removed gift_codes_insert_own — a gift
    // code must now always come from a verified Razorpay payment via
    // complete_razorpay_order(), never a direct client insert. The fixture
    // row this group uses (NKSH-TEST-0001) is seeded by run-rls-tests.sh AS
    // the postgres superuser (bypassing RLS, standing in for what
    // complete_razorpay_order() would have inserted for a real gift).
    await expectError(
      asUser(c, ALICE, () => c.query(
        `insert into public.gift_codes (code, sender_id, tier, recipient_name) values ('NKSH-TEST-0002', $1, 'onetime', 'Someone Else')`, [ALICE]
      )),
      "Direct INSERT into gift_codes is blocked now that a gift must be a verified payment (gift_codes_insert_own was removed)"
    );

    const bobBrowsesCodes = await asUser(c, BOB, () => c.query("select * from public.gift_codes"));
    check("Bob's plain SELECT on gift_codes returns 0 rows (cannot browse/enumerate codes he didn't send)", bobBrowsesCodes.rows.length === 0);

    const aliceSeesOwnCode = await asUser(c, ALICE, () => c.query("select * from public.gift_codes where sender_id = $1", [ALICE]));
    check("Alice can see the code she sent (status tracking)", aliceSeesOwnCode.rows.length === 1 && aliceSeesOwnCode.rows[0].redeemed === false);

    await expectError(
      asUser(c, ALICE, () => c.query("select public.redeem_gift_code('NKSH-TEST-0001')")),
      "Sender cannot redeem their own gift code (GIFT_CODE_SELF_REDEEM)"
    );

    const redeemResult = await asUser(c, BOB, () => c.query("select * from public.redeem_gift_code('NKSH-TEST-0001')"));
    check("Bob successfully redeems Alice's code via the function and gets back the correct tier", redeemResult.rows.length === 1 && redeemResult.rows[0].tier === "onetime");

    const bobEntitlementAfterRedeem = await asUser(c, BOB, () => c.query("select * from public.user_entitlements where user_id = $1", [BOB]));
    check("Redeeming granted Bob a onetime entitlement with source=gift", bobEntitlementAfterRedeem.rows.length === 1 && bobEntitlementAfterRedeem.rows[0].tier === "onetime" && bobEntitlementAfterRedeem.rows[0].source === "gift");

    await expectError(
      asUser(c, BOB, () => c.query("select public.redeem_gift_code('NKSH-TEST-0001')")),
      "Redeeming the same code twice fails (GIFT_CODE_ALREADY_REDEEMED)"
    );

    await expectError(
      asUser(c, ALICE, () => c.query("select public.redeem_gift_code('NKSH-DOES-NOTEXIST')")),
      "Redeeming a nonexistent code fails cleanly (GIFT_CODE_NOT_FOUND)"
    );
  }

  console.log("\n== Group 6: community_posts/likes — public read, own-only write ==");
  {
    const alicePost = await asUser(c, ALICE, () => c.query(
      `insert into public.community_posts (user_id, name, sign_idx, caption) values ($1, 'Alice', 4, 'Great day for Leo!') returning id`, [ALICE]
    ));
    const postId = alicePost.rows[0].id;

    const bobReadsFeed = await asUser(c, BOB, () => c.query("select * from public.community_feed where id = $1", [postId]));
    check("Bob (a different user) CAN read Alice's community post — feed is public to authenticated users", bobReadsFeed.rows.length === 1);
    check("Feed view correctly reports like_count=0 and liked_by_me=false before any likes", Number(bobReadsFeed.rows[0].like_count) === 0 && bobReadsFeed.rows[0].liked_by_me === false);

    await expectError(
      asUser(c, BOB, () => c.query(
        `insert into public.community_posts (user_id, name, sign_idx, caption) values ($1, 'Fake Alice', 4, 'impersonating') `, [ALICE]
      )),
      "Bob cannot INSERT a community post claiming to be Alice (user_id must equal auth.uid())"
    );

    // Same pattern as the profile UPDATE above: RLS silently matches 0 rows
    // rather than throwing, so verify directly instead of expecting an error.
    await asUser(c, BOB, () => c.query("delete from public.community_posts where id = $1", [postId]));
    const stillThere = await asUser(c, ALICE, () => c.query("select 1 from public.community_posts where id = $1", [postId]));
    check("Bob's DELETE attempt did not remove Alice's post (RLS silently filtered it to 0 rows)", stillThere.rows.length === 1);

    await asUser(c, BOB, () => c.query("insert into public.community_likes (user_id, post_id) values ($1, $2)", [BOB, postId]));
    const afterLike = await asUser(c, ALICE, () => c.query("select * from public.community_feed where id = $1", [postId]));
    check("After Bob likes it, like_count becomes 1 on the shared feed view", Number(afterLike.rows[0].like_count) === 1);

    const bobLikedFlag = await asUser(c, BOB, () => c.query("select liked_by_me from public.community_feed where id = $1", [postId]));
    check("liked_by_me is true for Bob (who liked it)", bobLikedFlag.rows[0].liked_by_me === true);
    const aliceLikedFlag = await asUser(c, ALICE, () => c.query("select liked_by_me from public.community_feed where id = $1", [postId]));
    check("liked_by_me is false for Alice (who didn't like it) even though the count is shared", aliceLikedFlag.rows[0].liked_by_me === false);

    await expectError(
      asUser(c, ALICE, () => c.query("insert into public.community_likes (user_id, post_id) values ($1, $2)", [BOB, postId])),
      "Alice cannot insert a like row on Bob's behalf (user_id must equal auth.uid())"
    );
  }

  console.log("\n== Group 7b: owner-id columns default to auth.uid() when omitted ==");
  {
    const inserted = await asUser(c, ALICE, () => c.query(
      `insert into public.community_posts (name, sign_idx, caption) values ('Alice', 9, 'no user_id passed at all') returning user_id`
    ));
    check("community_posts.user_id defaults to the caller's own auth.uid() when the client omits it", inserted.rows[0].user_id === ALICE);
  }

  console.log("\n== Group 7: chat_messages — private per-user conversation history ==");
  {
    await asUser(c, ALICE, () => c.query(
      `insert into public.chat_messages (user_id, astrologer_id, sender, text) values ($1, 'priya', 'user', 'Hello!')`, [ALICE]
    ));
    await asUser(c, ALICE, () => c.query(
      `insert into public.chat_messages (user_id, astrologer_id, sender, text) values ($1, 'priya', 'astro', 'Namaste, Alice.')`, [ALICE]
    ));

    const bobReadsAliceChat = await asUser(c, BOB, () => c.query("select * from public.chat_messages where user_id = $1", [ALICE]));
    check("Bob cannot read Alice's chat history", bobReadsAliceChat.rows.length === 0);

    const aliceOwnChat = await asUser(c, ALICE, () => c.query("select * from public.chat_messages where user_id = $1 order by created_at", [ALICE]));
    check("Alice sees her own full 2-message conversation", aliceOwnChat.rows.length === 2);
  }

  console.log("\n== Group 8: complete_razorpay_order() — not reachable by a logged-in client ==");
  {
    // The whole point of sql/004_razorpay_payments.sql's design is that
    // this function is the ONLY place a Razorpay-backed purchase gets
    // credited, and it must be unreachable except from
    // supabase/functions/verify-razorpay-payment/index.ts (using the
    // service_role key, after independently verifying Razorpay's
    // signature). If `authenticated` could call it directly, any logged-in
    // user could unlock any tier for free just by guessing an order_id —
    // see tests/run-rls-tests.sh for the functional (as-service-role) test
    // of what this function actually does when called correctly.
    await expectError(
      asUser(c, ALICE, () => c.query("select public.complete_razorpay_order('does-not-matter', 'does-not-matter', 'upi')")),
      "A logged-in user (authenticated role) cannot call complete_razorpay_order() directly — PUBLIC's execute was explicitly revoked"
    );
  }

  console.log("\n== Group 9: kundli_waitlist — anon can join, nobody can read addresses back ==");
  {
    // The public Kundli Matching page's "Join the Waitlist" form runs with
    // no logged-in user at all — this is the one table in the whole schema
    // a bare `anon` role (not `authenticated`) needs write access to.
    await asAnon(c, () => c.query(
      "insert into public.kundli_waitlist (email) values ($1)", ["rlstest-waitlist@example.com"]
    ));
    check("anon can insert into kundli_waitlist (join the waitlist while signed out)", true);

    await expectError(
      asAnon(c, () => c.query(
        "insert into public.kundli_waitlist (email) values ($1)", ["RLSTest-Waitlist@example.com"]
      )),
      "A duplicate email (different case) is rejected by the case-insensitive unique index"
    );

    await expectError(
      asAnon(c, () => c.query("select * from public.kundli_waitlist")),
      "anon cannot SELECT from kundli_waitlist — collected addresses are never readable from the client"
    );

    await expectError(
      asUser(c, ALICE, () => c.query("select * from public.kundli_waitlist")),
      "...and a logged-in (authenticated) user can't read it either — no policy grants it to anyone but service_role"
    );
  }

  await c.end();

  console.log(`\n=== RESULT: ${results.filter(r => r.pass).length} / ${results.length} checks passed ===`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.log("FAILED:", failed.map(f => f.label));
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
