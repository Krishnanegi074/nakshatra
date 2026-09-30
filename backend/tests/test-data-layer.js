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
  limit(n) { return this._push(["limit", n]); }
  _finish() {
    this.log.push({ table: this.table, calls: this.calls });
    const key = this.table;
    return Promise.resolve(this.results[key] || { data: null, error: null });
  }
  maybeSingle() { this._push(["maybeSingle"]); return this._finish(); }
  single() { this._push(["single"]); return this._finish(); }
  then(resolve, reject) { return this._finish().then(resolve, reject); }
}

// Fake realtime channel for subscribeToSessionMessages/subscribeToSessionStatus
// (Phase 4 — see supabase-client.js) — records what .on("postgres_changes",
// {event, schema, table, filter}, cb) was actually asked to subscribe to.
// This can't (and isn't trying to) prove a live realtime connection works —
// only this sandbox's usual class of bug: a wrong table name, a wrong event
// type, or a filter that doesn't match the column the RLS policy actually
// scopes on.
class FakeChannel {
  constructor(name, log, opts) {
    this.name = name;
    this.opts = opts;
    this.log = log;
    this.subs = [];
  }
  on(type, opts, cb) {
    this.subs.push({ type, opts, cb });
    return this;
  }
  subscribe(statusCb) {
    this.log.push({ name: this.name, subs: this.subs, opts: this.opts, statusCb });
    return this;
  }
}

