# Nakshatra

A mobile-web astrology & palmistry app. Real astronomical calculations (no AI
guessing placements), classical palmistry rules, and — since it's meant for
an Indian audience — the traditional **Vedic (sidereal, Lahiri ayanamsa)**
zodiac system rather than Western tropical.

Ships as a single self-contained HTML file (`app/nakshatra-app.html`), built
from source by `app/build.js`. Backend is [Supabase](https://supabase.com)
(Postgres + Auth), so there's no server to run or deploy — the HTML file
talks to Supabase directly from the browser, protected by Row Level Security.

## Repo layout

```
app/        Frontend source + build script + the full Playwright test suite
backend/    Database schema, Row Level Security policies, and backend-only tests
docs/       Product/business planning doc
```

### `app/`

- `index.template.html`, `app.js`, `app.css`, `i18n.js` (English + Hindi UI),
  `rules.js` (astrology/palmistry content rules), `engine.js` / `engine.browser.js`
  (the astronomy calculation engine — Node and browser builds), `city-data.js`
  (792 Indian + global cities for the birth-place picker), `cv-engine.js`
  (client-side palm-photo line detection), `supabase-client.js` (the one
  place every Supabase table/column/RPC name is called from).
- `build.js` inlines all of the above into one file: `nakshatra-app.html`.
  Run `node build.js` from inside `app/` after any source change.
- `test-*.js` — Playwright end-to-end tests (onboarding, chat, gifting,
  community, i18n, responsive layout, computer-vision palm scan, etc.).
  Run any of them directly with `node test-name.js`.
- `tests-backend/test-backend-integration.js` — 51 checks that drive the
  real UI in a headless browser against `fake-supabase.js` (+
  `fake-razorpay.js` standing in for the real Checkout widget), a faithful
  in-memory reimplementation of the schema's RLS-equivalent scoping and RPC
  behavior. Covers signup, session persistence across reload, real-payment
  checkout (self-purchase and gift, plus both failure paths), gifting
  between two different real accounts, and self-service account deletion.

### `backend/`

- `sql/002_schema.sql` — every table, Row Level Security policy, and
  `SECURITY DEFINER` function (`record_test_purchase`, `redeem_gift_code`).
  Run once in a new Supabase project's SQL Editor.
- `sql/003_account_deletion.sql` — adds `delete_own_account()`, called from
  the app's Settings screen. Run after `002_schema.sql`.
- `sql/004_razorpay_payments.sql` — adds real Razorpay payment support
  (`razorpay_orders` table, `complete_razorpay_order()`), replacing the
  test-mode-only checkout. Run after `002_schema.sql` and
  `003_account_deletion.sql`.
- `supabase/functions/create-razorpay-order/`,
  `supabase/functions/verify-razorpay-payment/` — the two Edge Functions the
  live checkout calls. Deploy both via the Supabase dashboard (Edge
  Functions → Deploy a new function → Via Editor), and add
  `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` as Edge Function secrets.
- `sql/001_local_shim.sql` — stand-in `auth` schema for testing against a
  **local** Postgres only. Never run this against a real Supabase project.
- `tests/run-rls-tests.sh` — 41 checks run against a real local Postgres,
  as the actual `authenticated` role (not a superuser), simulating two
  separate accounts to prove the RLS policies really block cross-user
  access — plus a functional check (as the postgres superuser, standing in
  for `service_role`) that `complete_razorpay_order()` actually credits
  purchases/gifts correctly and idempotently.
- `tests/test-data-layer.js` — verifies every table/column/RPC/Edge Function
  name `supabase-client.js` calls matches the schema exactly.
- `SETUP.md` — the full story: what's been verified, what hasn't (and why —
  this sandbox has no network access to supabase.com or api.razorpay.com),
  and the exact steps to point a real Supabase + Razorpay project at this app.

### `docs/`

- `Astrology_App_Business_Plan.docx` — original product/business plan.

## Deploying a change

There's no CI/CD — this repo is deployed to
[nakshatra.ind.in](https://nakshatra.ind.in/) (GitHub Pages, custom domain
via the root `CNAME` file) by manually uploading the built file through
GitHub's web UI:

1. Make your change under `app/` (never edit `app/nakshatra-app.html` or the
   root `index.html` directly — they're generated).
2. From `app/`, run `node build.js` to regenerate `app/nakshatra-app.html`.
3. On GitHub, open this repo → **Add file → Upload files** → drag in the
   regenerated file, renamed to `index.html`, so it replaces the root
   `index.html` GitHub Pages actually serves. Commit directly to `main`.
4. GitHub Pages redeploys automatically, usually within a minute or two.

For a SQL migration or Edge Function change (like `004_razorpay_payments.sql`
and the two functions under `backend/supabase/functions/`), see
`backend/SETUP.md` — those go through the Supabase dashboard, not GitHub.

## Status

Real Supabase backend wired up and verified end-to-end (real signup, real
session persistence, real cross-account gifting, real account deletion).
**Live** at [nakshatra.ind.in](https://nakshatra.ind.in/), hosted on GitHub
Pages from this repo's root `index.html` (see "Deploying a change" below).
Currently **not** ready for a full public launch — see `backend/SETUP.md`'s
"What's left" section for the current punch list. As of this commit, the
short version:

- **Payment gateway** — real, Razorpay-backed checkout (one-time charges for
  all three tiers, self-purchase and gift). The frontend
  (`app/supabase-client.js`, `app/app.js`) and backend
  (`backend/sql/004_razorpay_payments.sql`,
  `backend/supabase/functions/create-razorpay-order/`,
  `backend/supabase/functions/verify-razorpay-payment/`) are both written and
  tested (see `backend/SETUP.md`), but **not yet deployed** — the SQL
  migration and the two Edge Functions still need to be applied to the real
  Supabase project, and a real Razorpay account/API keys still need to be
  created and added as Edge Function secrets, before checkout on the live
  site will actually work. Until that's done, clicking Pay on the live site
  will fail (the Edge Functions it calls don't exist yet on the backend).
- **Legal pages** — Privacy Policy and Terms of Service exist in-app
  (reachable from the landing page footer and Settings), with real contact
  details filled in, but are still an AI-drafted starting point — not yet
  reviewed by a lawyer, and not yet updated for the shift from test-mode to
  real payments.
- **Email confirmation** — currently off in Supabase Auth (for faster
  testing); should be turned back on before real public signups.
