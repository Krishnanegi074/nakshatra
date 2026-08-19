// ============================================================================
// Nakshatra — Supabase data-access layer.
//
// Every screen in app.js should go through the `db` object below rather than
// touching the `supabase` client directly. That keeps every table/column/RPC
// name in exactly one place (matching sql/002_schema.sql), and it means this
// whole layer can be swapped for a mock in tests (see tests/test-data-layer.js)
// without touching UI code at all.
//
// SETUP (do this before this file will do anything):
//   1. Create a free project at supabase.com (~2 minutes).
//   2. Paste sql/002_schema.sql into that project's SQL Editor and run it.
//   3. Project Settings -> API -> copy the "Project URL" and the "anon
//      public" key, and paste them into SUPABASE_URL / SUPABASE_ANON_KEY
//      below. The anon key is safe to ship in client-side code — it has no
//      power beyond what the Row Level Security policies in that SQL file
//      allow. Never put the "service_role" key here or anywhere client-side.
//
// Every function below returns { data, error } (never throws for expected
// failures — e.g. wrong password, code already redeemed), mirroring
// supabase-js's own convention so call sites can handle both uniformly.
// ============================================================================
(function (global) {
  "use strict";

  const SUPABASE_URL = "https://xinelwrxgveztrtokwbt.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_TCpwYsH_r77QM7kRkdBLrw_BPW26GHs";

  // Allows tests to inject a fake client instead of the real supabase-js one.
  function createDb(client) {
    const supabase = client;

    async function currentUserId() {
      const { data } = await supabase.auth.getUser();
      return data && data.user ? data.user.id : null;
    }

    return {
      // ==================== AUTH ====================
      async signUp(email, password, name) {
        return supabase.auth.signUp({
          email,
          password,
          options: { data: { name } }, // -> raw_user_meta_data, read by handle_new_user()
        });
      },

      async signIn(email, password) {
        return supabase.auth.signInWithPassword({ email, password });
      },

      async signOut() {
        return supabase.auth.signOut();
      },

      // Returns the persisted session (if any) — call on page load to
      // silently resume a signed-in user instead of showing the login screen.
      async getSession() {
        return supabase.auth.getSession();
      },

      // cb(event, session) — fires on sign-in, sign-out, and token refresh.
      onAuthStateChange(cb) {
        return supabase.auth.onAuthStateChange(cb);
      },

      // ==================== PROFILE ====================
      async loadProfile() {
        const uid = await currentUserId();
        if (!uid) return { data: null, error: null };
        return supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
      },

      // ==================== BIRTH DATA ====================
      // `fields` matches birth_data's columns 1:1 (year, month, day, hour,
      // minute, unknown_time, city_name, city_country, city_lat, city_lon,
      // city_utc, sun_idx, moon_idx, asc_idx, moon_phase). user_id is
      // populated automatically by the column default (auth.uid()).
      async saveBirthData(fields) {
        return supabase.from("birth_data").upsert(fields, { onConflict: "user_id" });
      },

      async loadBirthData() {
        const uid = await currentUserId();
        if (!uid) return { data: null, error: null };
        return supabase.from("birth_data").select("*").eq("user_id", uid).maybeSingle();
      },

      // ==================== PALM REPORTS ====================
      async savePalmReport(answers, report) {
        return supabase.from("palm_reports").upsert({ answers, report }, { onConflict: "user_id" });
      },

      async loadPalmReport() {
        const uid = await currentUserId();
        if (!uid) return { data: null, error: null };
        return supabase.from("palm_reports").select("*").eq("user_id", uid).maybeSingle();
      },

      // ==================== PURCHASES / UNLOCKS ====================
      // TEST MODE ONLY — see the note above record_test_purchase() in
      // sql/002_schema.sql before this is ever wired to a real payment
      // gateway. amountPaise is an integer (₹1 = 100 paise).
      async recordTestPurchase(tier, amountPaise, paymentMethod) {
        return supabase.rpc("record_test_purchase", {
          p_tier: tier,
          p_amount_paise: amountPaise,
          p_payment_method: paymentMethod,
        });
      },

      async loadUnlockStatus() {
        const uid = await currentUserId();
        if (!uid) return { data: null, error: null };
        return supabase.from("unlocks").select("*").eq("user_id", uid).maybeSingle();
      },

      // ==================== GIFTING ====================
      async sendGift(code, tier, recipientName, message) {
        return supabase.from("gift_codes").insert({ code, tier, recipient_name: recipientName, message });
      },

      async loadSentGift(code) {
        return supabase.from("gift_codes").select("*").eq("code", code).maybeSingle();
      },

      // Throws-as-error (in the returned `error`) with one of:
      // GIFT_CODE_NOT_FOUND / GIFT_CODE_ALREADY_REDEEMED / GIFT_CODE_SELF_REDEEM
      async redeemGiftCode(code) {
        return supabase.rpc("redeem_gift_code", { p_code: code }).maybeSingle();
      },

      // ==================== CHAT ====================
      async loadChatMessages(astrologerId) {
        return supabase
          .from("chat_messages")
          .select("*")
          .eq("astrologer_id", astrologerId)
          .order("created_at", { ascending: true });
      },

      async sendChatMessage(astrologerId, sender, text) {
        return supabase.from("chat_messages").insert({ astrologer_id: astrologerId, sender, text });
      },

      // ==================== COMMUNITY ====================
      async loadCommunityFeed() {
        return supabase.from("community_feed").select("*").order("created_at", { ascending: false });
      },

      async postToCommunity(fields) {
        // fields: { name, avatar, sign_idx, caption, image_url }
        return supabase.from("community_posts").insert(fields).select().single();
      },

      async likePost(postId) {
        return supabase.from("community_likes").insert({ post_id: postId });
      },

      async unlikePost(postId) {
        const uid = await currentUserId();
        return supabase.from("community_likes").delete().eq("post_id", postId).eq("user_id", uid);
      },

      // ==================== ACCOUNT DELETION ====================
      // Permanently deletes the calling user's auth account and — via the
      // "on delete cascade" foreign keys already defined in sql/002_schema.sql —
      // every row of theirs across every table. See sql/003_account_deletion.sql
      // for the server-side function this calls. Irreversible.
      async deleteAccount() {
        return supabase.rpc("delete_own_account");
      },
    };
  }

  const realClient =
    global.supabase && typeof global.supabase.createClient === "function"
      ? global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;

  global.NakshatraDB = {
    createDb, // exported so tests can build a db instance around a fake client
    db: realClient ? createDb(realClient) : null,
    client: realClient,
  };

  // CommonJS export so tests/test-data-layer.js can `require()` this file in
  // Node without a browser `<script>` tag or a real supabase-js client.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createDb };
  }
})(typeof window !== "undefined" ? window : global);
