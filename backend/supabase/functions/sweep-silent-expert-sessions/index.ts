// Nakshatra — sweep-silent-expert-sessions
//
// Runs once a minute (scheduled with pg_cron + pg_net — see
// backend/sql/optional_schedule_silent_sweep.sql and SETUP.md). Its job: a
// customer who paid for an expert session, asked their question, and heard
// nothing back for GRACE_MINUTES gets their session ended and their money
// back, automatically — and the expert is freed from the dead session.
//
// The decision of WHICH sessions qualify lives in SQL, not here
// (sql/016_silent_expert_refund.sql: claim_silent_expert_sessions() — read
// its header for the exact rule and what is deliberately not covered). This
// function does the part SQL can't: talk to Razorpay.
//
//   1. claim_silent_expert_sessions()  -> ends qualifying sessions
//      (ended_reason = 'expert_silent') and queues a row per session in
//      expert_session_refunds.
//   2. lease_expert_refunds()          -> hands back pending refunds, each
//      leased for a few minutes so overlapping runs can't double-refund.
//   3. For each: find the order's captured payment, refund it in full via
//      Razorpay, record the outcome. A failed attempt is simply retried on a
//      later run (about every 3 minutes) up to MAX_ATTEMPTS, then parked as
//      'failed' for a human. A session paid through Google Play has no
//      Razorpay order: it is recorded as 'manual' (refund it in the Play
//      Console).
//
// Idempotent end to end: a payment that is already refunded counts as done
// (this covers a refund that succeeded but whose response was lost).
//
// Auth: NOT called by browsers, so there is no CORS and no user JWT.
// Deploy it with "Verify JWT" turned OFF (supabase/config.toml has the
// matching setting for the CLI) and protect it with a shared secret instead:
// the caller must send `Authorization: Bearer <SWEEP_SECRET>`, where
// SWEEP_SECRET is an edge-function secret you generate (at least 24
// characters) and also store in Vault for the cron job. Without the secret
// set, the function refuses to run at all.
//
// Razorpay keys: same pair selection as the other expert functions
// (EXPERT_RAZORPAY_KEY_ID/_SECRET when both set, else RAZORPAY_KEY_ID/
// _SECRET) — refunds must be issued with the keys that took the payment.
//
// How to deploy (see SETUP.md): Supabase dashboard -> Edge Functions ->
// Deploy a new function -> name it exactly "sweep-silent-expert-sessions"
// -> Via Editor -> paste this whole file -> turn OFF "Verify JWT" -> Deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// How long a customer waits, from their FIRST message, before the session is
// ended and refunded. Tell experts the same number.
const GRACE_MINUTES = 5;
const CLAIM_BATCH = 20;
const REFUND_BATCH = 10;
const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 3;

// Same helper as the other functions — see create-expert-session-order.
function apiKey(dictVar: string, name: string, legacyVar: string): string {
  try {
    const dict = JSON.parse(Deno.env.get(dictVar) ?? "{}");
    if (dict[name]) return dict[name];
  } catch (_) { /* malformed/missing — fall through to legacy */ }
  return Deno.env.get(legacyVar)!;
}

