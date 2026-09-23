// Injected into the page via page.addInitScript() BEFORE any of the app's
// own scripts run. Defines window.supabase.createClient(...) so
// supabase-client.js picks it up and NakshatraDB.db becomes non-null,
// exercising every real backend-integration code path in app.js against a
// faithful in-memory reimplementation of sql/002_schema.sql's semantics —
// including its RLS-equivalent row scoping and the two RPC functions —
// without any real network access (which this sandbox doesn't have).
//
// This does NOT replace tests/test-rls.js (real Postgres) or
// tests/test-data-layer.js (call-shape verification) in nakshatra-backend/ —
// it complements them by proving the *app's UI* actually calls this layer
// correctly end-to-end (signup screen -> real save -> dashboard renders it,
// reload -> session restored, etc.), which those two suites can't see since
// they don't touch app.js or the DOM at all.
(function () {
  "use strict";

  let seq = 0;
  const uid = (prefix) => prefix + "-" + (++seq);

  const store = {
    users: [], // {id, email, password, user_metadata}
    profiles: [], // {id, name, email}
    birth_data: [], // {user_id, ...}
    palm_reports: [], // {user_id, answers, report}
    // {user_id, tier, source, granted_at} — one row per (user_id, tier) a
    // user has actually purchased/been gifted (see
    // backend/sql/005_tier_entitlements.sql). Replaces the old single-row
    // `unlocks` table (kept below, empty, purely so a stray reference to it
    // doesn't throw — nothing writes to it anymore, matching the real
    // grant_entitlement()-based functions in that migration).
    user_entitlements: [],
    unlocks: [], // deliberately unused — see user_entitlements above
    purchases: [], // {id, user_id, tier, amount_paise, payment_method, status}
    gift_codes: [], // {code, sender_id, tier, recipient_name, message, redeemed, redeemed_by}
    chat_messages: [], // {id, user_id, astrologer_id, sender, text, created_at}
    community_posts: [], // {id, user_id, name, avatar, sign_idx, caption, image_url, created_at}
    community_likes: [], // {user_id, post_id}
    razorpay_orders: [], // {order_id, user_id, tier, amount_paise, gift_recipient_name, gift_message, status} — mirrors sql/004_razorpay_payments.sql; never touched via .from(), only through the two fake Edge Functions below
  };
  let session = null; // {user: {id, email, user_metadata}}

  window.__fakeSupabaseStore = store; // exposed so tests can assert directly on server-side state
  window.__fakeSupabaseSetSession = (s) => { session = s; };
  window.__fakeSupabaseGetSession = () => session;
  window.__fakeSupabaseGetSeq = () => seq; // exposed so a reload-seed can carry the id counter forward too — see below
  // Used by tests to simulate "already logged in, reloading the page" without
  // real persistence: capture {store, session} via the getters above, then
  // register a SECOND addInitScript (after this one) that calls this with
  // the captured snapshot — since it runs after this IIFE on the next
  // navigation but still before any real app script, bootstrapSession() sees
  // pre-populated data exactly like a real returning session would.
  window.__fakeSupabaseApplySeed = function (seed) {
    if (!seed) return;
    Object.keys(seed.store).forEach((k) => {
      store[k].length = 0;
      store[k].push.apply(store[k], seed.store[k]);
    });
    session = seed.session;
    // IMPORTANT: this whole file is a fresh IIFE closure on every reload, so
    // `seq` (and therefore uid()) restarts at 0 unless carried over here too
    // — without this, any user/purchase/order/etc. created AFTER a
    // page.reload() collides with an id already used by data restored above
    // (e.g. a brand-new signup could be handed the same "user-1" id an
    // earlier, still-present user already owns), corrupting whichever table
    // happens to share that id. Take whichever is larger so a seed captured
    // from an older/smaller run never moves the counter backwards.
    if (typeof seed.seq === "number") seq = Math.max(seq, seed.seq);
  };

  function currentUserId() { return session && session.user.id; }

  function requireOwn(row, table) {
    // Mirrors the RLS boundary: never return/mutate another user's row.
    // profiles is keyed by `id` (= auth.uid()), same as profiles_update_own's
    // real RLS policy (sql/002_schema.sql) — every other table here is
    // keyed by a separate `user_id` column instead.
    if (!row) return undefined;
    const ownerCol = table === "profiles" ? "id" : "user_id";
    return row[ownerCol] === currentUserId() ? row : undefined;
  }

  class FakeBuilder {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this._select = null;
      this._selectCalled = false; // tracked separately from `_select` — .select() with no args (common for insert().select().single()) leaves `_select` falsy (undefined), which must still count as "select was called"
      this._insertPayload = null;
      this._upsertPayload = null;
      this._upsertOpts = null;
      this._updatePayload = null;
      this._delete = false;
      this._order = null;
    }
    select(cols) { this._select = cols; this._selectCalled = true; return this; }
    insert(payload) { this._insertPayload = payload; return this; }
    upsert(payload, opts) { this._upsertPayload = payload; this._upsertOpts = opts; return this; }
    update(payload) { this._updatePayload = payload; return this; }
    delete() { this._delete = true; return this; }
    eq(col, val) { this.filters.push([col, val]); return this; }
    order(col, opts) { this._order = { col, ascending: !opts || opts.ascending !== false }; return this; }

    _matches(row) { return this.filters.every(([c, v]) => row[c] === v); }

    _run() {
      const rows = store[this.table];
      const uidNow = currentUserId();

      if (this._insertPayload) {
        const payload = Array.isArray(this._insertPayload) ? this._insertPayload : [this._insertPayload];
        const created = payload.map((p) => {
          const row = Object.assign({}, p);
          if ("user_id" in this._defaultsFor()) row.user_id = row.user_id || uidNow;
          if (this.table === "gift_codes") row.sender_id = row.sender_id || uidNow;
          if (["community_posts", "chat_messages"].includes(this.table)) row.id = row.id || uid(this.table);
          if (this.table === "community_posts") { row.created_at = new Date(Date.now()).toISOString(); row.avatar = row.avatar || "✦"; }
          if (this.table === "chat_messages") row.created_at = new Date(Date.now() + rows.length).toISOString();
          if (this.table === "gift_codes") { row.redeemed = false; row.redeemed_by = null; }
          if (this.table === "community_likes") row.user_id = row.user_id || uidNow;
          rows.push(row);
          return row;
        });
        return { data: this._selectCalled ? (created.length === 1 ? created[0] : created) : null, error: null };
      }

      if (this._upsertPayload) {
        const p = Object.assign({}, this._upsertPayload);
        if (!p.user_id) p.user_id = uidNow;
        const key = (this._upsertOpts && this._upsertOpts.onConflict) || "user_id";
        const idx = rows.findIndex((r) => r[key] === p[key]);
        if (idx >= 0) rows[idx] = Object.assign({}, rows[idx], p, { updated_at: new Date().toISOString() });
        else rows.push(Object.assign({ updated_at: new Date().toISOString() }, p));
        return { data: null, error: null };
      }

      if (this._updatePayload) {
        rows.forEach((r, i) => { if (this._matches(r) && requireOwn(r, this.table)) rows[i] = Object.assign({}, r, this._updatePayload); });
        return { data: null, error: null };
      }

      if (this._delete) {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (this._matches(rows[i]) && requireOwn(rows[i], this.table)) rows.splice(i, 1);
        }
        return { data: null, error: null };
      }

      // SELECT
      let result;
      if (this.table === "community_feed") {
        result = store.community_posts.map((p) => {
          const likes = store.community_likes.filter((l) => l.post_id === p.id);
          return Object.assign({}, p, {
            like_count: likes.length,
            liked_by_me: likes.some((l) => l.user_id === uidNow),
          });
        });
      } else {
        // Tables that are private-per-user in the real schema (per sql/002_schema.sql's
        // RLS) are scoped to the caller here too, mirroring that boundary.
        const scoped = ["birth_data", "palm_reports", "user_entitlements", "unlocks", "purchases", "chat_messages", "profiles"];
        result = rows.filter((r) => (scoped.includes(this.table) ? r.user_id === uidNow || (this.table === "profiles" && r.id === uidNow) : true));
        if (this.table === "gift_codes") result = rows.filter((r) => r.sender_id === uidNow);
      }
      result = result.filter((r) => this._matches(r));
      if (this._order) {
        result = result.slice().sort((a, b) => {
          const av = a[this._order.col], bv = b[this._order.col];
          return this._order.ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
        });
      }
      return { data: result, error: null };
    }

    _defaultsFor() {
      // Which tables have a user_id column that defaults to auth.uid() in the real schema.
      const withUserId = { birth_data: 1, palm_reports: 1, chat_messages: 1, community_posts: 1, community_likes: 1 };
      return withUserId[this.table] ? { user_id: true } : {};
    }

    maybeSingle() {
      const { data, error } = this._run();
      if (error) return Promise.resolve({ data: null, error });
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      return Promise.resolve({ data: arr[0] || null, error: null });
    }
    single() {
      const { data, error } = this._run();
      if (error) return Promise.resolve({ data: null, error });
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      return Promise.resolve({ data: arr[0] || null, error: arr[0] ? null : { message: "no rows" } });
    }
    then(resolve, reject) {
      return Promise.resolve(this._run()).then(resolve, reject);
    }
  }

  // Test hook: window.__fakeSupabaseForceNextError() makes the NEXT rpc call
  // fail, so the UI's failure-handling branches (which a fake that always
  // succeeds could never reach) get exercised too.
  let forceNextRpcError = false;
  window.__fakeSupabaseForceNextError = () => { forceNextRpcError = true; };

  // Mirrors grant_entitlement() in backend/sql/005_tier_entitlements.sql:
  // idempotent per (user_id, tier) — the THING this migration fixes is that
  // granting a second, DIFFERENT tier must add a row, never overwrite/erase
  // the first (the old `unlocks` table's exact bug).
  function grantEntitlement(userId, tier, source) {
    const exists = store.user_entitlements.some((e) => e.user_id === userId && e.tier === tier);
    if (!exists) store.user_entitlements.push({ user_id: userId, tier, source, granted_at: new Date().toISOString() });
  }

  function rpcRecordTestPurchase(params) {
    if (forceNextRpcError) { forceNextRpcError = false; return { data: null, error: { message: "simulated failure" } }; }
    const userId = currentUserId();
    store.purchases.push({ id: uid("purchase"), user_id: userId, tier: params.p_tier, amount_paise: params.p_amount_paise, payment_method: params.p_payment_method, status: "test_mode_success" });
    grantEntitlement(userId, params.p_tier, "purchase");
    return { data: null, error: null };
  }

  function rpcRedeemGiftCode(params) {
    const userId = currentUserId();
    const g = store.gift_codes.find((c) => c.code === params.p_code);
    if (!g) return { data: null, error: { message: "GIFT_CODE_NOT_FOUND" } };
    if (g.redeemed) return { data: null, error: { message: "GIFT_CODE_ALREADY_REDEEMED" } };
    if (g.sender_id === userId) return { data: null, error: { message: "GIFT_CODE_SELF_REDEEM" } };
    g.redeemed = true;
    g.redeemed_by = userId;
    grantEntitlement(userId, g.tier, "gift");
    return { data: { tier: g.tier, recipient_name: g.recipient_name }, error: null };
  }

  // Fake Supabase Edge Functions, mirroring supabase/functions/*.ts +
  // complete_razorpay_order() in sql/004_razorpay_payments.sql closely
  // enough to exercise app.js's real-payment UI wiring end to end. What
  // this deliberately does NOT do: compute or check a real HMAC signature —
  // there's no secret key on the frontend to check it with in real life
  // either, which is exactly why that verification only happens inside the
  // real verify-razorpay-payment Edge Function, not here. This suite proves
  // the UI calls the right functions with the right data and handles their
  // responses correctly; it complements, not replaces, the real signature
  // logic's own type-check and the schema-level tests in
  // nakshatra-backend/tests/.
  const TIER_PRICES_PAISE = { onetime: 39900, bundle: 59900, subscription: 29900 };

  // Same shape as generateGiftCode() in app.js (NKSH-XXXX-XXXX, no
  // ambiguous 0/O/1/I) — tests assert against that exact format, so the
  // fake needs to actually produce it rather than reusing the generic
  // uid() counter helper.
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function fakeCodeGroup() {
    let s = "";
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function fakeCreateRazorpayOrder(body) {
    const userId = currentUserId();
    if (!userId) return { data: null, error: { message: "not authenticated" } };
    const tier = body && body.tier;
    if (!TIER_PRICES_PAISE[tier]) return { data: null, error: { message: "unknown tier" } };
    const gift = body.gift;
    const orderId = uid("order");
    const amount = TIER_PRICES_PAISE[tier];
    store.razorpay_orders.push({
      order_id: orderId,
      user_id: userId,
      tier,
      amount_paise: amount,
      gift_recipient_name: gift ? gift.recipientName : null,
      gift_message: gift ? (gift.message || null) : null,
      status: "created",
    });
    return { data: { key_id: "rzp_test_fake", order_id: orderId, amount, currency: "INR" }, error: null };
  }

  function fakeVerifyRazorpayPayment(body) {
    if (forceNextRpcError) { forceNextRpcError = false; return { data: null, error: { message: "simulated failure" } }; }
    const order = store.razorpay_orders.find((o) => o.order_id === body.razorpay_order_id);
    if (!order) return { data: null, error: { message: "order not found" } };
    if (order.status === "verified") return { data: { tier: order.tier, gift_code: null }, error: null }; // idempotency (simplified vs. the real function's stored-code lookup)
    order.status = "verified";
    store.purchases.push({ id: uid("purchase"), user_id: order.user_id, tier: order.tier, amount_paise: order.amount_paise, payment_method: "card", status: "razorpay_success" });
    if (order.gift_recipient_name) {
      const code = "NKSH-" + fakeCodeGroup() + "-" + fakeCodeGroup();
      store.gift_codes.push({ code, sender_id: order.user_id, tier: order.tier, recipient_name: order.gift_recipient_name, message: order.gift_message, redeemed: false, redeemed_by: null });
      return { data: { tier: order.tier, gift_code: code }, error: null };
    }
    grantEntitlement(order.user_id, order.tier, "purchase");
    return { data: { tier: order.tier, gift_code: null }, error: null };
  }

  // Mirrors sql/003_account_deletion.sql's delete_own_account(): releases
  // gift codes this user redeemed (sent by someone else) so the fake data
  // doesn't leave a dangling reference, then removes the user and every row
  // owned by them — the same set of tables the real function's "on delete
  // cascade" foreign keys clean up when auth.users is deleted for real.
  function rpcDeleteOwnAccount() {
    const userId = currentUserId();
    if (!userId) return { data: null, error: { message: "NOT_AUTHENTICATED" } };

    store.gift_codes.forEach((g) => { if (g.redeemed_by === userId) g.redeemed_by = null; });

    store.profiles = store.profiles.filter((r) => r.id !== userId);
    store.birth_data = store.birth_data.filter((r) => r.user_id !== userId);
    store.palm_reports = store.palm_reports.filter((r) => r.user_id !== userId);
    store.purchases = store.purchases.filter((r) => r.user_id !== userId);
    store.user_entitlements = store.user_entitlements.filter((r) => r.user_id !== userId);
    store.unlocks = store.unlocks.filter((r) => r.user_id !== userId);
    store.gift_codes = store.gift_codes.filter((r) => r.sender_id !== userId);
    store.chat_messages = store.chat_messages.filter((r) => r.user_id !== userId);
    store.community_posts = store.community_posts.filter((r) => r.user_id !== userId);
    store.community_likes = store.community_likes.filter((r) => r.user_id !== userId);
    store.users = store.users.filter((r) => r.id !== userId);

    session = null; // deleting auth.users ends the session, same as it would for real
    return { data: null, error: null };
  }

  const client = {
    auth: {
      async signUp({ email, password, options }) {
        if (store.users.some((u) => u.email === email)) return { data: {}, error: { message: "User already registered" } };
        const id = uid("user");
        const name = (options && options.data && options.data.name) || email.split("@")[0];
        const user = { id, email, password, user_metadata: { name } };
        store.users.push(user);
        store.profiles.push({ id, name, email }); // simulates the handle_new_user() trigger
        session = { user: { id, email, user_metadata: { name } } };
        return { data: { user: session.user, session }, error: null };
      },
      async signInWithPassword({ email, password }) {
        const u = store.users.find((x) => x.email === email);
        if (!u || u.password !== password) return { data: {}, error: { message: "Invalid login credentials" } };
        session = { user: { id: u.id, email: u.email, user_metadata: u.user_metadata } };
        return { data: { user: session.user, session }, error: null };
      },
      async signOut() { session = null; return { error: null }; },
      async getSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user: session ? session.user : null }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      // Real Supabase never reveals whether an email is registered (security),
      // so this always "succeeds" regardless of whether store.users has a match —
      // mirrors that, and lets test-auth-recovery.js exercise the UI's sent-state
      // without needing a real inbox.
      async resetPasswordForEmail(email, opts) {
        if (forceNextRpcError) { forceNextRpcError = false; return { error: { message: "simulated failure" } }; }
        return { data: {}, error: null };
      },
      // Mirrors supabase-client.js's updatePassword(), which calls
      // supabase.auth.updateUser({password}) — only meaningful with an active
      // session (real Supabase: either an ordinary signed-in session, or the
      // temporary one a password-recovery link itself creates, which is exactly
      // what test-auth-recovery.js uses window.__fakeSupabaseSetSession to fake).
      async updateUser({ password }) {
        if (!session) return { data: { user: null }, error: { message: "Auth session missing!" } };
        const u = store.users.find((x) => x.id === session.user.id);
        if (u && password) u.password = password;
        return { data: { user: session.user }, error: null };
      },
    },
    from(table) { return new FakeBuilder(table); },
    functions: {
      async invoke(name, opts) {
        const body = (opts && opts.body) || {};
        if (name === "create-razorpay-order") return fakeCreateRazorpayOrder(body);
        if (name === "verify-razorpay-payment") return fakeVerifyRazorpayPayment(body);
        return { data: null, error: { message: "unknown function " + name } };
      },
    },
    rpc(name, params) {
      const fn = name === "record_test_purchase" ? rpcRecordTestPurchase
        : name === "redeem_gift_code" ? rpcRedeemGiftCode
        : name === "delete_own_account" ? rpcDeleteOwnAccount
        : () => ({ data: null, error: { message: "unknown rpc " + name } });
      const result = fn(params);
      return {
        maybeSingle: () => Promise.resolve(result),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
    },
  };

  window.supabase = { createClient: () => client };
})();
