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

      // Sends a "reset your password" email via Supabase's own mailer — the
      // link inside it lands back on this same page with a recovery token,
      // which app.js's initAuth() detects and routes to screen-reset-password.
      async resetPasswordForEmail(email) {
        return supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname,
        });
      },

      // Only valid while signed into a password-recovery session (i.e. right
      // after following the emailed reset link) — see resetPasswordForEmail above.
      async updatePassword(newPassword) {
        return supabase.auth.updateUser({ password: newPassword });
      },

      // Redirects the browser to Google and back — resolves with an error
      // only on a synchronous failure (e.g. Google isn't enabled as a
      // provider in this Supabase project yet); on success there's no
      // meaningful return value because the page navigates away.
      async signInWithGoogle() {
        return supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin + window.location.pathname },
        });
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
      // city_utc, city_tz, sun_idx, moon_idx, asc_idx, moon_phase). user_id is
      // populated automatically by the column default (auth.uid()).
      // city_tz is the IANA timezone identifier (see 006_city_timezone.sql) —
      // city_utc is kept only as a legacy fixed-offset fallback.
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
      // TEST MODE ONLY — kept around in case it's ever useful again, but the
      // app itself no longer calls this. Real purchases go through
      // createRazorpayOrder + verifyRazorpayPayment below.
      async recordTestPurchase(tier, amountPaise, paymentMethod) {
        return supabase.rpc("record_test_purchase", {
          p_tier: tier,
          p_amount_paise: amountPaise,
          p_payment_method: paymentMethod,
        });
      },

      // Replaces loadUnlockStatus()/public.unlocks (a single boolean + single
      // `tier` column, silently OVERWRITTEN by every new purchase — see
      // sql/005_tier_entitlements.sql's header for the full story). Returns
      // an ARRAY (not .maybeSingle()) since a user can now hold up to three
      // rows — one per tier they've purchased or been gifted — and owning a
      // second tier no longer erases the first.
      async loadEntitlements() {
        const uid = await currentUserId();
        if (!uid) return { data: [], error: null };
        return supabase.from("user_entitlements").select("tier, source, granted_at").eq("user_id", uid);
      },

      // ==================== REAL PAYMENTS (Razorpay) ====================
      // Both of these call Supabase Edge Functions (sql/004_razorpay_payments.sql
      // + supabase/functions/*) rather than touching any table directly —
      // the server looks up the real price and re-verifies everything with
      // Razorpay itself, so nothing here can be spoofed from the browser.
      //
      // gift is optional: { recipientName, message } — pass it to buy the
      // report as a gift for someone else instead of unlocking it for
      // yourself; the server-side function returns the redeemable code.
      async createRazorpayOrder(tier, gift) {
        return supabase.functions.invoke("create-razorpay-order", {
          body: gift ? { tier, gift } : { tier },
        });
      },

      // razorpayResponse is the object Razorpay Checkout's handler callback
      // hands you: { razorpay_order_id, razorpay_payment_id, razorpay_signature }.
      async verifyRazorpayPayment(razorpayResponse) {
        return supabase.functions.invoke("verify-razorpay-payment", {
          body: razorpayResponse,
        });
      },

      // ==================== GIFTING ====================
      // NOTE: sending a gift is a real purchase now — see createRazorpayOrder
      // above with a `gift` argument. This direct insert is left here only
      // for local/offline testing; sql/004_razorpay_payments.sql removes the
      // RLS policy that let it succeed against the real database, since a
      // gift code must now always be backed by a verified payment.
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
