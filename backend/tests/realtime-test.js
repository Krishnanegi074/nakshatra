#!/usr/bin/env node
// Nakshatra — live Realtime delivery test for chat_messages_session_participants
// (backend/sql/009_expert_chat.sql). NOT part of the app — a standalone,
// one-off diagnostic against a REAL Supabase project: real Auth, real
// Postgres, real Realtime service. This is the one thing SETUP.md flagged
// as unverifiable from a local-only environment.
//
// What it does, in order:
//   1. Looks up the real expert account (EXPERT_EMAIL) + its
//      public.experts row (created manually beforehand — see the chat
//      this script came from).
//   2. Creates two THROWAWAY auth accounts: a test customer and an
//      unrelated "outsider" (neither is the real expert or any real
//      customer).
//   3. Seeds one real chat_sessions row linking the expert and the test
//      customer — inserted directly via service_role (bypassing RLS,
//      which has no insert policy for chat_sessions at all — same as
//      complete_expert_session_order() would do, without needing a real
//      Razorpay payment for what's purely a Realtime test).
//   4. Signs in as all three via REAL PASSWORD AUTH with the ANON key —
//      not service_role — so this genuinely exercises RLS the way a real
//      user's session would, not a privileged bypass.
//   5. Each joins the private Broadcast topic session:<id> (011_chat_broadcast.sql). The expert sends a message; the customer's and
//      outsider's subscriptions are both checked. Then the reverse: the
//      customer sends; the expert's subscription is checked.
//   6. Cleans up everything it created (messages, session, the two
//      throwaway accounts) in a `finally` block — runs on failure too.
//
// Needs three things in the environment — SUPABASE_URL and
// SUPABASE_ANON_KEY default to the same public values already baked into
// app/supabase-client.js (not secrets), but SUPABASE_SERVICE_ROLE_KEY and
// EXPERT_PASSWORD must be set explicitly:
//
//   SUPABASE_SERVICE_ROLE_KEY=... EXPERT_PASSWORD=... node realtime-test.js
//
// SUPABASE_SERVICE_ROLE_KEY is from Project Settings -> API -> service_role
// — a SECRET with full, RLS-bypassing access to your whole database. This
// script only ever uses it for the two setup/cleanup steps explicitly
// marked below, never for the actual subscribe/send/receive test itself.

const { createClient } = require("@supabase/supabase-js");
const { requireProductionConfirmation } = require("./production-gate");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xinelwrxgveztrtokwbt.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_TCpwYsH_r77QM7kRkdBLrw_BPW26GHs";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPERT_EMAIL = process.env.EXPERT_EMAIL;   // kept out of the repo: it lives in ~/.nakshatra-realtime-test.env
const EXPERT_PASSWORD = process.env.EXPERT_PASSWORD;

requireProductionConfirmation({ script: "realtime-test.js", url: SUPABASE_URL, willDo: "create two throwaway accounts and one chat session, exchange test messages, then delete them (and sign in as the expert account)." });
if (!SERVICE_ROLE_KEY) { console.error("Set SUPABASE_SERVICE_ROLE_KEY (Project Settings -> API -> service_role)."); process.exit(1); }
if (!EXPERT_EMAIL) { console.error("Set EXPERT_EMAIL to the expert account's login email (it is in ~/.nakshatra-realtime-test.env: `source` that file first)."); process.exit(1); }
if (!EXPERT_PASSWORD) { console.error("Set EXPERT_PASSWORD to whatever you set when creating the expert account (it is in ~/.nakshatra-realtime-test.env)."); process.exit(1); }

const rand = () => Math.random().toString(36).slice(2, 10);
const CUSTOMER_EMAIL = `nakshatra-realtime-test-customer-${rand()}@example.com`;
const OUTSIDER_EMAIL = `nakshatra-realtime-test-outsider-${rand()}@example.com`;
const TEST_PASSWORD = "Test" + rand() + "!9Aa";

// service_role client — setup/cleanup only, never the test itself.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function check(label, cond) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

