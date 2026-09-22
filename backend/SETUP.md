# Nakshatra backend — status and setup

## What this is

The real Supabase-backed database layer for Nakshatra, and the app wiring
that uses it — replacing the in-memory, browser-only state the app used
through Phase 4. This document explains what's been built, what's genuinely
been verified vs. what hasn't, and exactly what to do to go live.

## Why this couldn't be tested against a REAL Supabase project here

This sandbox's network is firewalled to a narrow allowlist (npm, PyPI,
crates.io, a few others). Two things are confirmed blocked:

- **Docker image pulls** — `supabase start` (which would run a full local
  Supabase stack) fails immediately: every registry (AWS ECR, GHCR, Docker
  Hub) returns 403 Forbidden.
- **Direct network access to Supabase or Razorpay** — `supabase.com`,
  `api.supabase.com`, any `*.supabase.co` hosted project, and
  `api.razorpay.com` all return 403 from this sandbox's proxy. The same is
  true of the CDNs the app loads the Supabase and Razorpay libraries from
  (`cdn.jsdelivr.net`, `checkout.razorpay.com`) — they fail to load here for
  the same reason.

So no live Supabase instance — local or hosted — and no real Razorpay
account are reachable from inside this session, in any form. That's a hard
environment limit, not a shortcut. Everything below was verified as
rigorously as that constraint allows.

## What WAS genuinely verified

- **`sql/002_schema.sql`** — the full database schema and Row Level Security
  policies, loaded into a real local PostgreSQL 16 install and tested with
  34 automated checks (`tests/run-rls-tests.sh`), run as the actual
  `authenticated` Postgres role (not a superuser bypassing RLS), simulating
  two separate real accounts. Verified for real: every private table blocks
  cross-user reads and writes; the community feed is publicly readable but
  only self-writable; gift codes can't be browsed/enumerated and can only be
  redeemed through a function (self-redeem blocked, double-redeem blocked);
  purchases/unlocks can't be written directly by a client at all; new
  signups auto-get a profile row via a trigger; owner-id columns correctly
  default to the caller's own id when the client omits them.
- **`supabase-client.js`** — the data-access layer the frontend calls.
  Tested with 31 checks (`node tests/test-data-layer.js`) against a fake
  Supabase client that records every call — verifies every table name,
  column name, RPC name/parameter, and upsert conflict target matches the
  schema exactly, and that read functions correctly short-circuit (no
  network call) when nobody's logged in.
- **The actual app wiring in `app.js`** — signup/login, session restore on
  page load, saving the birth chart + palm report, the real Razorpay
  checkout flow (self-purchase and gift, both the "Razorpay itself declined
  the payment" and "payment succeeded but our own verification failed"
  failure paths), gifting (send, redeem, self-redeem block, double-redeem
  block), chat message persistence, and the community feed (post/like/unlike,
  seed posts vs. real posts). Tested with 51 checks
  (`app/tests-backend/test-backend-integration.js`) driven through the real
  UI in a real headless browser, against a faithful in-browser
  reimplementation of the schema's tables/RLS-equivalent scoping/RPC
  behavior (`app/tests-backend/fake-supabase.js`) plus a fake
  `window.Razorpay` (`app/tests-backend/fake-razorpay.js`) standing in for
  the real Checkout widget — including a real `page.reload()` proving
  session restore actually works after a reload, not just in theory. The
  full pre-existing regression suite (also updated for real payments — see
  below) was also re-run against the new build, confirming everything else
  still degrades gracefully to its old in-memory behavior when Supabase
  isn't reachable.
- **`sql/004_razorpay_payments.sql`** — the `razorpay_orders` table and
  `complete_razorpay_order()`, loaded into the same real local PostgreSQL 16
  install as `002_schema.sql`. `tests/run-rls-tests.sh` now also runs 7
  additional checks: `complete_razorpay_order()` is unreachable by the
  `authenticated` role (proving the missing grant actually works, not just
  that it looks right on paper); a self-purchase correctly sets
  `unlocks`/`purchases`; a gift purchase mints a properly-shaped code and
  does *not* unlock the sender; calling it twice for the same order doesn't
  double-credit (idempotency); and an unknown order fails cleanly. Also
  caught and fixed a real bug this way: the first draft of the gift-code
  generator used `(random() * 32)::int`, which *rounds* rather than
  truncates in Postgres and could land one past the 32-character alphabet's
  last valid position, silently producing a 3-character group instead of 4
  (`substr()` on an out-of-range position returns `''`, not an error) — 20
  consecutive runs after the `floor()` fix produced zero malformed codes.
