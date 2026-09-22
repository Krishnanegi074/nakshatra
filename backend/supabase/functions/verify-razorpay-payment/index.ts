// Nakshatra — verify-razorpay-payment
//
// Called by app/supabase-client.js's verifyRazorpayPayment(razorpayResponse)
// right after Razorpay Checkout's handler callback fires (see initCheckout()
// in app/app.js) — razorpayResponse is exactly
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }, forwarded
// untouched. This is the ONLY place that's allowed to decide a payment
// really happened: it independently recomputes Razorpay's HMAC signature
// with the account's secret key (which the browser never has), double-checks
// the payment is actually captured via Razorpay's own API, and only then
// calls complete_razorpay_order() (sql/004_razorpay_payments.sql) to credit
// the purchase. Returns { tier, gift_code } — gift_code is null for a
// self-purchase, and a redeemable NKSH-XXXX-XXXX code for a gift.
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "verify-razorpay-payment" -> Via Editor -> paste this
// whole file -> Deploy. Needs the same RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET
// secrets as create-razorpay-order (add them once under Edge Functions ->
// Manage secrets — shared by every function in the project).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Plain === on hex strings still leaks timing in theory; this at least
// avoids a fast-fail on the first mismatched character on a per-loop basis
// the way naive index comparisons would optimize to. Good enough alongside
// the follow-up API check below, which is what actually confirms the charge.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

    const body = await req.json().catch(() => ({}));
    const orderId = body?.razorpay_order_id;
    const paymentId = body?.razorpay_payment_id;
    const signature = body?.razorpay_signature;
    if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string") {
      return json({ error: "Malformed payment response." }, 400);
    }

    // The one check that actually proves Razorpay produced this
    // (order_id, payment_id) pairing: recompute the same HMAC they did,
    // using the secret key only this server has.
    const expected = await hmacHex(RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
    if (!safeEqual(expected, signature)) {
      return json({ error: "Payment verification failed." }, 400);
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Make sure this order actually belongs to whoever is asking — a valid
    // signature proves Razorpay signed this pairing, but without this check
    // any signed-in user who somehow learned someone else's order_id and
    // payment_id could try to claim it as their own.
    const { data: orderRow, error: orderLookupErr } = await adminClient
      .from("razorpay_orders")
      .select("user_id")
      .eq("order_id", orderId)
      .maybeSingle();
    if (orderLookupErr || !orderRow) {
      return json({ error: "Order not found." }, 404);
    }
    if (orderRow.user_id !== user.id) {
      return json({ error: "This order doesn't belong to you." }, 403);
    }

    // Defense in depth beyond the signature: ask Razorpay directly whether
    // this payment is actually captured before crediting anything.
    const payResp = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`) },
    });
    if (!payResp.ok) {
      console.error("Razorpay payment lookup failed:", payResp.status, await payResp.text().catch(() => ""));
      return json({ error: "Couldn't confirm the payment — please contact support." }, 502);
    }
    const payment = await payResp.json();
    if (payment.status !== "captured") {
      return json({ error: `Payment not completed (status: ${payment.status}).` }, 402);
    }

    const { data: result, error: completeErr } = await adminClient.rpc("complete_razorpay_order", {
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_payment_method: payment.method ?? "card",
    });
    if (completeErr || !result || !result[0]) {
      console.error("complete_razorpay_order failed:", completeErr);
      return json({ error: "Payment succeeded but couldn't be recorded — please contact support." }, 500);
    }

    const { tier, gift_code } = result[0];
    return json({ tier, gift_code: gift_code ?? null });
  } catch (err) {
    console.error("verify-razorpay-payment error:", err);
    return json({ error: "Something went wrong — please contact support." }, 500);
  }
});
