// Nakshatra — create-expert-session-order
//
// Called by app/supabase-client.js's createExpertSessionOrder(), which the
// "Talk to an Expert" flow kicks off (see initExpertChat() in app/app.js —
// same trigger point as initCheckout()'s Pay button for report tiers, just
// a flat fee instead of a tier price). Asks Razorpay to create a real order
// for EXPERT_SESSION_PRICE_PAISE below, records it in razorpay_orders
// (sql/009_expert_chat.sql / sql/010_expert_customer_name.sql) with
// product='expert_session', and returns just enough for the browser to
// open Razorpay Checkout: { key_id, order_id, amount, currency }. Deliberately
// a SEPARATE function from create-razorpay-order rather than folding a
// second price into that one — keeps report-tier pricing logic and session
// pricing logic from getting entangled.
//
// Fast-fails BEFORE even creating a Razorpay order if no expert is both
// online AND free (no active session) — an expert who is online but already
// mid-session can't take a new customer, and complete_expert_session_order()
// would refund them after payment. This is a courtesy check only (see
// complete_expert_session_order() in sql/009_expert_chat.sql for the
// reasoning on why the real, race-safe enforcement has to happen at
// verification time instead, not here).
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "create-expert-session-order" -> Via Editor -> paste
// this whole file -> Deploy. Uses the same RAZORPAY_KEY_ID/
// RAZORPAY_KEY_SECRET secrets create-razorpay-order already needs, unless
// EXPERT_RAZORPAY_KEY_ID / EXPERT_RAZORPAY_KEY_SECRET are also set (both),
// in which case those win — see razorpayKeys() below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// API keys: prefer the current key system (SUPABASE_SECRET_KEYS /
// SUPABASE_PUBLISHABLE_KEYS — JSON dictionaries keyed by key name, "default"
// unless you add a dedicated key), falling back to the legacy JWT-based
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY, which Supabase keeps
// injecting unchanged. The fallback lets this deploy BEFORE the legacy keys
// are disabled and roll back cleanly if they're re-enabled; once the legacy
// keys are off, only the dictionary path is used. Names read here must
// match the dashboard's key names.
function apiKey(dictVar: string, name: string, legacyVar: string): string {
  try {
    const dict = JSON.parse(Deno.env.get(dictVar) ?? "{}");
    if (dict[name]) return dict[name];
  } catch (_) { /* malformed/missing — fall through to legacy */ }
  return Deno.env.get(legacyVar)!;
}

// Flat fee for one expert-chat session, in paise (₹1 = 100 paise).
// PLACEHOLDER — ₹199, chosen as a reasonable starting point, not a
// researched number. Update this before taking real payments; nothing else
// needs to change when you do (see the matching note in app/app.js's
// EXPERT_SESSION_PRICE constant, kept in sync manually the same way
// TIER_PRICES_PAISE and app.js's TIER_INFO already are).
const EXPERT_SESSION_PRICE_PAISE = 19900;

// Razorpay keys for the expert-chat flow. Dedicated EXPERT_RAZORPAY_KEY_ID /
// EXPERT_RAZORPAY_KEY_SECRET win when BOTH are set, so expert sessions can
// run on Razorpay TEST keys while report purchases keep using the live
// RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET; otherwise the shared pair is used.
// Always taken as a matched PAIR — never one from each — because the
// signature check in verify-expert-session-payment needs the secret that
// belongs to the key that created the order. Both expert functions must
// carry this same helper so create and verify always agree.
function razorpayKeys(): { id: string; secret: string } | null {
  const expertId = Deno.env.get("EXPERT_RAZORPAY_KEY_ID");
  const expertSecret = Deno.env.get("EXPERT_RAZORPAY_KEY_SECRET");
  if (expertId && expertSecret) return { id: expertId, secret: expertSecret };
  const id = Deno.env.get("RAZORPAY_KEY_ID");
  const secret = Deno.env.get("RAZORPAY_KEY_SECRET");
  return id && secret ? { id, secret } : null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SECRET_KEY = apiKey("SUPABASE_SECRET_KEYS", "default", "SUPABASE_SERVICE_ROLE_KEY");
    const razorpay = razorpayKeys();
    if (!razorpay) {
      console.error("Missing Razorpay secrets (EXPERT_RAZORPAY_KEY_ID/_SECRET or RAZORPAY_KEY_ID/_SECRET)");
      return json({ error: "Payments aren't configured yet." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, apiKey("SUPABASE_PUBLISHABLE_KEYS", "default", "SUPABASE_ANON_KEY"), {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Please sign in again and retry." }, 401);
    }
    const user = userData.user;

    const adminClient = createClient(SUPABASE_URL, SECRET_KEY);

    // Courtesy pre-check — see the file header. Uses the service_role
    // client (not userClient) purely so this works the same regardless of
    // whether experts_public's grant to `authenticated` is in place; the
    // real access boundary this function relies on is
    // complete_expert_session_order()'s own lock, not this check. The
    // last_seen_at staleness filter mirrors that function's own matching
    // query (014_expert_presence.sql) so a dead dashboard tab is rejected
    // here, before Razorpay checkout even opens, instead of only being
    // caught later at payment-verification time.
    const { data: onlineExperts, error: onlineErr } = await adminClient
      .from("experts")
      .select("id")
      .eq("is_online", true)
      .not("last_seen_at", "is", null)
      .gte("last_seen_at", new Date(Date.now() - 2 * 60 * 1000).toISOString());
    if (onlineErr) {
      console.error("Failed to check online experts:", onlineErr);
      return json({ error: "Something went wrong — please try again." }, 500);
    }
    const onlineIds = (onlineExperts ?? []).map((e: { id: string }) => e.id);
    if (!onlineIds.length) {
      return json({ error: "No experts online right now." }, 409);
    }
    const { data: busySessions, error: busyErr } = await adminClient
      .from("chat_sessions")
      .select("expert_id")
      .eq("status", "active")
      .in("expert_id", onlineIds);
    if (busyErr) {
      console.error("Failed to check busy experts:", busyErr);
      return json({ error: "Something went wrong — please try again." }, 500);
    }
    const busyIds = new Set((busySessions ?? []).map((s: { expert_id: string }) => s.expert_id));
    if (!onlineIds.some((id: string) => !busyIds.has(id))) {
      return json({ error: "All our experts are busy right now — please try again in a few minutes." }, 409);
    }

    const receipt = `nk_session_${user.id.slice(0, 8)}_${Date.now()}`;
    const rzpResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${razorpay.id}:${razorpay.secret}`),
      },
      body: JSON.stringify({
        amount: EXPERT_SESSION_PRICE_PAISE,
        currency: "INR",
        receipt,
        notes: { user_id: user.id, product: "expert_session" },
      }),
    });
    if (!rzpResp.ok) {
      const detail = await rzpResp.text().catch(() => "");
      console.error("Razorpay order creation failed:", rzpResp.status, detail);
      return json({ error: "Couldn't start the payment — please try again." }, 502);
    }
    const order = await rzpResp.json();

    const { error: insertErr } = await adminClient.from("razorpay_orders").insert({
      order_id: order.id,
      user_id: user.id,
      product: "expert_session",
      tier: null,
      amount_paise: EXPERT_SESSION_PRICE_PAISE,
      status: "created",
    });
    if (insertErr) {
      console.error("Failed to record razorpay_orders row:", insertErr);
      return json({ error: "Couldn't start the payment — please try again." }, 500);
    }

    return json({
      key_id: razorpay.id,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("create-expert-session-order error:", err);
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
