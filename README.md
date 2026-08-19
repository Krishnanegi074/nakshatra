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
- `tests-backend/test-backend-integration.js` — 49 checks that drive the
  real UI in a headless browser against `fake-supabase.js`, a faithful
  in-memory reimplementation of the schema's RLS-equivalent scoping and RPC
  behavior. Covers signup, session persistence across reload, gifting
  between two different real accounts, and self-service account deletion.

### `backend/`

- `sql/002_schema.sql` — every table, Row Level Security policy, and
  `SECURITY DEFINER` function (`record_test_purchase`, `redeem_gift_code`).
  Run once in a new Supabase project's SQL Editor.
- `sql/003_account_deletion.sql` — adds `delete_own_account()`, called from
  the app's Settings screen. Run after `002_schema.sql`.
- `sql/001_local_shim.sql` — stand-in `auth` schema for testing against a
  **local** Postgres only. Never run this against a real Supabase project.
- `tests/run-rls-tests.sh` — 34 checks run against a real local Postgres,
  as the actual `authenticated` role (not a superuser), simulating two
  separate accounts to prove the RLS policies really block cross-user access.
- `tests/test-data-layer.js` — verifies every table/column/RPC name
  `supabase-client.js` calls matches the schema exactly.
- `SETUP.md` — the full story: what's been verified, what hasn't (and why —
  this sandbox has no network access to supabase.com), and the exact steps
  to point a real Supabase project at this app.

### `docs/`

- `Astrology_App_Business_Plan.docx` — original product/business plan.

## Status

Real Supabase backend wired up and verified end-to-end (real signup, real
session persistence, real cross-account gifting, real account deletion).
Currently **not** ready for a public launch — see `backend/SETUP.md`'s
"What's left" section for the current punch list. As of this commit, the
short version:

- **Payment gateway** — checkout is test-mode only, no real gateway wired up yet.
- **Legal pages** — Privacy Policy and Terms of Service exist in-app
  (reachable from the landing page footer and Settings) but are an
  AI-drafted starting point, not yet reviewed by a lawyer.
- **Hosting** — the app is a single HTML file; it isn't deployed anywhere
  public yet.
- **Email confirmation** — currently off in Supabase Auth (for faster
  testing); should be turned back on before real public signups.