// Waits for a channel's .subscribe() to actually reach SUBSCRIBED (or
// errors out) — more reliable than guessing with a fixed sleep, and a
// failure here is itself diagnostic (e.g. Realtime rejecting the
// subscription outright, not just "no message arrived later").
function waitForSubscribed(channel, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out waiting for SUBSCRIBED`)), timeoutMs);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        reject(new Error(`${label}: subscription status=${status}${err ? " (" + err.message + ")" : ""}`));
      }
    });
  });
}

function waitFor(getValue, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = getValue();
      if (v || Date.now() - start > timeoutMs) { clearInterval(iv); resolve(v || null); }
    }, 200);
  });
}

let createdUserIds = [];
let createdSessionId = null;
let channels = [];

async function cleanup() {
  console.log("\n== Cleanup ==");
  for (const ch of channels) { try { await ch.client.removeChannel(ch.channel); } catch (_) {} }
  if (createdSessionId) {
    await admin.from("chat_messages").delete().eq("session_id", createdSessionId);
    await admin.from("chat_sessions").delete().eq("id", createdSessionId);
    console.log("Deleted test chat_sessions row and its messages:", createdSessionId);
  }
  for (const id of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    console.log(error ? `Failed to delete throwaway user ${id}: ${error.message}` : `Deleted throwaway user ${id}`);
  }
}

(async () => {
  try {
    console.log("== Looking up the expert account ==");
    let expertUser = null;
    // listUsers() is paginated (50/page by default) — walk pages rather
    // than assuming the account is on the first one.
    for (let page = 1; page <= 20 && !expertUser; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      expertUser = data.users.find(u => u.email === EXPERT_EMAIL);
      if (data.users.length < 200) break;
    }
    if (!expertUser) throw new Error(`No auth user found for ${EXPERT_EMAIL} — create it in the dashboard first (see the walkthrough).`);
    console.log("Expert auth id:", expertUser.id);

    const { data: expertRow, error: expertRowErr } = await admin.from("experts").select("*").eq("id", expertUser.id).maybeSingle();
    if (expertRowErr) throw expertRowErr;
    if (!expertRow) throw new Error(`auth.users row exists for ${EXPERT_EMAIL} but there's no matching public.experts row yet — run the INSERT from the walkthrough first.`);
    console.log("Expert row:", expertRow);

    console.log("\n== Creating throwaway test customer + outsider accounts ==");
    const { data: customerCreate, error: custErr } = await admin.auth.admin.createUser({ email: CUSTOMER_EMAIL, password: TEST_PASSWORD, email_confirm: true });
    if (custErr) throw custErr;
    createdUserIds.push(customerCreate.user.id);
    console.log("Customer:", CUSTOMER_EMAIL, customerCreate.user.id);

    const { data: outsiderCreate, error: outErr } = await admin.auth.admin.createUser({ email: OUTSIDER_EMAIL, password: TEST_PASSWORD, email_confirm: true });
    if (outErr) throw outErr;
    createdUserIds.push(outsiderCreate.user.id);
    console.log("Outsider:", OUTSIDER_EMAIL, outsiderCreate.user.id);

    console.log("\n== Seeding a throwaway chat_sessions row (service_role — bypasses RLS the same way complete_expert_session_order() would, without a real payment) ==");
    const { data: sessionRow, error: sessionErr } = await admin.from("chat_sessions").insert({
      user_id: customerCreate.user.id,
      expert_id: expertUser.id,
      amount_paise: 100,
    }).select().single();
    if (sessionErr) throw sessionErr;
    createdSessionId = sessionRow.id;
    console.log("Session id:", createdSessionId);

    console.log("\n== Signing in as expert, customer, and outsider (real password auth, anon key — NOT service_role) ==");
    const expertClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: expertSignInErr } = await expertClient.auth.signInWithPassword({ email: EXPERT_EMAIL, password: EXPERT_PASSWORD });
    if (expertSignInErr) throw new Error("Expert sign-in failed: " + expertSignInErr.message + " (check EXPERT_PASSWORD)");

    const customerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: custSignInErr } = await customerClient.auth.signInWithPassword({ email: CUSTOMER_EMAIL, password: TEST_PASSWORD });
    if (custSignInErr) throw custSignInErr;

    const outsiderClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: outSignInErr } = await outsiderClient.auth.signInWithPassword({ email: OUTSIDER_EMAIL, password: TEST_PASSWORD });
    if (outSignInErr) throw outSignInErr;
    console.log("All three signed in.");

    console.log("\n== Subscribing all three to this session's chat_messages ==");
    let customerReceived = null, outsiderReceived = null, expertReceived = null;

    // Private channels need the JWT on the Realtime socket before joining.
    await expertClient.realtime.setAuth();
    await customerClient.realtime.setAuth();
    await outsiderClient.realtime.setAuth();

    const customerChannel = customerClient.channel("session:" + createdSessionId, { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, (m) => { customerReceived = m.payload.record; });
    const outsiderChannel = outsiderClient.channel("session:" + createdSessionId, { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, (m) => { outsiderReceived = m.payload.record; });
    const expertChannel = expertClient.channel("session:" + createdSessionId, { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, (m) => { expertReceived = m.payload.record; });

    await waitForSubscribed(customerChannel, "customer subscription");
    channels.push({ client: customerClient, channel: customerChannel });
    // With private Broadcast channels, an unauthorized join is REJECTED
    // (realtime.messages RLS) rather than joined-but-silent — so a
    // rejection here is the PASS condition for the outsider.
    let outsiderJoinRejected = false;
    try { await waitForSubscribed(outsiderChannel, "outsider subscription"); }
    catch (e) { outsiderJoinRejected = true; console.log("  outsider join rejected (expected):", e.message); }
    channels.push({ client: outsiderClient, channel: outsiderChannel });
    await waitForSubscribed(expertChannel, "expert subscription");
    channels.push({ client: expertClient, channel: expertChannel });
    check("Customer and expert subscriptions reached SUBSCRIBED", true);
    check("Outsider's join to the private topic was rejected by realtime.messages RLS", outsiderJoinRejected);

    console.log("\n== Expert sends a message ==");
    const expertMsgText = "realtime-test-from-expert-" + rand();
    const { error: expertSendErr } = await expertClient.from("chat_messages").insert({
      user_id: customerCreate.user.id, // "whose conversation" — always the customer, matching expert/index.html's own sendReply()
      session_id: createdSessionId,
      sender: "astro",
      text: expertMsgText,
    });
    check("Expert's insert succeeds under RLS (chat_messages_session_participants' WITH CHECK)", !expertSendErr);
    if (expertSendErr) console.error("  ->", expertSendErr.message);

    await waitFor(() => customerReceived, 8000);
    check("Customer's subscription received the expert's message live", customerReceived && customerReceived.text === expertMsgText);
    await waitFor(() => outsiderReceived, 3000); // shorter — we're confirming absence, not racing a slow delivery
    check("Outsider's subscription received NOTHING for the expert's message (not part of this session)", !outsiderReceived);

    console.log("\n== Customer sends a message (reverse direction) ==");
    const customerMsgText = "realtime-test-from-customer-" + rand();
    // user_id deliberately omitted — defaults to auth.uid() (the column's
    // own default), matching app.js's sendSessionMessage() exactly.
    const { error: custSendErr } = await customerClient.from("chat_messages").insert({
      session_id: createdSessionId,
      sender: "user",
      text: customerMsgText,
    });
    check("Customer's insert succeeds under RLS", !custSendErr);
    if (custSendErr) console.error("  ->", custSendErr.message);

    await waitFor(() => expertReceived, 8000);
    check("Expert's subscription received the customer's message live", expertReceived && expertReceived.text === customerMsgText);
    await waitFor(() => outsiderReceived, 3000);
    check("Outsider's subscription STILL received nothing (checked again after the second message)", !outsiderReceived);

  } catch (err) {
    console.error("\nFATAL:", err.message);
    results.push({ label: "script completed without a fatal error", pass: false });
  } finally {
    await cleanup();
  }

  console.log(`\n=== RESULT: ${results.filter(r => r.pass).length} / ${results.length} checks passed ===`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) { console.log("FAILED:", failed.map(f => f.label)); process.exit(1); }
  process.exit(0);
})();
