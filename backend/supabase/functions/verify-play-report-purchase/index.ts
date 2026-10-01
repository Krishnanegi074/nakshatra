// Nakshatra — verify-play-report-purchase
//
// The Android app's twin of verify-razorpay-payment, called by
// app/supabase-client.js's verifyPlayReportPurchase(productId, purchaseToken)
// right after the @capawesome-team/capacitor-purchases plugin resolves a
// report-tier purchase (see initCheckout() in app/app.js's native branch).
// This is the ONLY place that's allowed to decide a Play purchase really
// happened: it mints a short-lived Google access token from a service
// account, asks the Google Play Developer API directly whether this
// purchase token is real and paid for, and only then calls
// complete_play_report_purchase() (sql/013_google_play_billing.sql) to
// credit it. See that migration's header for the full flow and why there's
// no separate "create order" step the way Razorpay needs one.
//
// How to deploy (no CLI/Docker in the sandbox this was written in — see
// SETUP.md): Supabase dashboard -> Edge Functions -> Deploy a new function
// -> name it exactly "verify-play-report-purchase" -> Via Editor -> paste
// this whole file -> Deploy. Needs three secrets (Edge Functions -> Manage
// secrets, shared by every function in the project):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — the full JSON key file downloaded for
//     a service account that has been invited in Play Console -> Users and
//     permissions with "View financial data" + "View app information" (the
//     minimum needed to read purchases), pasted in as one line.
//   ANDROID_PACKAGE_NAME — the app's applicationId, e.g. "nakshatra.ind.in.app"
//     (see android/app/build.gradle).
// RAZORPAY_* secrets are not needed here — this function never touches Razorpay.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function apiKey(dictVar: string, name: string, legacyVar: string): string {
  try {
    const dict = JSON.parse(Deno.env.get(dictVar) ?? "{}");
    if (dict[name]) return dict[name];
  } catch (_) { /* malformed/missing — fall through to legacy */ }
  return Deno.env.get(legacyVar)!;
}

// Real prices, in paise, for OUR OWN bookkeeping only (the purchases table
// has always recorded amount_paise, so a Play purchase keeps recording one
// too) — this is NOT what actually gets charged. The real price is whatever
// you configured for this product id in Play Console; keep these numbers in
// sync with that by hand, the same way TIER_PRICES_PAISE in
// create-razorpay-order/index.ts is kept in sync with app.js's TIER_INFO.
// The product id -> tier mapping below is also the ONLY thing that decides
// what a given purchase unlocks — never trust a tier the client sends.
const PRODUCT_TIER_MAP: Record<string, { tier: string; amountPaise: number }> = {
  report_onetime: { tier: "onetime", amountPaise: 39900 },
  report_bundle: { tier: "bundle", amountPaise: 59900 },
  report_subscription: { tier: "subscription", amountPaise: 29900 },
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

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mints a fresh Google OAuth2 access token from the service account's JSON
// key, using the standard JWT-bearer flow (no npm googleapis client needed —
// this is three Web Crypto calls). One extra round trip per verification
// call; simple and plenty fast enough at this volume, not worth caching
// across invocations.
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
    const productId = body?.productId;
    const purchaseToken = body?.purchaseToken;
    if (typeof productId !== "string" || typeof purchaseToken !== "string" || !purchaseToken) {
      return json({ error: "Malformed purchase response." }, 400);
    }
    const product = PRODUCT_TIER_MAP[productId];
    if (!product) {
      return json({ error: "Unknown product." }, 400);
    }

    const accessToken = await googleAccessToken(SERVICE_ACCOUNT_JSON);

    // The one check that actually proves this purchase is real: ask Google
    // directly, server to server. purchaseState 0 = purchased; anything
    // else (1 = canceled, or the lookup failing outright) means don't credit.
    const verifyResp = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`,
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
    const { data: result, error: completeErr } = await adminClient.rpc("complete_play_report_purchase", {
      p_user_id: user.id,
      p_purchase_token: purchaseToken,
      p_product_id: productId,
      p_tier: product.tier,
      p_amount_paise: product.amountPaise,
    });
    if (completeErr || !result || !result[0]) {
      console.error("complete_play_report_purchase failed:", completeErr);
      return json({ error: "Purchase succeeded but couldn't be recorded — please contact support." }, 500);
    }

    // Acknowledge the purchase with Google — an unacknowledged managed
    // product is automatically refunded by Play after a few days. Best
    // effort: our own records are already correct at this point (the RPC
    // above already ran), so a failure here is logged, not surfaced to the
    // customer — see FinishTransaction/isConsumable note in app.js for how
    // the client-side acknowledgement (finishTransaction) also covers this.
    const ackResp = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!ackResp.ok) {
      console.error("Play purchase acknowledge failed:", ackResp.status, await ackResp.text().catch(() => ""));
    }

    return json({ tier: result[0].tier });
  } catch (err) {
    console.error("verify-play-report-purchase error:", err);
    return json({ error: "Something went wrong — please contact support." }, 500);
  }
});
