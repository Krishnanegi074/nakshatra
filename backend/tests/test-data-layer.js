// Unit tests for supabase-client.js's `db` wrapper functions, run against a
// FAKE supabase-js client (not a network call) — because this sandbox can't
// reach any live Supabase instance (see the note in tests/test-rls.js and
// the top-level handoff doc). This can't prove the real network round-trip
// works, but it DOES catch the class of bug that's actually likely here:
// a wrong table/column/RPC name, a wrong upsert conflict target, a payload
// shape that doesn't match sql/002_schema.sql, or a session-less call that
// should short-circuit instead of hitting the network with a null user id.
//
// Every real query in supabase-client.js is checked against the exact
// table/column names created in sql/002_schema.sql, so a typo here would
// have been an actual "column does not exist" error against a live project.
const assert = require("assert");

// ---- Fake supabase-js query builder ---------------------------------------
class FakeQueryBuilder {
  constructor(table, log, results) {
    this.table = table;
    this.log = log;
    this.results = results;
    this.calls = [];
  }
  _push(entry) { this.calls.push(entry); return this; }
  select(cols) { return this._push(["select", cols]); }
  insert(payload) { return this._push(["insert", payload]); }
  upsert(payload, opts) { return this._push(["upsert", payload, opts]); }
  update(payload) { return this._push(["update", payload]); }
  delete() { return this._push(["delete"]); }
  eq(col, val) { return this._push(["eq", col, val]); }
  order(col, opts) { return this._push(["order", col, opts]); }
  _finish() {
    this.log.push({ table: this.table, calls: this.calls });
    const key = this.table;
    return Promise.resolve(this.results[key] || { data: null, error: null });
  }
  maybeSingle() { this._push(["maybeSingle"]); return this._finish(); }
  single() { this._push(["single"]); return this._finish(); }
  then(resolve, reject) { return this._finish().then(resolve, reject); }
}

function makeFakeSupabase({ userId = "user-123", results = {}, rpcResults = {} } = {}) {
  const log = [];
  const rpcLog = [];
  return {
    log,
    rpcLog,
    auth: {
      signUp: async (args) => { log.push({ auth: "signUp", args }); return { data: {}, error: null }; },
      signInWithPassword: async (args) => { log.push({ auth: "signInWithPassword", args }); return { data: {}, error: null }; },
      signOut: async () => { log.push({ auth: "signOut" }); return { error: null }; },
      getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null }),
      getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }),
      onAuthStateChange: (cb) => { log.push({ auth: "onAuthStateChange" }); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from(table) { return new FakeQueryBuilder(table, log, results); },
    rpc(name, params) {
      rpcLog.push({ name, params });
      return {
        maybeSingle: async () => rpcResults[name] || { data: null, error: null },
        then: (resolve, reject) => Promise.resolve(rpcResults[name] || { data: null, error: null }).then(resolve, reject),
      };
    },
  };
}

const results = [];
function check(label, cond) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

const { createDb } = require("../supabase-client.js");

