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
  Tested with 52 checks (`node tests/test-data-layer.js`, 31 original + 17
  for the Phase 3 expert-chat functions below + 4 from the fake client
  gaining `.limit()` support, which those needed) against a fake Supabase
  client that records every call — verifies every table name, column name,
  RPC name/parameter, and upsert conflict target matches the schema
  exactly, and that read functions correctly short-circuit (no network
  call) when nobody's logged in. Adding the new checks caught a real,
  unrelated regression: an existing check that greps supabase-client.js's
  source text between two hardcoded markers to confirm createRazorpayOrder/
  verifyRazorpayPayment never touch tables directly broke the instant the
  new expert-chat functions were added between those same two markers —
  fixed by making that check's boundary self-contained (ends at
  verifyRazorpayPayment's own closing brace) instead of chasing a marker
  name, so it can't happen again regardless of what gets added nearby next.
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
- **`create-expert-session-order/index.ts` and
  `verify-expert-session-payment/index.ts`** (Phase 3, the customer-side
  connect/pay flow) — type-checked the same way, plus this time an ambient
  `declare module "https://esm.sh/@supabase/supabase-js@2"` in the shim so
  even that one expected error goes away: all four Edge Functions (the two
  new ones alongside the two existing report-payment ones, to make sure the
  shim itself wasn't just accidentally lenient) type-check with zero errors
  under `strict: true`.

- **The Phase 3 client-side wiring itself** (`app/index.template.html`,
  `app/app.js`, `app/i18n.js` — the "Talk to a Real Expert" entry point,
  paywall, and live session screens, alongside the demo chat rather than
  replacing it) — no live backend to click through in this environment, so
  verified structurally instead: `node build.js` assembles cleanly, and
  every single `$("#...")` id app.js references (193 across the *whole*
  file, not just the new code) and every `showScreen()` target (24) was
  cross-checked against the built template with none missing. Every new
  key referenced via `data-i18n`/`tr()` has both an English and a Hindi
  translation (12 keys, matching this project's existing bilingual
  standard — see `i18n.js`'s own header on why that scope is deliberate).

All these suites are re-runnable any time:
`bash tests/run-rls-tests.sh`, `node tests/test-data-layer.js` (both in
`backend/`), and `node tests-backend/test-backend-integration.js`
(in `app/`, plus the existing `test-*.js` files there).

- **`sql/009_expert_chat.sql`** (real expert chat, schema phase) — `experts`
  + `experts_public`, `chat_sessions`, `chat_messages.session_id` (extending
  the existing table rather than replacing it — the demo chat is untouched),
  and `complete_expert_session_order()`'s locked expert-matching. Covered by
  new checks in `tests/test-rls.js` (Group 11, 19 checks: `experts_public`'s
  broad read vs. `experts`' own-row-only real table, `chat_sessions`'
  no-direct-insert + column-restricted update, and — the policy this feature
  actually hinges on — a real second user (the assigned expert) reading and
  replying into a conversation that isn't "their own" by the original
  `chat_messages` rule, including that neither side can impersonate the
  other or forge whose conversation a message belongs to) and in
  `tests/run-rls-tests.sh` (7 more: `complete_expert_session_order()`'s
  matching, idempotency, wrong-order-type/not-found errors, and — the one
  genuinely new kind of check in this whole suite — a real concurrency
  test: two customers paying at the same instant with exactly one free
  expert slot between them, fired as two truly-parallel processes, proving
  the locked matching loop resolves it correctly — one match, one clean
  `NO_EXPERT_AVAILABLE` — instead of double-booking). **Run for real**,
  against a real local Postgres instance (see below): 84/84 checks passed,
  after fixing four real bugs the run surfaced that code review alone had
  missed (three in the SQL/tests, one a genuine gap in this file):
  1. `chat_messages_all_own` (002_schema.sql) is a blanket "you own this
     row, do anything" policy that predates `session_id` — left as-is, it
     silently overrode the new policy's sender-impersonation check, because
     Postgres ORs every applicable permissive policy together and a
     customer's own session rows always carry their own `user_id`. Fixed by
     re-scoping that policy to demo rows only.
  2. `CREATE PUBLICATION ... IF NOT EXISTS` isn't valid Postgres syntax —
     the local shim's attempt to stub out Supabase's `supabase_realtime`
     publication failed with a syntax error, which (since a single `-c`/`-f`
     call runs as one implicit transaction) silently rolled back *all* of
     001_local_shim.sql, cascading failures through every migration after
     it. Fixed with a proper existence check.
  3. Alice/Bob never actually got a `public.profiles` row locally:
     `handle_new_user()`'s trigger only fires for auth.users rows inserted
     *after* it exists, but 001_local_shim.sql's Alice/Bob insert has to run
     *before* 002_schema.sql (which creates both the trigger and the table
     the FK points at). Carol never had this problem — she's inserted fresh
     specifically to test the trigger. Fixed with an explicit backfill.
  4. The concurrent-matching race test's own assertion was too weak — it
     only checked that the two results were non-empty and different from
     each other, which would have also accepted "one succeeded, one hit an
     unrelated error" as a pass. Tightened to the actual invariant: exactly
     one of the two matches the one genuinely free expert, the other gets a
     clean `NO_EXPERT_AVAILABLE`.

- **`sql/010_expert_customer_name.sql`** — `expert_customer_names`, a
  narrow view (just `session_id`/`customer_name`) letting an expert see the
  name of the customer on a session actually assigned to them, closing a
  gap Phase 1 left (profiles is otherwise strictly own-row-only, and
  nothing let an expert see anything about their customer beyond a raw
  id). A separate migration from 009 on purpose, so 009's already-verified
  84 checks never had to be touched. Also run for real, on top of the same
  verified state (3 new checks in `tests/test-rls.js`'s Group 12: the
  assigned expert sees the name, an unrelated user sees nothing, and —
  worth calling out specifically — the session's own *customer* sees
  nothing via this view either, since it's the expert-facing direction
  only). Combined total after this migration: 87/87 checks passed
  (70 in `test-rls.js` + 17 functional/concurrency checks).

- **Phase 4 — Supabase Realtime**, replacing the 4-second polling on both
  `expert/index.html` (incoming session queue, chat messages) and the
  customer-side live session screen (chat messages, and "match status" —
  the session's own `chat_sessions` row changing, e.g. the other side
  ending it) with `postgres_changes` subscriptions. No new migration and no
  RLS policy changes: `chat_messages`/`chat_sessions` were already added to
  the `supabase_realtime` publication in `009_expert_chat.sql`, and
  Realtime's own authorization for `postgres_changes` evaluates each row
  against the table's normal SELECT policies before delivering an event —
  `chat_sessions_select_customer`/`_select_expert` and
  `chat_messages_session_participants` already scoped exactly the right
  rows to the right subscriber; the `filter` a channel subscribes with is a
  server-side optimization on top of that, not what actually keeps it
  private. Two new `supabase-client.js` functions
  (`subscribeToSessionMessages`/`subscribeToSessionStatus`) keep the actual
  `supabase.channel()` calls confined to that one file, same as every
  other function there, rather than `app.js` or `expert/index.html`
  reaching for the client directly.
  Verified with 11 new checks in `tests/test-data-layer.js` (a fake
  realtime channel that records exactly what `event`/`table`/`filter` each
  subscription actually asked for, and that `payload.new` — not the raw
  event envelope — is what reaches the caller's callback) — **combined
  total 63/63**. Re-ran the full `test-rls.js` + functional-checks pass
  too, unchanged at 87/87, confirming this phase's code-only changes
  (no `.sql` files touched) didn't regress anything underneath.

  **The one thing this environment genuinely cannot verify**: whether
  Supabase's real Realtime *service* — a separate piece of infrastructure
  from Postgres itself, which this sandbox has no way to stand up — 
  actually delivers events correctly for `chat_messages_session_participants`
  specifically. That policy's `USING` clause is a subquery (`exists (select
  ... from chat_sessions cs where ...)`), not a plain column comparison —
  a documented, supported pattern for `postgres_changes` authorization, and
  the same shape Supabase's own examples for this kind of "two-party
  conversation" access pattern use, but not something a local Postgres
  install + a fake client can exercise for real, since that authorization
  check happens inside Realtime's own service, not in Postgres itself.
  Confirm this ONE specific case — an expert's subscription actually
  receiving a customer's new message, and vice versa — against a real
  project before relying on it.

## What was NOT verified (and can't be, from here)

Anything that requires an actual live request to Supabase's real Auth/REST
API: real signup emails, real password login against a real project, and
the RLS policies behaving the same way through real PostgREST as they did
through raw `psql`/`pg` and the faithful-but-not-real fake client (they
should — the policies are plain SQL, and the fake client's behavior was
modeled directly off the schema — but "should" isn't "verified against the
real thing").

## Bootstrapping the local test harness (`nakshatra_test` + `app_test_login`)

This file's own testing sections above assume a working local Postgres
already exists, but never actually say how to create one — a real gap, not
just an omission for brevity; reconstructing it (below) is what surfaced bug
#3 above. One-time setup, in order:

1. **Postgres itself.** Any real local Postgres works. This was actually
   verified against a bare, unmodified `postgres`/`initdb`/`pg_ctl` triplet
   (no Homebrew, no Docker, no system install — an `@embedded-postgres`
   npm package's bundled binaries were used, run standalone from a scratch
   data directory: `initdb -D <dir> -U postgres -A trust`, then `pg_ctl -D
   <dir> -o "-p 5432 -c unix_socket_directories=''" start`). `trust` auth
   and TCP-only (no Unix socket) are fine for a disposable local test
   cluster and sidestep needing an OS-level `postgres` user/`sudo` at all —
   `tests/run-rls-tests.sh`'s own `sudo -u postgres psql` calls assume that
   OS-level setup exists (true on whatever Linux box this repo's test
   harness was first built against), which a plain macOS install won't have
   by default; adjust those calls (or however you connect as the cluster's
   superuser) to match whatever your own Postgres setup actually looks like.
2. **Database + roles**, connected as that superuser:
   ```sql
   create database nakshatra_test;
   \c nakshatra_test
   create role anon nologin;
   create role authenticated nologin;
   create role service_role nologin bypassrls;
   create role app_test_login login password 'testpass123';
   grant anon, authenticated, service_role to app_test_login;
   ```
3. **Run every `sql/NNN_*.sql` file in numeric order**, starting with
   `001_local_shim.sql`, against `nakshatra_test`, as the superuser.
4. From here on, `bash tests/run-rls-tests.sh` (fixtures + `node
   tests/test-rls.js` + the functional checks) is re-runnable any time
   without redoing 1–3 — it only truncates/reseeds the tables that need it
   per run.

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

## 011 — Broadcast-from-Database for chat messages

`postgres_changes` on `chat_messages` delivered nothing on the live project
(Realtime couldn't evaluate `chat_messages_session_participants`' subquery).
`sql/011_chat_broadcast.sql` replaces it for messages: an AFTER INSERT trigger
calls `realtime.broadcast_changes()` on private topic `session:<id>`, and an RLS
policy on `realtime.messages` limits that topic to the session's customer and
expert. Clients call `supabase.realtime.setAuth()` then join with
`{ config: { private: true } }`. Not runnable on the local shim (no `realtime`
schema) — verify with `node tests/realtime-test.js` against the live project
after applying. `chat_sessions` status/queue subscriptions still use
`postgres_changes`.
