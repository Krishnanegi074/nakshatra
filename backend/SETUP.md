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
- **Direct network access to Supabase** — `supabase.com`, `api.supabase.com`,
  and any `*.supabase.co` hosted project all return 403 from this sandbox's
  proxy. The same is true of the CDN the app loads the Supabase library
  from (`cdn.jsdelivr.net`) — it fails to load here for the same reason.

So no live Supabase instance — local or hosted — is reachable from inside
this session, in any form. That's a hard environment limit, not a shortcut.
Everything below was verified as rigorously as that constraint allows.

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
  page load, saving the birth chart + palm report, the test-mode checkout
  RPC (including its FAILURE path), gifting (send, redeem, self-redeem
  block, double-redeem block), chat message persistence, and the community
  feed (post/like/unlike, seed posts vs. real posts). Tested with 40 checks
  (`astro_app/tests-backend/test-backend-integration.js`) driven through the
  real UI in a real headless browser, against a faithful in-browser
  reimplementation of the schema's tables/RLS-equivalent scoping/RPC
  behavior (`astro_app/tests-backend/fake-supabase.js`) — including a real
  `page.reload()` proving session restore actually works after a reload,
  not just in theory. The full pre-existing regression suite (125 checks
  across 6 files) was also re-run against the new build with no backend
  configured, confirming the app still degrades gracefully to its old
  in-memory behavior when Supabase isn't reachable.

All four suites are re-runnable any time:
`bash tests/run-rls-tests.sh`, `node tests/test-data-layer.js` (both in
`nakshatra-backend/`), and `node tests-backend/test-backend-integration.js`
(in `astro_app/`, plus the existing `test-*.js` files there).

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
5. Open `astro_app/supabase-client.js` (the working copy that `build.js`
   inlines into the shipped HTML — keep `nakshatra-backend/supabase-client.js`
   in sync if you edit one) and paste those two values into `SUPABASE_URL`
   and `SUPABASE_ANON_KEY` near the top. The anon key is safe to ship in
   client-side code — it has no power beyond what the RLS policies allow.
6. From `astro_app/`, run `node build.js` to rebuild `nakshatra-app.html`
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
(`astro_app/tests-backend/fake-supabase.js`, now also mirrors this RPC),
9 new checks in `test-backend-integration.js`, all passing. Before this goes
live: sign up a real throwaway account, delete it through the app, and
confirm in the Supabase Table Editor that the row is really gone from
`auth.users` and every table that referenced it — same "prove it against
the real thing" step every other piece of this backend needed.

Two new pages (Privacy Policy, Terms of Service — reachable from the
landing page footer and from Settings) were also added. **They're a
starting template, not reviewed by a lawyer** — both have `[Add your ...
here]` placeholders (contact email, governing jurisdiction) that need to be
filled in, and the whole thing should get a real legal review, especially
once real payments are involved and given India's DPDP Act 2023, before
real users rely on what they say.

## What's left

- **Payment gateway (test mode is a known, documented gap).**
  `record_test_purchase()` currently trusts whatever tier/amount the client
  sends — fine only because nothing here is real money yet. Before a real
  public launch, this must be replaced by a flow where a real gateway
  (Razorpay/Stripe) confirms the charge server-side (webhook) before any
  unlock is recorded — never trust "payment succeeded" coming straight from
  the browser. See the comment above that function in `sql/002_schema.sql`.
- **A full manual QA pass against the real deployed project**, once it
  exists: signup, login, logout, reload-persistence, account deletion, and
  spot-checking that Alice genuinely can't see Bob's data through the real
  API (not just through the local test suites).
- **Documenting the path to actually hosting the frontend publicly** —
  where the HTML file itself gets deployed (Netlify/Vercel/GitHub Pages are
  all reasonable zero-backend-needed options since Supabase IS the backend
  now) — this hasn't been written up yet.
- **Legal review of the Privacy Policy / Terms of Service** — see above.