const fake_setAuthCalls = { n: 0 };
function makeFakeSupabase({ userId = "user-123", results = {}, rpcResults = {}, functionResults = {} } = {}) {
  const log = [];
  const rpcLog = [];
  const functionsLog = [];
  const channelLog = [];
  const removedChannels = [];
  return {
    log,
    rpcLog,
    functionsLog,
    channelLog,
    removedChannels,
    channel(name, opts) { return new FakeChannel(name, channelLog, opts); },
    realtime: { setAuth: async () => { fake_setAuthCalls.n++; } },
    removeChannel(ch) { removedChannels.push(ch.name); },
    functions: {
      invoke: async (name, opts) => {
        functionsLog.push({ name, opts });
        return functionResults[name] || { data: null, error: null };
      },
    },
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

// Points at the real, live app/supabase-client.js — NOT a local copy. A
// duplicate used to live at backend/supabase-client.js and had silently
// drifted out of sync (missing resetPasswordForEmail/updatePassword/
// signInWithGoogle and the old loadUnlockStatus instead of loadEntitlements)
// by the time this pass found it; it's been removed so there's exactly one
// source of truth and this suite can never again test a stale copy.
const { createDb } = require("../../app/supabase-client.js");

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

  console.log("\n== Birth/palm/entitlement loads short-circuit when logged out (no network call with a null user id) ==");
  {
    const fake = makeFakeSupabase({ userId: null });
    const db = createDb(fake);
    const r1 = await db.loadBirthData();
    check("loadBirthData returns {data:null,error:null} without querying when there's no session", r1.data === null && r1.error === null && !fake.log.find(l => l.table === "birth_data"));
    const r2 = await db.loadPalmReport();
    check("loadPalmReport short-circuits the same way when logged out", r2.data === null && !fake.log.find(l => l.table === "palm_reports"));
    const r3 = await db.loadEntitlements();
    // loadEntitlements() returns an empty ARRAY (not null) when logged out —
    // it's a multi-row result by design (see supabase-client.js), and app.js
    // does `entitlementsRes.data.map(...)`, which would throw on null.
    check("loadEntitlements short-circuits the same way when logged out, returning [] not null", Array.isArray(r3.data) && r3.data.length === 0 && !fake.log.find(l => l.table === "user_entitlements"));
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

  console.log("\n== Purchases/entitlements go through RPC, never a raw table write ==");
  {
    const fake = makeFakeSupabase({ rpcResults: { record_test_purchase: { data: null, error: null } } });
    const db = createDb(fake);
    await db.recordTestPurchase("bundle", 59900, "upi");
    const call = fake.rpcLog.find(r => r.name === "record_test_purchase");
    check("recordTestPurchase calls the record_test_purchase RPC (not an insert into purchases/user_entitlements)", !!call);
    check("recordTestPurchase passes p_tier/p_amount_paise/p_payment_method matching the SQL function's parameter names", call.params.p_tier === "bundle" && call.params.p_amount_paise === 59900 && call.params.p_payment_method === "upi");
    const src = require("fs").readFileSync(require("path").join(__dirname, "../../app/supabase-client.js"), "utf8");
    check("supabase-client.js never reads/writes the purchases table directly (only via the RPC)", !src.includes('.from("purchases")'));
    check("supabase-client.js never inserts/updates the user_entitlements table directly (only reads it — writes only via grant_entitlement(), called from the RPCs)", !/\.from\("user_entitlements"\)\s*\.\s*(insert|update)\(/.test(src));
  }

  console.log("\n== Real payments (Razorpay) go through Edge Functions, never a raw table write ==");
  {
    const fake = makeFakeSupabase({
      functionResults: {
        "create-razorpay-order": { data: { key_id: "rzp_test_x", order_id: "order_abc", amount: 39900, currency: "INR" }, error: null },
        "verify-razorpay-payment": { data: { tier: "onetime", gift_code: null }, error: null },
      },
    });
    const db = createDb(fake);

    await db.createRazorpayOrder("onetime");
    const selfCall = fake.functionsLog.find(f => f.name === "create-razorpay-order");
    check("createRazorpayOrder invokes the create-razorpay-order Edge Function", !!selfCall);
    check("createRazorpayOrder sends { tier } only when there's no gift (no gift key at all)", selfCall.opts.body.tier === "onetime" && !("gift" in selfCall.opts.body));

    await db.createRazorpayOrder("bundle", { recipientName: "Priya", message: "Happy birthday!" });
    const giftCall = fake.functionsLog.filter(f => f.name === "create-razorpay-order")[1];
    check("createRazorpayOrder sends { tier, gift } when buying as a gift, gift matching { recipientName, message } exactly", giftCall.opts.body.tier === "bundle" && giftCall.opts.body.gift.recipientName === "Priya" && giftCall.opts.body.gift.message === "Happy birthday!");

    const razorpayResponse = { razorpay_order_id: "order_abc", razorpay_payment_id: "pay_xyz", razorpay_signature: "deadbeef" };
    await db.verifyRazorpayPayment(razorpayResponse);
    const verifyCall = fake.functionsLog.find(f => f.name === "verify-razorpay-payment");
    check("verifyRazorpayPayment invokes the verify-razorpay-payment Edge Function", !!verifyCall);
    check("verifyRazorpayPayment forwards Razorpay Checkout's handler response untouched as the body", JSON.stringify(verifyCall.opts.body) === JSON.stringify(razorpayResponse));

    const src2 = require("fs").readFileSync(require("path").join(__dirname, "../../app/supabase-client.js"), "utf8");
    const startIdx = src2.indexOf("async createRazorpayOrder");
    const verifyIdx = src2.indexOf("async verifyRazorpayPayment", startIdx);
    // Ends exactly at verifyRazorpayPayment's OWN closing "}," rather than
    // at a hardcoded next-section marker name — a marker-name boundary
    // silently starts including whatever gets inserted between these two
    // functions and that marker in the future (caught for real: Expert
    // Chat's functions landed right after verifyRazorpayPayment, ahead of
    // the old "GIFTING" marker, and their own legitimate .from() calls
    // started failing this check). Self-contained to these two functions'
    // bodies instead, regardless of what's added around them later.
    const endIdx = src2.indexOf("},", verifyIdx) + 2;
    const realPaymentsSection = src2.slice(startIdx, endIdx);
    check("createRazorpayOrder/verifyRazorpayPayment never touch purchases/user_entitlements/gift_codes directly — only the Edge Functions do (via complete_razorpay_order)", startIdx !== -1 && verifyIdx !== -1 && !realPaymentsSection.includes(".from("));
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

  console.log("\n== Expert chat (real) — backend/sql/009_expert_chat.sql / 010_expert_customer_name.sql ==");
  {
    const fake = makeFakeSupabase();
    const db = createDb(fake);

    await db.createExpertSessionOrder();
    const orderCall = fake.functionsLog.find(l => l.name === "create-expert-session-order");
    check("createExpertSessionOrder invokes the create-expert-session-order Edge Function", !!orderCall);

    const razorpayResponse = { razorpay_order_id: "order_x", razorpay_payment_id: "pay_x", razorpay_signature: "sig_x" };
    await db.verifyExpertSessionPayment(razorpayResponse);
    const verifyCall = fake.functionsLog.find(l => l.name === "verify-expert-session-payment");
    check("verifyExpertSessionPayment invokes verify-expert-session-payment with the razorpayResponse as the body", !!verifyCall && verifyCall.opts.body === razorpayResponse);

    await db.loadOnlineExperts();
    const onlineEntry = fake.log.filter(l => l.table === "experts_public").pop();
    check("loadOnlineExperts reads experts_public (the narrow view — never the raw experts table)", !!onlineEntry);
    check("loadOnlineExperts filters by eq('is_online', true)", !!onlineEntry.calls.find(c => c[0] === "eq" && c[1] === "is_online" && c[2] === true));

    await db.loadExpertPublicInfo("expert-1");
    const infoEntry = fake.log.filter(l => l.table === "experts_public").pop();
    check("loadExpertPublicInfo also reads experts_public, filtered by id (not is_online — works even if that expert has since gone offline)", !!infoEntry.calls.find(c => c[0] === "eq" && c[1] === "id" && c[2] === "expert-1"));
    check("loadExpertPublicInfo calls maybeSingle()", !!infoEntry.calls.find(c => c[0] === "maybeSingle"));

    await db.loadActiveExpertSession();
    const activeEntry = fake.log.filter(l => l.table === "chat_sessions").pop();
    check("loadActiveExpertSession reads chat_sessions filtered by status='active'", !!activeEntry.calls.find(c => c[0] === "eq" && c[1] === "status" && c[2] === "active"));
    check("...ordered newest-first and limited to 1 (at most one row even if a customer somehow holds two)", !!activeEntry.calls.find(c => c[0] === "order" && c[2].ascending === false) && !!activeEntry.calls.find(c => c[0] === "limit" && c[1] === 1));
    check("...and calls maybeSingle(), not single() (0 rows — no active session — is a normal, expected state, not an error)", !!activeEntry.calls.find(c => c[0] === "maybeSingle"));

    await db.endExpertSession("session-1");
    const endEntry = fake.log.filter(l => l.table === "chat_sessions").pop();
    const updateCall = endEntry.calls.find(c => c[0] === "update");
    check("endExpertSession updates status/ended_at only (the two columns 009_expert_chat.sql actually grants UPDATE on)", updateCall[1].status === "ended" && "ended_at" in updateCall[1]);
    check("...filtered to the one session by id", !!endEntry.calls.find(c => c[0] === "eq" && c[1] === "id" && c[2] === "session-1"));

    await db.loadSessionMessages("session-1");
    const msgLoadEntry = fake.log.filter(l => l.table === "chat_messages").pop();
    check("loadSessionMessages filters chat_messages by session_id (not astrologer_id — the real-session shape, not the demo's)", !!msgLoadEntry.calls.find(c => c[0] === "eq" && c[1] === "session_id" && c[2] === "session-1"));
    check("loadSessionMessages orders by created_at ascending, same as the demo's loadChatMessages", !!msgLoadEntry.calls.find(c => c[0] === "order" && c[1] === "created_at" && c[2].ascending === true));
    const selectCall = msgLoadEntry.calls.find(c => c[0] === "select");
    check("loadSessionMessages selects the message id (needed to de-duplicate history against messages held from the live channel)", !!selectCall && /\bid\b/.test(String(selectCall[1])), selectCall && selectCall[1]);

    await db.sendSessionMessage("session-1", "Hello!");
    const msgSendEntry = fake.log.filter(l => l.table === "chat_messages").pop();
    const sendInsertCall = msgSendEntry.calls.find(c => c[0] === "insert");
    check("sendSessionMessage inserts session_id + sender='user' + text", sendInsertCall[1].session_id === "session-1" && sendInsertCall[1].sender === "user" && sendInsertCall[1].text === "Hello!");
    check("...and does NOT send user_id (defaults to auth.uid(), same convention as postToCommunity/likePost above — required to equal the session's own customer id, which is exactly what the default gives it)", !("user_id" in sendInsertCall[1]));

    // Phase 4 — Realtime subscriptions, replacing what used to be polling
    // on both this side and the expert dashboard.
    const msgCalls = [];
    const unsubMessages = db.subscribeToSessionMessages("session-1", (m) => msgCalls.push(m));
    await new Promise(r => setImmediate(r)); // subscription starts after the async realtime.setAuth()
    check("subscribeToSessionMessages calls realtime.setAuth() before joining (private channels need the JWT on the socket)", fake_setAuthCalls.n >= 1);
    const msgChannelEntry = fake.channelLog.find(c => c.name === "session:session-1");
    check("subscribeToSessionMessages joins the topic session:<id> (matches the realtime.messages RLS policy in 011_chat_broadcast.sql)", !!msgChannelEntry);
    check("...as a PRIVATE channel", !!msgChannelEntry && msgChannelEntry.opts && msgChannelEntry.opts.config && msgChannelEntry.opts.config.private === true);
    const msgSub = msgChannelEntry && msgChannelEntry.subs[0];
    check("...subscribes to broadcast events", !!msgSub && msgSub.type === "broadcast");
    check("...on the INSERT event only (messages are append-only)", msgSub.opts.event === "INSERT");
    msgSub.cb({ payload: { record: { sender: "astro", text: "Hi there" } } });
    check("the onInsert callback receives payload.record (not the raw broadcast envelope)", msgCalls.length === 1 && msgCalls[0].text === "Hi there");
    check("subscribeToSessionMessages returns an unsubscribe function", typeof unsubMessages === "function");
    unsubMessages();
    check("...which calls removeChannel() on exactly that channel", fake.removedChannels.includes("session:session-1"));

    // onReady: history must be read only AFTER the channel has really joined,
    // or a message inserted in between is in neither (the resume-race bug).
    {
      let readyCalls = 0;
      const unsubReady = db.subscribeToSessionMessages("session-r", () => {}, () => { readyCalls++; });
      await new Promise(r => setImmediate(r));
      const entry = fake.channelLog.find(c => c.name === "session:session-r");
      check("subscribeToSessionMessages passes a status callback to subscribe()", !!entry && typeof entry.statusCb === "function");
      check("onReady does NOT fire before the channel has joined", readyCalls === 0);
      entry.statusCb("CHANNEL_ERROR"); entry.statusCb("TIMED_OUT");
      check("...nor on CHANNEL_ERROR / TIMED_OUT", readyCalls === 0);
      entry.statusCb("SUBSCRIBED");
      check("...it fires when the status reaches SUBSCRIBED", readyCalls === 1);
      unsubReady();
      const unsubNoCb = db.subscribeToSessionMessages("session-n", () => {});
      await new Promise(r => setImmediate(r));
      const entry2 = fake.channelLog.find(c => c.name === "session:session-n");
      let threw = false; try { entry2.statusCb("SUBSCRIBED"); } catch (_) { threw = true; }
      check("calling it WITHOUT an onReady (existing callers) is still safe", !threw);
      unsubNoCb();
    }

    // Unsubscribing BEFORE setAuth() resolves must cancel the pending join
    // (otherwise a channel would leak that nothing can ever remove).
    const before = fake.channelLog.length;
    const unsubEarly = db.subscribeToSessionMessages("session-2", () => {});
    unsubEarly();
    await new Promise(r => setImmediate(r));
    check("unsubscribing before setAuth() resolves cancels the join (no leaked channel)", fake.channelLog.length === before);

    const statusCalls = [];
    const unsubStatus = db.subscribeToSessionStatus("session-1", (row) => statusCalls.push(row));
    const statusChannelEntry = fake.channelLog.find(c => c.name === "session-status-session-1");
    const statusSub = statusChannelEntry && statusChannelEntry.subs[0];
    check("subscribeToSessionStatus subscribes to UPDATE (status flipping to 'ended' is the one this exists for)", !!statusSub && statusSub.opts.event === "UPDATE");
    check("...on chat_sessions, filtered by id (not session_id — chat_sessions' own primary key column, unlike chat_messages' foreign key)", statusSub.opts.table === "chat_sessions" && statusSub.opts.filter === "id=eq.session-1");
    statusSub.cb({ new: { id: "session-1", status: "ended" } });
    check("the onUpdate callback receives payload.new", statusCalls.length === 1 && statusCalls[0].status === "ended");
    unsubStatus();
    check("subscribeToSessionStatus's unsubscribe also calls removeChannel() on its own (different-named) channel", fake.removedChannels.includes("session-status-session-1"));
  }

  console.log("\n== Expert payment: a non-2xx Edge Function response's own message reaches the caller ==");
  {
    // supabase-js resolves a non-2xx response as { data: null, error } with the
    // function's JSON body unread on error.context (a Response). The wrappers
    // must read it and return it as `data` so app.js can show the message.
    const httpError = (body) => ({ message: "Edge Function returned a non-2xx status code", context: { json: async () => body } });
    const run = async (name, method, result) => {
      const fake = makeFakeSupabase({ functionResults: { [name]: result } });
      const db = createDb(fake);
      return method === "createExpertSessionOrder"
        ? db.createExpertSessionOrder()
        : db.verifyExpertSessionPayment({ razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s" });
    };
    let r = await run("verify-expert-session-payment", "verifyExpertSessionPayment", { data: null, error: httpError({ error: "No experts are available right now — you have not been charged." }) });
    check("verify: the refund-case message ('you have not been charged') is returned as data.error", r.data && r.data.error === "No experts are available right now — you have not been charged." && r.error === null);
    r = await run("create-expert-session-order", "createExpertSessionOrder", { data: null, error: httpError({ error: "All our experts are busy right now — please try again in a few minutes." }) });
    check("create: the 'experts are busy' message is returned as data.error", r.data && /busy/.test(r.data.error) && r.error === null);
    const netErr = { message: "Failed to send a request to the Edge Function" };
    r = await run("create-expert-session-order", "createExpertSessionOrder", { data: null, error: netErr });
    check("a network-level failure (no response body) keeps the original error, so callers still show their generic message", r.error === netErr && r.data === null);
    r = await run("verify-expert-session-payment", "verifyExpertSessionPayment", { data: null, error: { message: "x", context: { json: async () => { throw new Error("not json"); } } } });
    check("a non-JSON error body falls back to the original error instead of throwing", r.error && r.error.message === "x");
    r = await run("verify-expert-session-payment", "verifyExpertSessionPayment", { data: null, error: httpError({ unrelated: true }) });
    check("a JSON body with no string .error keeps the original error", r.error !== null && r.data === null);
    const okRes = { data: { session_id: "s1", expert_name: "Test Expert", expert_specialty: "General" }, error: null };
    r = await run("verify-expert-session-payment", "verifyExpertSessionPayment", okRes);
    check("a successful response passes through untouched", r.data && r.data.session_id === "s1" && r.error === null);
  }

  console.log(`\n=== RESULT: ${results.filter(r => r.pass).length} / ${results.length} checks passed ===`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.log("FAILED:", failed.map(f => f.label));
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
