// Nakshatra — create-razorpay-order
//
// Called by app/supabase-client.js's createRazorpayOrder(tier, gift), which
// the checkout screen's Pay button kicks off (see initCheckout() in
// app/app.js). Takes { tier, gift?: { recipientName, message } }, asks
// Razorpay to create a real order for that tier's REAL price (never a price
// the browser sends), records it in razorpay_orders
// (sql/004_razorpay_payments.sql), and returns just enough for the browser
// to open Razorpay Checkout: { key_id, order_id, amount, currency }.
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "create-razorpay-order" -> Via Editor -> paste this
// whole file -> Deploy. Then Edge Functions -> Manage secrets, add
// RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (from your Razorpay dashboard ->
// Settings -> API Keys). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// already available to every Edge Function automatically — nothing to add
// for those.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Real prices, in paise (₹1 = 100 paise). Deliberately hard-coded here
// rather than trusting anything the browser sends — this is the one place
// that decides what a tier actually costs. Keep this in sync with
// TIER_INFO in app/app.js if the prices ever change there.
const TIER_PRICES_PAISE: Record<string, number> = {
  onetime: 39900,   // ₹399
  bundle: 59900,    // ₹599
  subscription: 29900, // ₹299 (one-time unlock for now — see README/SETUP.md)
};

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

    // Identify the caller from their own JWT (forwarded automatically by
    // supabase.functions.invoke) — this is who the order, and any resulting
    // purchase/unlock, belongs to. Never take a user id from the request body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Please sign in again and retry." }, 401);
    }
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const tier = body?.tier;
    const gift = body?.gift; // optional { recipientName, message }

    if (typeof tier !== "string" || !(tier in TIER_PRICES_PAISE)) {
      return json({ error: "Unknown tier." }, 400);
    }
    if (gift !== undefined && (typeof gift !== "object" || !gift || typeof gift.recipientName !== "string" || !gift.recipientName.trim())) {
      return json({ error: "A gift needs a recipient name." }, 400);
    }

    const amountPaise = TIER_PRICES_PAISE[tier];

    // Razorpay Orders API — https://api.razorpay.com/v1/orders. `receipt`
    // just needs to be short and unique-ish for our own records; Razorpay
    // doesn't parse it.
    const receipt = `nk_${user.id.slice(0, 8)}_${Date.now()}`;
    const rzpResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes: { user_id: user.id, tier, gift: gift ? "true" : "false" },
      }),
    });

    if (!rzpResp.ok) {
      const detail = await rzpResp.text().catch(() => "");
      console.error("Razorpay order creation failed:", rzpResp.status, detail);
      return json({ error: "Couldn't start the payment — please try again." }, 502);
    }
    const order = await rzpResp.json();

    // Record the pending order with the service_role client — bypasses RLS
    // by design (see the comment on razorpay_orders in
    // sql/004_razorpay_payments.sql); this table has no client-facing
    // grants at all.
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: insertErr } = await adminClient.from("razorpay_orders").insert({
      order_id: order.id,
      user_id: user.id,
      tier,
      amount_paise: amountPaise,
      gift_recipient_name: gift ? gift.recipientName : null,
      gift_message: gift ? (gift.message ?? null) : null,
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
    console.error("create-razorpay-order error:", err);
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