- **`supabase/functions/create-razorpay-order/index.ts` and
  `verify-razorpay-payment/index.ts`** — type-checked (`tsc --noEmit`, with
  the same Deno global shim used for `delete_own_account`'s era of testing)
  with zero errors beyond the expected "cannot find module" for the
  `esm.sh` import, which only a real Deno/Supabase Edge Function runtime can
  resolve.

All these suites are re-runnable any time:
`bash tests/run-rls-tests.sh`, `node tests/test-data-layer.js` (both in
`backend/`), and `node tests-backend/test-backend-integration.js`
(in `app/`, plus the existing `test-*.js` files there).

## What was NOT verified (and can't be, from here)

Anything that requires an actual live request to Supabase's real Auth/REST
API: real signup emails, real password login against a real project, and
the RLS policies behaving the same way through real PostgREST as they did
through raw `psql` and the faithful-but-not-real fake client (they should —
the policies are plain SQL, and the fake client's behavior was modeled
directly off the schema — but "should" isn't "verified against the real
thing").

## Setting up the real project

1. Go to supabase.com and create a free project (~2 minutes, needs a
   browser — this sandbox can't reach that site to do it for you).
2. In the project dashboard: **SQL Editor -> New query**, paste the entire
   contents of `sql/002_schema.sql`, click Run. This creates every table,
   policy, and function in one shot. (Do **not** run `sql/001_local_shim.sql`
   here — that file is a stand-in for local testing only and would conflict
   with Supabase's real `auth` schema.)
3. **Authentication -> Providers -> Email**: turn **off** "Confirm email".
   The app's signup flow expects to log the user in immediately and take
   them straight into onboarding — if email confirmation is on, they'll see
   a "check your email" message instead and have to confirm before their
   first login. Leave it off for now (test/demo phase); turn it on when this
   is a real public launch with real email delivery configured.
4. **Project Settings -> API**, copy the "Project URL" and the "anon
   public" key.
5. Open `app/supabase-client.js` (the working copy that `build.js`
   inlines into the shipped HTML — keep `backend/supabase-client.js`
   in sync if you edit one) and paste those two values into `SUPABASE_URL`
   and `SUPABASE_ANON_KEY` near the top. The anon key is safe to ship in
   client-side code — it has no power beyond what the RLS policies allow.
6. From `app/`, run `node build.js` to rebuild `nakshatra-app.html`
   with your real credentials baked in.
7. Open the rebuilt file in a real browser (not this sandbox) and sign up —
   that first real signup is the one thing that genuinely proves the whole
   chain works end to end.

## A behavior change worth knowing about

The app now loads the Supabase JS library from a CDN
(`cdn.jsdelivr.net`) via a `<script src="...">` tag — it's no longer a
100%-self-contained, zero-network-dependency single file the way Phases
1-4 were. If that CDN can't load (offline, or a restrictive network), the
app **degrades gracefully**: `NakshatraDB.db` stays `null` and every screen
falls back to the old in-memory-only demo behavior rather than breaking.
But real signups/persistence obviously need that script (and Supabase
itself) to actually be reachable.

**One deliberate exception to "degrades gracefully": checkout.** Now that
checkout is real money via Razorpay, there's no honest way to fake a
successful payment client-side the way the old test-mode checkout could —
doing so would mean anyone could unlock paid content for free just by
disabling their network. So without a backend, clicking Pay now shows
"Payments aren't available right now" and stops, rather than pretending to
succeed. Every other feature (auth, birth chart, palm report, chat,
community) still falls back to the old in-memory demo behavior as before.

## Account deletion (added after launch-readiness review)

The app now has a real "Settings -> Delete My Account" flow (Settings is the
gear icon on the dashboard), backed by a new `delete_own_account()` function
in `sql/003_account_deletion.sql`. **This migration needs to be run against
your real project the same way `002_schema.sql` was** — SQL Editor -> New
query -> paste the whole file -> Run. It's additive (doesn't touch existing
tables), so it's safe to run any time after `002_schema.sql`.

This could not be verified against a real Supabase project from this
sandbox either (same network limitation as everything else in this
document) — it was verified against the faithful in-browser fake backend
(`app/tests-backend/fake-supabase.js`, now also mirrors this RPC),
9 new checks in `test-backend-integration.js`, all passing. Before this goes
live: sign up a real throwaway account, delete it through the app, and
confirm in the Supabase Table Editor that the row is really gone from
`auth.users` and every table that referenced it — same "prove it against
the real thing" step every other piece of this backend needed.

Two new pages (Privacy Policy, Terms of Service — reachable from the
landing page footer and from Settings) were also added, contact
email/jurisdiction placeholders already filled in with real values. **They're
still a starting template, not reviewed by a lawyer** — and now that real
payments are involved (see below) and given India's DPDP Act 2023, they
should get a real legal review, including a pass to make sure the "Third
parties" section's payment-gateway wording still matches reality now that a
gateway is actually wired up, before real users rely on what they say.

## Real payments (Razorpay) — replaces the test-mode checkout

The app's checkout now goes through a real Razorpay integration instead of
`record_test_purchase()`. Three pieces make this work, and **all three need
to actually be deployed to your real Supabase + Razorpay accounts** before
checkout on the live site will work — right now the live frontend already
calls Edge Functions that don't exist yet on the backend, so clicking Pay
will fail until this is done:

1. **`sql/004_razorpay_payments.sql`** — adds the `razorpay_orders` table and
   `complete_razorpay_order()`, and removes the `gift_codes_insert_own`
   policy (a gift code must now always be backed by a verified payment, not
   a direct client insert). Run it the same way as every other file in
   `sql/` — SQL Editor -> New query -> paste the whole file -> Run — any
   time after `002_schema.sql` and `003_account_deletion.sql`.
2. **Create a Razorpay account** at [razorpay.com](https://razorpay.com) if
   you don't have one yet (this sandbox can't do this for you — needs a
   browser and your own business details). Start in **Test Mode** so you can
   verify everything end to end with fake money before going live. From
   **Settings -> API Keys**, generate a Key ID and Key Secret.
3. **Deploy the two Edge Functions** under `supabase/functions/`:
   `create-razorpay-order` and `verify-razorpay-payment`. In the Supabase
   dashboard: **Edge Functions -> Deploy a new function**, name it *exactly*
   `create-razorpay-order`, choose **Via Editor**, paste the contents of
   `supabase/functions/create-razorpay-order/index.ts`, Deploy. Repeat for
   `verify-razorpay-payment`. Then **Edge Functions -> Manage secrets**, add
   `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (from step 2) — these are
   shared by both functions, add them once. `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are already available
   to every Edge Function automatically; nothing to add for those.

Once all three are in place, do a real test payment (Razorpay's test mode
has [published test card/UPI numbers](https://razorpay.com/docs/payments/payments/test-card-details/)
that don't move real money) and confirm in the Supabase Table Editor that
`razorpay_orders` goes `created` -> `verified`, a `purchases` row appears
with `status = 'razorpay_success'`, and `unlocks` (or `gift_codes`, for a
gift) updates correctly — the same "prove it against the real thing" step
every other piece of this backend needed, and the one thing that couldn't be
done from this sandbox (no network access to `api.razorpay.com` either).
**Only switch the Razorpay account from Test Mode to Live Mode, and swap in
live API keys, after that real test payment has been confirmed working.**

What WAS verified from here: the SQL migration against a real local
PostgreSQL 16 install (schema, RLS, and `complete_razorpay_order()`'s actual
behavior — self-purchase, gift, idempotency, and that `authenticated` truly
cannot call it directly); both Edge Functions type-check cleanly; and the
whole frontend flow (`createRazorpayOrder` -> Razorpay Checkout ->
`verifyRazorpayPayment`, both failure paths) against a fake `window.Razorpay`
and fake Edge Functions, driven through the real UI. See the "What WAS
genuinely verified" section above for the exact check counts.

## What's left

- **Deploying the Razorpay payment backend (written and tested, not yet
  live).** The live site's frontend already expects real Razorpay checkout,
  but `sql/004_razorpay_payments.sql` and the two Edge Functions under
  `supabase/functions/` still need to actually be applied to the real
  Supabase project, and a real Razorpay account/API keys still need to be
  created — see "Real payments (Razorpay)" above for the exact steps. Until
  that's done, checkout on the live site fails (the Edge Functions it calls
  don't exist on the backend yet).
- **A real test payment**, once the above is deployed and Razorpay is in
  Test Mode — the one verification step that couldn't be done from this
  sandbox (no network access to `api.razorpay.com`). Don't flip Razorpay to
  Live Mode before this passes.
- **A full manual QA pass against the real deployed project**: signup,
  login, logout, reload-persistence, account deletion, a real Razorpay test
  payment (self-purchase and gift), and spot-checking that Alice genuinely
  can't see Bob's data through the real API (not just through the local
  test suites).
- **Legal review of the Privacy Policy / Terms of Service** — see above.
  Also worth a pass once real payments are live: the "Third parties"
  section's current wording ("If and when real payments are enabled...")
  should be updated to reflect that they now are.
- **Turning on email confirmation** in Supabase Auth (Authentication ->
  Providers -> Email) before any real public signups — see step 3 above;
  it's deliberately off right now for faster testing.
