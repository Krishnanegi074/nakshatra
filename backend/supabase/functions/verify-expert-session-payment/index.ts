// Nakshatra — verify-expert-session-payment
//
// Called by app/supabase-client.js's verifyExpertSessionPayment(razorpayResponse)
// right after Razorpay Checkout's handler callback fires for a "Talk to an
// Expert" payment — same shape and same independent verification approach
// as verify-razorpay-payment (recompute the HMAC signature server-side,
// confirm the payment is actually captured via Razorpay's own API, only
// THEN credit anything) — see that file for the full reasoning, not
// repeated here. The one thing genuinely new to this function: calling
// complete_expert_session_order() can fail with NO_EXPERT_AVAILABLE even
// though the payment itself already succeeded (every online expert got
// claimed by someone else in the gap between this order being created and
// payment clearing, or nobody stayed online that long) — see
// sql/009_expert_chat.sql's comment on that exact error for why. Real
// money was captured for nothing in that case, so this function's job
// isn't done until it's refunded via Razorpay's Refunds API and the
// customer is told plainly what happened. No "retry against a different
// expert" step: complete_expert_session_order()'s own matching loop
// already tries every currently-online expert before raising that error,
// so there is no other expert left to retry against by the time this
// function sees it.
//
// Returns { session_id, expert_name, expert_specialty } on success, or an
// error the client can show as-is.
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "verify-expert-session-payment" -> Via Editor -> paste
// this whole file -> Deploy. Uses the same RAZORPAY_KEY_ID/
// RAZORPAY_KEY_SECRET secrets the other payment functions already need,
// unless EXPERT_RAZORPAY_KEY_ID / EXPERT_RAZORPAY_KEY_SECRET are also set
// (both), in which case those win — see razorpayKeys() below. This MUST
// resolve to the same pair as create-expert-session-order, or the payment
// signature check will fail.

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

// Same reasoning as verify-razorpay-payment's identical helper.
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

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Full refund of a captured payment — used only for the NO_EXPERT_AVAILABLE
// path below. Logs and swallows its own failure rather than throwing:
// by the time this is called, the customer-facing response is already
// going to explain no expert was available, and a failed refund attempt on
// top of that is a support/ops problem (retry manually from the Razorpay
// dashboard), not something a second error message to the browser fixes.
async function refundPayment(paymentId: string, keyId: string, keySecret: string): Promise<boolean> {
  const resp = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${keyId}:${keySecret}`),
    },
    body: JSON.stringify({}), // no `amount` = full refund
  });
  if (!resp.ok) {
    console.error("Refund failed:", resp.status, await resp.text().catch(() => ""));
    return false;
  }
  return true;
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

    const body = await req.json().catch(() => ({}));
    const orderId = body?.razorpay_order_id;
    const paymentId = body?.razorpay_payment_id;
    const signature = body?.razorpay_signature;
    if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string") {
      return json({ error: "Malformed payment response." }, 400);
    }

    const expected = await hmacHex(razorpay.secret, `${orderId}|${paymentId}`);
    if (!safeEqual(expected, signature)) {
      return json({ error: "Payment verification failed." }, 400);
    }

    const adminClient = createClient(SUPABASE_URL, SECRET_KEY);

    const { data: orderRow, error: orderLookupErr } = await adminClient
      .from("razorpay_orders")
      .select("user_id, product")
      .eq("order_id", orderId)
      .maybeSingle();
    if (orderLookupErr || !orderRow) {
      return json({ error: "Order not found." }, 404);
    }
    if (orderRow.user_id !== user.id) {
      return json({ error: "This order doesn't belong to you." }, 403);
    }
    if (orderRow.product !== "expert_session") {
      // Wrong endpoint for this order — a report-tier order should go
      // through verify-razorpay-payment instead. Shouldn't happen from the
      // real client (app.js calls the matching endpoint for each flow),
      // only from a malformed/manual request.
      return json({ error: "This order isn't for an expert session." }, 400);
    }

    const payResp = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: "Basic " + btoa(`${razorpay.id}:${razorpay.secret}`) },
    });
    if (!payResp.ok) {
      console.error("Razorpay payment lookup failed:", payResp.status, await payResp.text().catch(() => ""));
      return json({ error: "Couldn't confirm the payment — please contact support." }, 502);
    }
    const payment = await payResp.json();
    if (payment.status !== "captured") {
      return json({ error: `Payment not completed (status: ${payment.status}).` }, 402);
    }

    const { data: result, error: completeErr } = await adminClient.rpc("complete_expert_session_order", {
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_payment_method: payment.method ?? "card",
    });

    if (completeErr) {
      // NO_EXPERT_AVAILABLE is the one failure mode expected to happen in
      // normal operation (see the file header) — refund and say so
      // plainly. Anything else (ORDER_NOT_FOUND, WRONG_ORDER_TYPE, or a
      // genuine unexpected error) is a real bug or a malformed request, not
      // a "someone went offline" race, so it gets the generic error path
      // instead — refunding on every unexpected error would risk refunding
      // a payment that's actually fine and just hit an unrelated problem
      // recording it.
      if (String(completeErr.message || "").includes("NO_EXPERT_AVAILABLE")) {
        const refunded = await refundPayment(paymentId, razorpay.id, razorpay.secret);
        return json({
          error: refunded
            ? "No experts are available right now — you have not been charged."
            : "No experts are available right now. Your refund is being processed — contact support if you don't see it within a few days.",
        }, 409);
      }
      console.error("complete_expert_session_order failed:", completeErr);
      return json({ error: "Payment succeeded but couldn't be recorded — please contact support." }, 500);
    }
    if (!result || !result[0]) {
      console.error("complete_expert_session_order returned no row");
      return json({ error: "Payment succeeded but couldn't be recorded — please contact support." }, 500);
    }

    const { session_id, expert_name, expert_specialty } = result[0];
    return json({ session_id, expert_name, expert_specialty });
  } catch (err) {
    console.error("verify-expert-session-payment error:", err);
    return json({ error: "Something went wrong — please contact support." }, 500);
  }
});