// Same matched-pair rule as create-/verify-expert-session-*.
function razorpayKeys(): { id: string; secret: string } | null {
  const expertId = Deno.env.get("EXPERT_RAZORPAY_KEY_ID");
  const expertSecret = Deno.env.get("EXPERT_RAZORPAY_KEY_SECRET");
  if (expertId && expertSecret) return { id: expertId, secret: expertSecret };
  const id = Deno.env.get("RAZORPAY_KEY_ID");
  const secret = Deno.env.get("RAZORPAY_KEY_SECRET");
  return id && secret ? { id, secret } : null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type RefundResult = { ok: true; refundId: string | null } | { ok: false; error: string };

// Full refund of whatever is left on the order's captured payment.
async function refundOrder(
  orderId: string,
  sessionId: string,
  keys: { id: string; secret: string },
): Promise<RefundResult> {
  const auth = "Basic " + btoa(`${keys.id}:${keys.secret}`);

  const listResp = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
    headers: { Authorization: auth },
  });
  if (!listResp.ok) return { ok: false, error: `payment lookup failed (${listResp.status})` };
  const list = await listResp.json().catch(() => ({}));
  const items: Array<Record<string, unknown>> = Array.isArray(list?.items) ? list.items : [];

  const captured = items.find((p) => p.status === "captured");
  if (!captured) {
    // Nothing left to refund if it was already refunded (a previous attempt
    // succeeded but its response was lost); otherwise something is wrong.
    if (items.some((p) => p.status === "refunded")) return { ok: true, refundId: null };
    return { ok: false, error: "no captured payment found for this order" };
  }
  const remaining = Number(captured.amount) - Number(captured.amount_refunded ?? 0);
  if (!(remaining > 0)) return { ok: true, refundId: null };

  const refundResp = await fetch(`https://api.razorpay.com/v1/payments/${captured.id}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      amount: remaining,
      speed: "normal",
      notes: { reason: "expert_silent", session_id: sessionId },
    }),
  });
  if (!refundResp.ok) {
    const detail = (await refundResp.text().catch(() => "")).slice(0, 300);
    // Raced with another refund (or the dashboard): it is done, which is the goal.
    if (/fully refunded|already (been )?(fully )?refunded/i.test(detail)) return { ok: true, refundId: null };
    return { ok: false, error: `refund failed (${refundResp.status}): ${detail}` };
  }
  const refund = await refundResp.json().catch(() => ({}));
  return { ok: true, refundId: typeof refund?.id === "string" ? refund.id : null };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const sweepSecret = Deno.env.get("SWEEP_SECRET") ?? "";
    if (sweepSecret.length < 24) {
      console.error("SWEEP_SECRET missing or shorter than 24 characters — refusing to run");
      return json({ error: "Not configured." }, 500);
    }
    const provided = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!safeEqual(provided, sweepSecret)) return json({ error: "Unauthorized." }, 401);

    // No keys = no way to refund. Do NOT end sessions we couldn't refund.
    const keys = razorpayKeys();
    if (!keys) {
      console.error("Missing Razorpay secrets (EXPERT_RAZORPAY_KEY_ID/_SECRET or RAZORPAY_KEY_ID/_SECRET)");
      return json({ error: "Payments aren't configured." }, 500);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      apiKey("SUPABASE_SECRET_KEYS", "default", "SUPABASE_SERVICE_ROLE_KEY"),
    );

    const summary = { claimed: 0, refunded: 0, manual: 0, retrying: 0, failed: 0 };

    const { data: claimed, error: claimErr } = await admin.rpc("claim_silent_expert_sessions", {
      p_grace: `${GRACE_MINUTES} minutes`,
      p_limit: CLAIM_BATCH,
    });
    if (claimErr) {
      console.error("claim_silent_expert_sessions failed:", claimErr);
      return json({ error: "Something went wrong." }, 500);
    }
    summary.claimed = Array.isArray(claimed) ? claimed.length : 0;

    const { data: leased, error: leaseErr } = await admin.rpc("lease_expert_refunds", {
      p_limit: REFUND_BATCH,
      p_lease: `${LEASE_MINUTES} minutes`,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (leaseErr) {
      console.error("lease_expert_refunds failed:", leaseErr);
      return json({ error: "Something went wrong." }, 500);
    }

    for (const row of (leased ?? []) as Array<{
      leased_session_id: string;
      razorpay_order_id: string | null;
      attempts: number;
    }>) {
      const sessionId = row.leased_session_id;

      if (!row.razorpay_order_id) {
        // Not a Razorpay payment (Google Play) — a human refunds it in Play Console.
        await admin.from("expert_session_refunds")
          .update({ status: "manual", last_error: "Google Play purchase: refund in Play Console" })
          .eq("session_id", sessionId);
        summary.manual++;
        continue;
      }

      let result: RefundResult;
      try {
        result = await refundOrder(row.razorpay_order_id, sessionId, keys);
      } catch (err) {
        result = { ok: false, error: `unexpected error: ${String(err).slice(0, 200)}` };
      }

      if (result.ok) {
        await admin.from("expert_session_refunds")
          .update({ status: "refunded", refund_id: result.refundId, refunded_at: new Date().toISOString(), last_error: null })
          .eq("session_id", sessionId);
        summary.refunded++;
      } else {
        const giveUp = row.attempts >= MAX_ATTEMPTS;
        console.error(`Refund attempt ${row.attempts}/${MAX_ATTEMPTS} for session ${sessionId} failed: ${result.error}`);
        await admin.from("expert_session_refunds")
          .update(giveUp ? { status: "failed", last_error: result.error } : { last_error: result.error })
          .eq("session_id", sessionId);
        if (giveUp) summary.failed++; else summary.retrying++;
      }
    }

    if (summary.claimed || summary.refunded || summary.manual || summary.retrying || summary.failed) {
      console.log("sweep-silent-expert-sessions:", JSON.stringify(summary));
    }
    return json(summary);
  } catch (err) {
    console.error("sweep-silent-expert-sessions error:", err);
    return json({ error: "Something went wrong." }, 500);
  }
});
