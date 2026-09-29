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
// Fast-fails BEFORE even creating a Razorpay order if nobody is online —
// this is a courtesy check only (see complete_expert_session_order() in
// sql/009_expert_chat.sql for the reasoning on why the real, race-safe
// enforcement has to happen at verification time instead, not here).
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "create-expert-session-order" -> Via Editor -> paste
// this whole file -> Deploy. Uses the same RAZORPAY_KEY_ID/
// RAZORPAY_KEY_SECRET secrets create-razorpay-order already needs — nothing
// new to add if that one's already deployed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Flat fee for one expert-chat session, in paise (₹1 = 100 paise).
// PLACEHOLDER — ₹199, chosen as a reasonable starting point, not a
// researched number. Update this before taking real payments; nothing else
// needs to change when you do (see the matching note in app/app.js's
// EXPERT_SESSION_PRICE constant, kept in sync manually the same way
// TIER_PRICES_PAISE and app.js's TIER_INFO already are).
const EXPERT_SESSION_PRICE_PAISE = 19900;

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
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
    const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      console.error("Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET secrets");
      return json({ error: "Payments aren't configured yet." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Please sign in again and retry." }, 401);
    }
    const user = userData.user;

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Courtesy pre-check — see the file header. Uses the service_role
    // client (not userClient) purely so this works the same regardless of
    // whether experts_public's grant to `authenticated` is in place; the
    // real access boundary this function relies on is
    // complete_expert_session_order()'s own lock, not this check.
    const { count: onlineCount, error: onlineErr } = await adminClient
      .from("experts")
      .select("id", { count: "exact", head: true })
      .eq("is_online", true);
    if (onlineErr) {
      console.error("Failed to check online experts:", onlineErr);
      return json({ error: "Something went wrong — please try again." }, 500);
    }
    if (!onlineCount) {
      return json({ error: "No experts online right now." }, 409);
    }

    const receipt = `nk_session_${user.id.slice(0, 8)}_${Date.now()}`;
    const rzpResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
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
      key_id: RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("create-expert-session-order error:", err);
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