(async () => {
  console.log("== Auth passthrough shape ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);
    await db.signUp("a@b.com", "secret1", "Alice");
    const call = fake.log.find(l => l.auth === "signUp");
    check("signUp passes email/password straight through", call.args.email === "a@b.com" && call.args.password === "secret1");
    check("signUp puts the name in options.data.name (read by handle_new_user() trigger)", call.args.options.data.name === "Alice");

    await db.signIn("a@b.com", "secret1");
    check("signIn calls auth.signInWithPassword with email+password", !!fake.log.find(l => l.auth === "signInWithPassword" && l.args.email === "a@b.com"));

    await db.signOut();
    check("signOut calls auth.signOut", !!fake.log.find(l => l.auth === "signOut"));
  }

  console.log("\n== Birth data: correct table/columns, upsert conflict target ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);
    await db.saveBirthData({ year: 1990, month: 8, day: 10, city_name: "Mumbai", sun_idx: 4 });
    const entry = fake.log.find(l => l.table === "birth_data");
    check("saveBirthData writes to the birth_data table", !!entry);
    const upsertCall = entry.calls.find(c => c[0] === "upsert");
    check("saveBirthData calls upsert() (not insert) so re-onboarding overwrites, not duplicates", !!upsertCall);
    check("saveBirthData upserts onConflict: 'user_id' (the table's primary key)", upsertCall[2] && upsertCall[2].onConflict === "user_id");
    check("saveBirthData passes field names matching the schema exactly (city_name, sun_idx)", "city_name" in upsertCall[1] && "sun_idx" in upsertCall[1]);

    await db.loadBirthData();
    const loadEntry = fake.log.filter(l => l.table === "birth_data").pop();
    const eqCall = loadEntry.calls.find(c => c[0] === "eq");
    check("loadBirthData filters by eq('user_id', <current user>)", eqCall[1] === "user_id" && eqCall[2] === "user-123");
    check("loadBirthData calls maybeSingle() (0 or 1 row, not an array)", !!loadEntry.calls.find(c => c[0] === "maybeSingle"));
  }

  console.log("\n== Birth/palm/unlock loads short-circuit when logged out (no network call with a null user id) ==");
  {
    const fake = makeFakeSupabase({ userId: null });
    const db = createDb(fake);
    const r1 = await db.loadBirthData();
    check("loadBirthData returns {data:null,error:null} without querying when there's no session", r1.data === null && r1.error === null && !fake.log.find(l => l.table === "birth_data"));
    const r2 = await db.loadPalmReport();
    check("loadPalmReport short-circuits the same way when logged out", r2.data === null && !fake.log.find(l => l.table === "palm_reports"));
    const r3 = await db.loadUnlockStatus();
    check("loadUnlockStatus short-circuits the same way when logged out", r3.data === null && !fake.log.find(l => l.table === "unlocks"));
  }

  console.log("\n== Palm reports ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);
    await db.savePalmReport({ q1: "long" }, { summary: "x" });
    const entry = fake.log.find(l => l.table === "palm_reports");
    const upsertCall = entry.calls.find(c => c[0] === "upsert");
    check("savePalmReport upserts onConflict: 'user_id'", upsertCall[2] && upsertCall[2].onConflict === "user_id");
    check("savePalmReport sends both answers and report keys", "answers" in upsertCall[1] && "report" in upsertCall[1]);
  }

  console.log("\n== Purchases/unlocks go through RPC, never a raw table write ==");
  {
    const fake = makeFakeSupabase({ rpcResults: { record_test_purchase: { data: null, error: null } } });
    const db = createDb(fake);
    await db.recordTestPurchase("bundle", 59900, "upi");
    const call = fake.rpcLog.find(r => r.name === "record_test_purchase");
    check("recordTestPurchase calls the record_test_purchase RPC (not an insert into purchases/unlocks)", !!call);
    check("recordTestPurchase passes p_tier/p_amount_paise/p_payment_method matching the SQL function's parameter names", call.params.p_tier === "bundle" && call.params.p_amount_paise === 59900 && call.params.p_payment_method === "upi");
    const src = require("fs").readFileSync(require("path").join(__dirname, "../supabase-client.js"), "utf8");
    check("supabase-client.js never reads/writes the purchases table directly (only via the RPC)", !src.includes('.from("purchases")'));
    check("supabase-client.js never inserts/updates the unlocks table directly (only reads it — writes only via the RPCs)", !/\.from\("unlocks"\)\s*\.\s*(insert|update)\(/.test(src));
  }

  console.log("\n== Gifting ==");
  {
    const fake = makeFakeSupabase({ rpcResults: { redeem_gift_code: { data: { tier: "onetime", recipient_name: "Bob" }, error: null } } });
    const db = createDb(fake);
    await db.sendGift("NKSH-AAAA-BBBB", "onetime", "Bob", "Happy birthday!");
    const entry = fake.log.find(l => l.table === "gift_codes");
    const insertCall = entry.calls.find(c => c[0] === "insert");
    check("sendGift inserts into gift_codes with recipient_name (snake_case matching the column)", insertCall[1].recipient_name === "Bob");
    check("sendGift does NOT send sender_id (the column defaults to auth.uid() — see schema)", !("sender_id" in insertCall[1]));

    const redeemResult = await db.redeemGiftCode("NKSH-AAAA-BBBB");
    const rpcCall = fake.rpcLog.find(r => r.name === "redeem_gift_code");
    check("redeemGiftCode calls the redeem_gift_code RPC with p_code", rpcCall.params.p_code === "NKSH-AAAA-BBBB");
    check("redeemGiftCode returns the function's result data straight through", redeemResult.data.tier === "onetime");
  }

  console.log("\n== Chat ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);
    await db.sendChatMessage("priya", "user", "Hello!");
    const entry = fake.log.find(l => l.table === "chat_messages");
    const insertCall = entry.calls.find(c => c[0] === "insert");
    check("sendChatMessage inserts astrologer_id/sender/text matching the schema", insertCall[1].astrologer_id === "priya" && insertCall[1].sender === "user" && insertCall[1].text === "Hello!");

    await db.loadChatMessages("priya");
    const loadEntry = fake.log.filter(l => l.table === "chat_messages").pop();
    check("loadChatMessages filters by astrologer_id", !!loadEntry.calls.find(c => c[0] === "eq" && c[1] === "astrologer_id" && c[2] === "priya"));
    check("loadChatMessages orders by created_at ascending (oldest first, matching how chat renders)", !!loadEntry.calls.find(c => c[0] === "order" && c[1] === "created_at" && c[2].ascending === true));
  }

  console.log("\n== Community ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);
    await db.loadCommunityFeed();
    check("loadCommunityFeed reads from the community_feed VIEW (not community_posts directly — it needs the joined like_count/liked_by_me columns)", !!fake.log.find(l => l.table === "community_feed"));

    await db.postToCommunity({ name: "Alice", avatar: "✦", sign_idx: 4, caption: "hi", image_url: "data:..." });
    const postEntry = fake.log.filter(l => l.table === "community_posts").pop();
    const insertCall = postEntry.calls.find(c => c[0] === "insert");
    check("postToCommunity inserts into community_posts with sign_idx (not signIdx — matches the SQL column name)", "sign_idx" in insertCall[1]);
    check("postToCommunity does NOT send user_id (defaults to auth.uid())", !("user_id" in insertCall[1]));

    await db.likePost("post-1");
    const likeEntry = fake.log.filter(l => l.table === "community_likes").pop();
    check("likePost inserts into community_likes with post_id only (user_id defaults to auth.uid())", likeEntry.calls.find(c => c[0] === "insert")[1].post_id === "post-1");

    await db.unlikePost("post-1");
    const unlikeEntry = fake.log.filter(l => l.table === "community_likes").pop();
    check("unlikePost deletes filtered by both post_id and user_id (can't accidentally delete someone else's like row shape-wise)", !!unlikeEntry.calls.find(c => c[0] === "eq" && c[1] === "post_id") && !!unlikeEntry.calls.find(c => c[0] === "eq" && c[1] === "user_id"));
  }

  console.log(`\n=== RESULT: ${results.filter(r => r.pass).length} / ${results.length} checks passed ===`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.log("FAILED:", failed.map(f => f.label));
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
