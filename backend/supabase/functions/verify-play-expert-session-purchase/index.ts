// Nakshatra — verify-play-expert-session-purchase
//
// The Android app's twin of verify-expert-session-payment, called by
// app/supabase-client.js's verifyPlayExpertSessionPurchase(purchaseToken)
// right after the @capawesome-team/capacitor-purchases plugin resolves an
// "expert_session" purchase (see initExpertChat()'s native branch in
// app/app.js). Same independent-verification shape as
// verify-play-report-purchase (mint a Google access token, ask the Play
// Developer API directly whether this token is real and paid for, only
// THEN credit anything) — see that file for the shared reasoning, not
// repeated here. The one thing genuinely new here, same as its Razorpay
// counterpart: complete_play_expert_session_order() can fail with
// NO_EXPERT_AVAILABLE even though the Play purchase itself already
// succeeded (every online expert got claimed in the gap between purchase
// and verification, or nobody stayed online that long) — see
// sql/013_google_play_billing.sql's comment on that. Real money was
// captured for nothing in that case, so this function's job isn't done
// until it's refunded via the Play Developer API's orders.refund (with
// revoke=true, so the entitlement is pulled back too, not just the money)
// and the customer is told plainly what happened.
//
// expert_session is a CONSUMABLE product (bought again for every session,
// unlike the report tiers which are owned once) — on success this function
// also calls the Play Developer API's purchases.products.consume so the
// SAME product id can be purchased again next time, rather than relying
// solely on the client's own finishTransaction({isConsumable:true}) call
// (app.js calls that too, as a client-side acknowledgement path — this
// server-side consume is the one that's guaranteed to run even if the app
// is killed right after purchase).
//
// Returns { session_id, expert_name, expert_specialty } on success, or an
// error the client can show as-is.
//
// How to deploy: Supabase dashboard -> Edge Functions -> Deploy a new
// function -> name it exactly "verify-play-expert-session-purchase" -> Via
// Editor -> paste this whole file -> Deploy. Uses the same
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON / ANDROID_PACKAGE_NAME secrets as
// verify-play-report-purchase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function apiKey(dictVar: string, name: string, legacyVar: string): string {
  try {
    const dict = JSON.parse(Deno.env.get(dictVar) ?? "{}");
    if (dict[name]) return dict[name];
  } catch (_) { /* malformed/missing — fall through to legacy */ }
  return Deno.env.get(legacyVar)!;
}

// Flat fee for one expert-chat session, in paise, for OUR OWN bookkeeping —
// kept in sync by hand with EXPERT_SESSION_PRICE_PAISE in
// create-expert-session-order/index.ts and the real price configured for
// the "expert_session" product in Play Console.
const EXPERT_SESSION_PRICE_PAISE = 19900;
const EXPERT_SESSION_PRODUCT_ID = "expert_session";

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

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Same helper as verify-play-report-purchase/index.ts — duplicated rather
// than shared, matching this project's existing convention of every Edge
// Function being a single self-contained file you paste whole into the
// Supabase dashboard (see apiKey() above, duplicated the same way across
// every payment function already).
async function googleAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encClaims = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encHeader}.${encClaims}`;

  const pem = String(sa.private_key)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(sig)}`;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) {
    const detail = await tokenResp.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${tokenResp.status} ${detail}`);
  }
  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

// Full refund + entitlement revoke of a captured Play purchase — used only
// for the NO_EXPERT_AVAILABLE path below. Logs and swallows its own
// failure rather than throwing, same reasoning as verify-expert-session-
// payment/index.ts's refundPayment(): the customer-facing response already
// explains no expert was available, and a failed refund attempt here is a
// support/ops problem (retry manually from the Play Console), not
// something a second error message to the browser fixes.
async function refundPlayOrder(orderId: string, accessToken: string, packageName: string): Promise<boolean> {
  const resp = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/orders/${encodeURIComponent(orderId)}:refund?revoke=true`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    console.error("Play refund failed:", resp.status, await resp.text().catch(() => ""));
    return false;
  }
  return true;
}

async function consumePlayPurchase(productId: string, token: string, accessToken: string, packageName: string): Promise<void> {
  const resp = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:consume`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    console.error("Play consume failed:", resp.status, await resp.text().catch(() => ""));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SECRET_KEY = apiKey("SUPABASE_SECRET_KEYS", "default", "SUPABASE_SERVICE_ROLE_KEY");
    const SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
    const PACKAGE_NAME = Deno.env.get("ANDROID_PACKAGE_NAME");
    if (!SERVICE_ACCOUNT_JSON || !PACKAGE_NAME) {
      console.error("Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON / ANDROID_PACKAGE_NAME secrets");
      return json({ error: "Play Billing isn't configured yet." }, 500);
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
    const purchaseToken = body?.purchaseToken;
    if (typeof purchaseToken !== "string" || !purchaseToken) {
      return json({ error: "Malformed purchase response." }, 400);
    }

    const accessToken = await googleAccessToken(SERVICE_ACCOUNT_JSON);

    const verifyResp = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}/purchases/products/${EXPERT_SESSION_PRODUCT_ID}/tokens/${encodeURIComponent(purchaseToken)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!verifyResp.ok) {
      console.error("Play purchase lookup failed:", verifyResp.status, await verifyResp.text().catch(() => ""));
      return json({ error: "Couldn't confirm the purchase — please contact support." }, 502);
    }
    const purchase = await verifyResp.json();
    if (purchase.purchaseState !== 0) {
      return json({ error: "Purchase not completed." }, 402);
    }

    const adminClient = createClient(SUPABASE_URL, SECRET_KEY);
    const { data: result, error: completeErr } = await adminClient.rpc("complete_play_expert_session_order", {
      p_user_id: user.id,
      p_purchase_token: purchaseToken,
      p_product_id: EXPERT_SESSION_PRODUCT_ID,
      p_amount_paise: EXPERT_SESSION_PRICE_PAISE,
    });

    if (completeErr) {
      if (String(completeErr.message || "").includes("NO_EXPERT_AVAILABLE")) {
        const refunded = purchase.orderId
          ? await refundPlayOrder(purchase.orderId, accessToken, PACKAGE_NAME)
          : false;
        await consumePlayPurchase(EXPERT_SESSION_PRODUCT_ID, purchaseToken, accessToken, PACKAGE_NAME);
        return json({
          error: refunded
            ? "No experts are available right now — you have not been charged."
            : "No experts are available right now. Your refund is being processed — contact support if you don't see it within a few days.",
        }, 409);
      }
      console.error("complete_play_expert_session_order failed:", completeErr);
      return json({ error: "Payment succeeded but couldn't be recorded — please contact support." }, 500);
    }
    if (!result || !result[0]) {
      console.error("complete_play_expert_session_order returned no row");
      return json({ error: "Payment succeeded but couldn't be recorded — please contact support." }, 500);
    }

    // Consume AFTER the RPC has already credited the session — same
    // ordering as verify-play-report-purchase's acknowledge call, so our
    // own records are correct even if this best-effort call fails.
    await consumePlayPurchase(EXPERT_SESSION_PRODUCT_ID, purchaseToken, accessToken, PACKAGE_NAME);

    const { session_id, expert_name, expert_specialty } = result[0];
    return json({ session_id, expert_name, expert_specialty });
  } catch (err) {
    console.error("verify-play-expert-session-purchase error:", err);
    return json({ error: "Something went wrong — please contact support." }, 500);
  }
});
