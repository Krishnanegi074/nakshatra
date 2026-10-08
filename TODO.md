# Nakshatra — Project Checklist

Last updated: 2026-10-06

## Open after the 2026-10-06 expert presence/hours/alerts rollout

Migrations 014-016 are applied, `create-expert-session-order` is redeployed, and
the dashboard is live (`b559fa7`, then `b0f02d4`). The presence heartbeat and the
daily-hours rule were checked live; these items are still open.

- [ ] Step 5 alert test was only partly observed: the chime and the "(1) New
  session" tab-title badge were **not observed** (not a pass, not a fail). Rerun
  it with the dashboard tab hidden behind another Chrome tab, and again with
  Chrome behind another app.
- [ ] The pop-up focus rule (`b0f02d4`: show the pop-up unless the tab is visible
  AND the window is focused) is pushed but **not tested live**.
- [ ] Unexplained expert on/off flips: on 2026-10-06 `experts.is_online` flipped
  back to false within seconds of the expert toggling Online (10:11, 10:25 and
  10:35 IST, and once at 10:44). Not caused by my scripts or by any code other than
  the dashboard's toggle. Later clean attempts did not reproduce it. Cause unknown.
  If it recurs, add a temporary write-log trigger on `public.experts` (old/new
  `is_online`, `auth.uid()`, user-agent, origin) to see who writes. Matters before
  real experts go live, because a stuck-online expert on live keys can take real money.
- [x] Make the app tests refuse to run against production — built 2026-10-06 (local commits, see
  `backend/SETUP.md`, "Running the app tests"): `app/test-guard.js` (`launchGuarded`) blocks every
  non-local hostname for all 18 browser-driven files, `app/test-guard-selftest.js` proves it on the machine
  (passed 9/9 on the owner's Mac, including the production REST host, the realtime WebSocket and Razorpay),
  `app/run-tests.js` lints, runs the self-test first, then the tests, and the two scripts that deliberately write
  to production need `CONFIRM_PRODUCTION=yes` (never set it automatically). Playwright is not a repo
  dependency: reuse `~/comet-karts/node_modules` through `NODE_PATH`.
- [ ] `app/tests-backend/test-backend-integration.js` has a **pre-existing failing check**: "Exactly one palm_reports row
  exists after generating" (then a TypeError). It fails identically on `ac32bba` (the previous live release), on `b015b43`
  and on current `main`, so it is a stale test, not a regression and not caused by the guard: it clicks the first option in
  every palm option grid and then "Generate", but Generate stays disabled until the photo-scan flow has enabled it (the palm
  CV feature came after this test was last updated, 2026-09-22). Fix the test, not the app.
- [x] First guarded run on the owner's Mac, 2026-10-06: 19 of 20 files clean (the 20th is the stale test above). `test-astro-chat`
  and `test-final` first failed only because they ignored just the sandbox's `ERR_TUNNEL_CONNECTION_FAILED` console error and the
  guard produces `ERR_NAME_NOT_RESOLVED`; their filters were widened. `test-e2e-comprehensive` and `test-final` each timed out once
  in a later full run (this Mac was slow) and passed alone in their normal time (64s and 24s). Production counts and content hashes
  (16 tables + auth users) were identical before and after every run.
- [ ] RLS test cases not run: `backend/tests/test-rls.js` needs a local Postgres (`nakshatra_test`) and this Mac has none
  (no Postgres, Docker or Homebrew), so Group 9 and the two new 018 cases are **written but not run** (decision: option C).
  Run them wherever a scratch Postgres exists (the original sandbox), or install Postgres later. Live evidence for 018:
  the constraint exists and is validated in production, and its pattern passed 21/21 edge cases in the SQL Editor.
- [ ] Test the heartbeat in a tab left in the background for a long time (browsers
  throttle timers; one gap of ~56s was seen, the stale limit is 2 minutes).
- [ ] A full end-to-end journey rehearsal: signup, onboarding, report purchase,
  expert checkout, chat, refund, as a customer and as the expert.

## Monthly expert earnings report

- [x] Written and tested locally (2026-10-06): `backend/scripts/expert-earnings-report.js` and
  `backend/tests/test-earnings-report.js` (40 checks, fake API only). How to run it and the
  counting rules are in `backend/SETUP.md`. Not run against production yet.
- [ ] Before the first real run: create `~/Documents/nakshatra-reports/config.json` with each
  expert's share rate (no default, payouts stay blank until set) and the user ids of your own test
  accounts (the owner's account id, for the rehearsal payments). The owner decides when to run it.
- [ ] Known limits: gross only (no Razorpay/Google fees or GST), `razorpay_orders` stores no payment
  id (reconcile by order id in the Razorpay dashboard), a Play `manual` refund is never marked done in
  the ledger so it stays held back until someone settles it, and a past month's numbers can change if a
  refund lands later (each report carries an "as of" time).

## Paused: full journey rehearsal with two real ₹199 payments

Paused on 2026-10-06 after step 0; to be done in the owner's free time. It uses the
LIVE Razorpay keys and the owner's own money, so nothing runs until the owner says go.
Step 0 was clean on 2026-10-06 (expert offline, 0 sessions, empty refund ledger, 3
unpaid report orders, 5 users, sweep returns all zeros).

Setup and costs:
- Customer = the owner's account in an **incognito window** (a fresh browser
  profile). Expert = the owner's expert test account in a normal Chrome window. No new accounts.
- ₹199 per payment. Payment 1 (answered) is not auto-refunded: keep it or refund it by
  hand in the Razorpay dashboard. Payment 2 (silent) should be refunded by the sweep.
  Razorpay keeps its fee (a few rupees each); the refund is `speed: normal`, 5-7 working days.
- The live customer app is still the `ed02b8f624` release build, so the customer will NOT
  see the "you've been refunded" chat message (source-only). The expert dashboard notice is live.
- The sweep is not scheduled; call it by hand with `SWEEP_SECRET` (in
  `~/.nakshatra-realtime-test.env`) after the 5-minute grace.
- Hours are optional (skipped): the expert has none and is matched whenever online. If wanted:
  `update public.experts set hours_start='00:00', hours_end='23:59' where name='Test Expert';`
  and reset with both set to null. Times are IST.

Steps (what the owner does, what Claude checks in the database):
- [ ] **0. Pre-flight (Claude).** Expert offline, 0 active sessions, empty ledger, sweep
  returns `{"claimed":0,...}`. Start the read-only watcher.
- [ ] **1. Expert online (owner).** Open `/expert/`, hard-refresh, sign in, click **Enable
  alerts**, toggle Online ONCE. Check: `is_online` true, `last_seen` refreshing about every 30s,
  `experts_public` online.
- [ ] **2. Customer buys session 1 (owner, incognito).** Sign in, Talk to a Real Expert, Pay &
  Connect ₹199, pay once, land in the chat. Check: one `expert_session` order `verified` with a
  payment id, one `chat_sessions` row `active` for 19900, no ledger row.
- [ ] **3. Expert sees the customer (owner).** Session listed with the customer's name. Owner
  observes and reports: **did the chime play (about every 6s)?, did the tab title show "(1) New
  session"?, did the pop-up appear?** These alerts, and the pop-up focus rule `b0f02d4`, have
  never been observed live. Test with the dashboard tab hidden behind another Chrome tab, and
  again with Chrome behind another app.
- [ ] **4. Messages both ways (owner).** Customer and expert exchange 3-4 messages each; reload
  the customer tab; all messages return once, in order. Check: `chat_messages` has `user` and
  `astro` rows, no duplicates.
- [ ] **5. Expert ends session 1 (owner).** Click End Session. Check: session `ended`,
  `ended_reason` empty (not `expert_silent`), no ledger row. Owner reports whether the
  customer's chat locked.
- [ ] **6. Session 2, the silent one (owner).** Customer buys again (expert must be free),
  sends exactly ONE message, the expert does NOT reply or end it. Check: second order
  `verified`, second session `active`, note the customer message's time (grace counts from it).
- [ ] **7. Sweep (Claude), about 6 minutes after the message.** Call the sweep. Expect
  `claimed:1, refunded:1`; session `ended` with `expert_silent`; ledger `refunded` with a
  Razorpay `refund_id`. Owner reports **what the customer screen shows after the sweep** and
  whether the expert dashboard shows the red refund notice; also check the refund in the
  Razorpay dashboard. If `retrying`/`failed`, stop and read `last_error`.
- [ ] **8. Wrap up.** Owner toggles the expert Offline (and resets hours if set). Check: expert
  offline, 0 active sessions, 2 paid orders, 2 ended sessions, 1 refunded ledger row. Do NOT
  delete these rows (real payment records). Then record results here and decide on scheduling the sweep.

Stop if: a step doesn't match, the expert flips offline unexpectedly (record the time; don't repeat
the payment), or a payment is captured with no session (verify should auto-refund; check the ledger
and Razorpay).

## Added 2026-10-06 (later): migration gaps, sweep, and working rules

Done:
- [x] Migrations **013** (Google Play Billing) and **007** (`kundli_waitlist`) were
  never applied to production. Found because the silent-expert sweep failed with
  `column cs.play_purchase_token does not exist` (016 needs 013), then confirmed by
  checking every table/view/column/function in 002-016 against the live API. Both
  are now applied. Only trigger functions (`handle_new_user`,
  `broadcast_chat_message`) don't show in that API check, and both work. Until 007
  was applied the Kundli matching "Join the Waitlist" form had been failing.
- [x] Silent-expert sweep: `SWEEP_SECRET` set, `sweep-silent-expert-sessions`
  deployed with Verify JWT OFF, answers 401 without/with a wrong secret. A
  ₹0 fake session was claimed correctly (ended, `expert_silent`, ledger `manual`,
  no refund attempted) and cleaned up.
- [x] `017_lock_down_gift_and_delete.sql` applied: `redeem_gift_code(text)` and
  `delete_own_account()` are now `false/true/true` for anon/authenticated/service_role.
  A privilege check of all SECURITY DEFINER functions showed every payment,
  entitlement, refund and Play function at `false/false/true`.

Open:
- [ ] **Schedule the sweep** (`optional_schedule_silent_sweep.sql`, step 6e): not done.
  It needs the real secret pasted in (never commit that edit). Until it runs, silent
  sessions are NOT auto-refunded. The Razorpay refund call itself is still untested
  (the ₹0 test had no payment behind it); only a real silent ₹199 session, or the
  optional paid test, exercises it.
- [ ] Fix the next-steps checklist: a ₹0 sweep test returns
  `{"claimed":1,"refunded":0,"manual":0,...}`, not `"manual":1`. With no Razorpay
  order the claim function inserts the ledger row as `manual` straight away, and the
  function's `manual` counter only counts rows it later leases. The ledger row
  being `manual` is the correct end state. (`~/Desktop/nakshatra-next-steps.md` still says `manual:1`.)
- [ ] (see the next item for status) Add an email-format check to `kundli_waitlist`: an anonymous insert of
  `email = "x"` was accepted (a junk row was created by a test and deleted). Anon
  insert is open by design (`with check (true)`); a `check (email ~* ...)` or similar would stop garbage.
- [ ] **`kundli_waitlist` email check, written but not applied or pushed.** Local commits:
  `018_kundli_waitlist_email_check.sql`, the form change in `kundli-waitlist.js`, and two
  tests. Apply 018 in the SQL Editor first (the table has 0 rows, so it validates instantly;
  test the pattern beforehand with the select-only query at the bottom of the 018 file), then
  push the form change. **The two new test cases (`test-kundli-waitlist.js`: "a@b" is stopped
  and a forced 23514 shows the friendly message; `backend/tests/test-rls.js` Group 9: bad
  address rejected, good one accepted) have NOT been run.** They must wait for the production
  guard on the tests (the "Make the app tests refuse to run against production" item): `test-kundli-waitlist.js`'s first run loads the real
  supabase-js when the machine has internet and would talk to production, and the RLS test needs
  018 loaded into the scratch Postgres.
- [ ] Google Play sessions: they have no Razorpay order, so `claim_silent_expert_sessions`
  queues them as `manual` at claim time (they never get an automatic refund and
  the sweep summary shows `manual:0` for them). Someone has to refund them in Play
  Console; list `status = 'manual'` rows in `expert_session_refunds` regularly.
- [ ] Working rule: **ask before creating accounts, or any other rows, in production**
  (including throwaway/test ones and "just a quick probe" inserts). Tests that touch
  Supabase should use fakes or a scratch project. If a production probe is
  unavoidable, get approval first, use obviously-named accounts, and delete them by id
  right after. (This rule exists because a test run created 13 junk accounts and a
  probe wrote a junk `kundli_waitlist` row on 2026-10-06.)

## Do now

- [ ] Working rule: **this repo is public, so notes never contain a real name or email address.** Write "a real customer",
  "the owner" or "the expert test account", never the person's name or email (this applies to `TODO.md`, `SETUP.md`, SQL comments,
  tests, scripts and commit messages). Keep real addresses in `~/.nakshatra-realtime-test.env` or other files outside the repo.
  (On 2026-10-06 a customer's email and name, and the owner's and expert's addresses, had to be removed from the current files;
  they remain in earlier commits of the public history.)
- [ ] Small check script that scans the tracked files for email addresses and fails on any that is not on a short allow-list:
  `support@nakshatra.ind.in`, `@example.*` (and obvious placeholders like `a@b.com`), and the library licence notice inside the
  bundled astronomy library (a third-party author's address in its MIT header). **Not built yet.** Idea: `backend/scripts/check-no-emails.js`,
  run before pushing (and from `app/run-tests.js`); it prints file and line but masks the address.
- [x] ~~Commit today's uncommitted work~~ — done: Google Play Billing
  integration is `b015b43`, the 2026-10-01 QA pass's 8 bug fixes are
  `2df6689`. Both are local commits on `main`, not yet pushed (see the
  "Deploy today's bug fixes to the live site" item below).
- [x] ~~Resolve whether the real Razorpay backend is actually deployed~~ —
  confirmed 2026-10-01 via the Supabase dashboard: all 4 Edge Functions
  (`create-razorpay-order`, `verify-razorpay-payment`,
  `create-expert-session-order`, `verify-expert-session-payment`) are
  deployed, and `razorpay_orders` exists in the Table Editor. `SETUP.md`'s
  "Real payments (Razorpay)" section was stale — corrected.
- [x] **Deploy today's bug fixes to the live site** — full release build
  from `main`, committed 2026-10-01: expert chat live for the first time,
  Play Billing code (inert on web) and the 8 QA fixes including the
  double-click-Pay duplicate-order fix. Expert functions switch from test
  to live Razorpay keys by deleting `EXPERT_RAZORPAY_KEY_ID`/`_SECRET`.
- [x] ~~Take down the private-beta page `/beta-596f52e8ed16/` (and point
  the `~/Documents/nakshatra-app` wrapper back to `/app/`)~~ — done 2026-10-01:
  beta folder removed from the live site in commit `73a42fb` (now 404s), and
  the wrapper's `capacitor.config.json` points to `https://nakshatra.ind.in/app/`.
  Rebuilt with `npx cap sync android && ./gradlew clean assembleDebug` —
  working APK at `~/Desktop/nakshatra-app-live.apk` (debug build, loads the
  live app). It has no purchase plugin installed, so Play Billing shows
  "payments aren't available in this build" rather than taking real money —
  fine for a test wrapper, but means it can't be used to test real purchases.
- [x] ~~Delete stale beta signups with `backend/scripts/beta-cleanup.js`~~ —
  ran as a dry run 2026-10-01: 5 users total, only 1 matched the `--since
  2026-09-30` filter — a real customer, and investigation showed they
  are not a beta tester (a real public signup from 2026-10-01, after
  launch). Left alone; deleting would have cost a
  real person their account and chart for no reason. No `--yes` run was
  needed — there was nothing left to clean up. Note for later: the
  `--since 2026-09-30` cutoff is now stale for distinguishing beta testers
  from real users, since real public signups started the same day — don't
  reuse it as-is for a future cleanup pass.

- [x] Card redesign, engine additions (Moon Nakshatra/Pada/Dasha), the full
  reading screen (Today score, Current Dasha, Year Ahead, Compatibility),
  and the "Talk to our experts" CTA — all previously listed here as
  pending, all discovered already done, committed, and deployed to the live
  site (`60be2a6`, `1bce56a`, `771885a`, `ac32bba` and others) during a
  2026-10-01 review. This section had simply never been updated after that
  work shipped.

- [x] Rotate the password on the expert test account (the owner's). Its session was still active during tonight's card preview testing, which is a sign it's overdue. Done 2026-09-30: new random password set, old one rejected, all sessions revoked, `EXPERT_PASSWORD` in `~/.nakshatra-realtime-test.env` updated (file also tightened to mode 600).

## Backlog — no urgency

- [x] ~~Deploy `create-expert-session-order` and `verify-expert-session-payment` Edge Functions for the first time~~ — confirmed deployed (2026-10-01 check), this item was stale.
- [ ] Run one test-mode expert payment to confirm that flow works end to end (still worth doing as a sanity check even though the functions are deployed).
- [x] ~~Refresh root `index.html` from the app build and push it live — deliberately deferred~~ — superseded: this is no longer deferred, it's the "Deploy today's bug fixes to the live site" item above (now in progress via a Claude Code deployment prompt, 2026-10-01).
- [x] Fuller security audit beyond the `012_lock_down_functions.sql` fix — done 2026-10-01: read through every RLS policy/view/SECURITY DEFINER function in `backend/sql/`, all 6 Edge Functions, and the client-side auth code (session handling, password reset, account deletion). Found and fixed one critical issue (see below); everything else checked out solid — proper RLS on every table, the 3 RLS-less views are all narrowly scoped and safe, Razorpay signature verification is done correctly (constant-time compare + a defense-in-depth API check), every privileged function is service-role-only or correctly uses `auth.uid()`. One remaining manual step: the Supabase Auth dashboard settings (JWT expiry, leaked-password protection, rate limiting) can't be checked from here — see the checklist in the audit report.
  - **Fixed: privilege-escalation gap in the unapplied `013_google_play_billing.sql`.** `complete_play_report_purchase()`/`complete_play_expert_session_order()` only revoked EXECUTE `from public`, not also `from anon, authenticated` — the exact gap `012_lock_down_functions.sql` fixed for the Razorpay-era functions. Not exploitable in production (this migration was never applied — it's still on the Play Billing deployment checklist), but would have been a real "grant myself a free unlock" bug the moment it was deployed. Fixed in the source file; see `backend/SETUP.md`'s Play Billing section.
- [x] ~~Make the share card's star field deterministic~~ — done 2026-10-05 in `app/app.js`: `drawShareCard()` now uses a seeded PRNG (`seededRandom()`), seeded by the user's email + today's date, so re-opening/re-sharing the same day's card looks identical (different per user and per day). `drawGiftCard()` still uses `Math.random()` — not in scope, same tweak if wanted. Source edit only; not in a release build yet.
- [x] ~~Double-check the chip icon badge colors~~ — checked 2026-10-05, no bug. The share card's canvas token `plumLight` is `#9b7ec0`, identical to `--plum-light` in `app.css`; the placement chips don't use plum at all (icons are `goldBright`, fill/border are translucent white/gold). The purple tint seen in the screenshot is just the translucent chips sitting on the navy/purple gradient.
- [ ] Users who hit the `city_tz` save bug before the `006_city_timezone.sql` fix (applied 2026-09-30) have no saved chart and will need to redo onboarding once. Very low impact given the current user count, but worth knowing if anyone reports a "lost my chart" issue.
- [x] ~~Localize the "Couldn't verify your access" toast~~ — done 2026-10-05: new key `paywall.toast.verify-failed` in `I18N.en`/`I18N.hi` (`app/i18n.js`), used by `showScreen()`'s paywall guard in `app/app.js`. Hindi wording mirrors the sibling `expert.toast.check-failed` phrasing; not native-reviewed. Source edit only; not in a release build yet.
- [x] ~~Automatic retry for a failed entitlements fetch~~ — done 2026-10-05 in `app/app.js`: when `loadUserDataFromBackend()` sees an entitlements error it schedules ONE background retry (`scheduleEntitlementsRetry()`, ~1.8s later, entitlements only) so a transient blip heals without a reload. If the retry also fails, the existing toast+redirect guard still applies. Source edit only; not in a release build yet.
- [x] Review the Hindi strings added with the Today score and Current Dasha work (`e7a7c20`): `fr.section.today`, `fr.section.dasha`, `fr.dasha.mahadasha`, `fr.dasha.antardasha`, `fr.today-recovery`, `fr.dasha-recovery`, `fr.time-approx`, plus the "आज की रीडिंग, वर्तमान दशा" addition to the Hindi `content.hi-note` sentence. Reviewed 2026-09-30: grammar and astrological terminology (महादशा, अंतर्दशा, etc.) confirmed correct, and all consistent with existing phrasing in the app. Not a blocker any more.
- [ ] Optional: a true native-speaker fluency/naturalness pass over those same strings, for extra confidence. The review above was a careful check, not a certified native review, so this is nice-to-have rather than required. Changes would be one-line edits per key in `app/i18n.js`, then a rebuild and a redeploy of the release build (the strings are live).
- [ ] Hindi review list: the Kundli waitlist form's new validation message, "That doesn't
  look like a valid email address — please check it and try again." (`kundli-waitlist.js`,
  shown for a malformed or database-rejected address). It is English-only for now, like every
  other message in that form (success, already-on-the-list, "Something went wrong"); there is
  no Hindi version of the waitlist messages yet. Translate and review all of them together
  if/when the form gets Hindi, via `marketing-i18n.js`.
- [ ] **Hindi review workbook** (built 2026-10-08, outside the repo in `~/Documents/nakshatra-reports/hindi-review/`:
  `nakshatra-hindi-review.xlsx`, 25 tabs, and `nakshatra-hindi-legal-review.xlsx`, 6 tabs, legal text marked
  "needs legal review"). Open points:
  1. **The apply script is not written yet.** It must apply only rows marked OK or change (blank and unsure rows are left
     alone: existing Hindi stays, missing Hindi stays English), check that `{placeholders}` and `<tags>` still match the
     English and that the text is Devanagari, and show a diff before touching `app/i18n.js` or `marketing-i18n.js`.
  2. **The share card needs a Devanagari-capable font.** Check by rendering the card in Hindi before any release (the text
     drawn with `fillText` in `app/app.js`).
  3. **"A MESSAGE FROM {name}"** (gift card) needs a small code change for Hindi word order: the Hindi is "{name} की ओर से
     संदेश", so the name comes first.
  4. **The "turned off in the private beta" toast** (`app/app.js`) is probably dead, since the beta build was removed, and
     doesn't need Hindi. Confirm and remove it.
  5. **The 10 technical server messages stay English** (for example "POST only", "Unauthorized.", "Unknown tier."). They have no
     draft in the workbook.
  6. **Toasts and server messages need a separate wiring step.** Only the workbook text exists; the code still shows English
     until each message is mapped to a dictionary key (the server messages need error codes or a mapping on the client).
  7. **The drafts are unreviewed.** The 95 drafts on the "No Hindi yet" tab were written by Claude and are marked "draft, not
     reviewed". Nothing from the workbook goes live until a reviewer marks it OK or change.
- [x] ~~Daily hours for experts~~ — built 2026-10-05, **not applied yet**: `backend/sql/015_expert_hours.sql` (`experts.hours_start/hours_end`, India time, admin-set only; matching, the `experts_public` view and the `create-expert-session-order` pre-check all require being inside the window; no hours = old behaviour), customer message "No experts online right now. Our experts are available 6 pm – 10 pm IST." (`app/app.js` `noExpertsOnlineMessage()`, en + hi; source only until the next release build), and an hours note on the expert dashboard. Needs: run 014 then 015 in Supabase, redeploy the edge function, push (see `~/Desktop/nakshatra-next-steps.md`). Tested against a scratch Postgres plus headless-browser checks.
- [x] ~~New-session alert on the expert dashboard~~ — built 2026-10-05 in `expert/index.html` (+ `www/` mirror): repeating chime until the session is opened, browser notification while the tab is hidden, "(n)" tab-title badge. Goes live with the next push. Limits: needs the dashboard tab open (no push when closed), and sound needs one click after a page reload (the status line says so).
- [x] ~~Auto-end and refund when a matched expert never replies~~ — built 2026-10-06, **not applied yet**: `backend/sql/016_silent_expert_refund.sql`, edge function `sweep-silent-expert-sessions` (Razorpay refund, retries, Google Play sessions flagged `manual`), scheduling file `backend/sql/optional_schedule_silent_sweep.sql`, a refund explanation in the customer chat (en + hi; source only until the next release build) and a notice on the expert dashboard. Rule: customer's first message older than 5 minutes with no expert reply -> session ended + refunded. Needs: run 016, set the `SWEEP_SECRET` secret, deploy the function with Verify JWT OFF, schedule it, push (see `~/Desktop/nakshatra-next-steps.md` step 6 and `backend/SETUP.md` section 016). Not covered: customer who never wrote; expert who replied once then went quiet.
- [ ] Expert onboarding build-out, remaining items from the 2026-10-05 plan (`nakshatra-expert-onboarding-plan.md`): (4) monthly earnings report script (sessions per expert per month), (5) one-command `add-expert` script (auth user + `public.experts` row + hours). Experts' hours today are set by hand in SQL.
- [ ] Decide how real experts are staffed and onboarded once there is more than one expert. Today there is exactly one ("Test Expert"), so this is deliberately deferred. Open questions for then: who the experts are and how each is added (an auth user plus a `public.experts` row, by hand for now), how experts keep their online/offline toggle honest (there is no presence check or session timeout, so an expert who leaves a tab "online" gets matched to paying customers), and that matching gives each expert one live session at a time. **Update 2026-10-05:** the "toggle stays online forever" gap is fixed in commit `73c361c` (`last_seen_at` heartbeat, migration `014_expert_presence.sql`) — but that commit is NOT applied yet: it still needs the SQL run in Supabase, the `create-expert-session-order` edge function redeployed, and a push. The staffing question itself (who, how added) is unchanged.

## Done 2026-10-01 — full QA pass across app + website

- Integrated Google Play Billing for the Android app's paid features (the real, Play-policy-compliant fix): `@capgo/native-purchases` client plugin, two new edge functions (`verify-play-report-purchase`, `verify-play-expert-session-purchase`), SQL migration `013_google_play_billing.sql`, Android manifest billing permission. Razorpay still used on web/iOS; Android branches to Play Billing automatically via `isNativeApp()`. Deployment checklist (service account, 4 Play Console products, edge function secrets, License Tester) is documented in `backend/SETUP.md` but not yet done on the actual Google/Supabase accounts — see Backlog below.
- Ran the full 16-file Playwright suite (every `test-*.js` in `app/`) end to end. Found and fixed 4 issues:
  - `test-astro-chat.js`, `test-i18n.js`, `test-e2e-comprehensive.js`: all three were test-script issues, not product bugs (missing console-error filter; a since-moved language toggle at mobile viewport; the paywall guard added later blocking a test's path to the full report). Fixed in place.
  - `test-community.js`: uncovered a **real product bug**. `refreshCommunityFeed()` in `app.js` only ever added entries to `state.communityLikes`, never cleared stale ones — so after a real/fake backend is configured, a second person logging into the same browser session would inherit the first person's "liked" heart + an inflated like count on posts they'd never touched. Fixed by resetting `state.communityLikes` from the backend's `liked_by_me` flags on every refresh instead of merging into whatever was already there. All 19 checks in `test-community.js` now pass (was 18/19, with the 1 failure being this exact bug).
  - All 16 test files now pass with exit code 0 (116+ checks total).
- Rebuilt `www/index.html` (the Android app bundle) from current source so it includes both today's Play Billing code and the community-likes fix.

## Done 2026-10-01 (continued) — exploratory QA + fixes from 2 testers

Ran two parallel exploratory-QA passes (beyond the automated suite) covering onboarding, purchase/gift, settings, i18n, palm/CV upload, expert chat, community, and a code review of the Play Billing native branch. Found and fixed 8 real issues, all re-verified with the full 16-file suite (clean) plus 28 new targeted regression checks written specifically to prove each fix (`app/verify-fixes.js`, kept in the repo for next time):

- **Double-clicking "Pay" created duplicate Razorpay orders/charges** (critical) — the submit button was re-enabled right after order creation, before the Razorpay popup even opened, leaving a window for a fast double-click to start two independent orders for one tap. Fixed in both `initCheckout()` and `initExpertChat()`: the button now stays disabled through the whole popup lifecycle (including a user-dismissed-without-paying case via `modal.ondismiss`), and `renderCheckout()`/the expert-paywall entry point now explicitly reset it so a *separate*, later purchase isn't left permanently disabled.
- **No hardware/gesture Android back button handling** (major, Android-release-blocking) — the app never used the History API, so Capacitor's default back-button behavior would exit (or blank) the app on the very first press from ANY screen. Added `initAndroidBackButton()`, which closes an open sheet, defers to onboarding's own back button, reuses whatever `[data-back]` control the active screen has, and only exits the app when none of those apply (home screens). **Needs the `@capacitor/app` plugin installed + `npx cap sync android`** to take effect on device — it's a safe no-op without it, but doesn't do anything either; check `package.json`/`npx cap doctor` on the Android build.
- **Choosing a different palm photo didn't clear the previous photo's scan results** (major, data-integrity) — stale option selections, "Scanned NN%" tags, and finger-position labels stayed visible (at the OLD photo's coordinates) on the new photo, and Generate stayed enabled, so a report could be built from a different photo than the one actually scanned. Fixed in `#btn-palm-change-photo`'s handler.
- **"Post to Community" had no duplicate-submit guard** (major) — a near-simultaneous second tap could create two posts for one share. Fixed with the same disabled-button pattern as the pay buttons.
- **Gift recipient name / signup name had no length limit** — a very long name overflowed off-screen on the checkout summary and gift-sent confirmation (unreadable), and broke the dashboard topbar layout (icon row pushed down). Added `maxlength="60"` to both fields plus defensive CSS (`min-width:0`/ellipsis/word-break) so even a name from before this fix degrades gracefully instead of overflowing.
- **Hindi i18n gaps** — community feed relative timestamps ("2h ago" etc.) and the 3 astrologers' specialty labels/taglines were hardcoded English regardless of selected language. Added proper `I18N.en`/`I18N.hi` keys for both.
- **"Enable Notifications" gave no feedback while the permission prompt was pending** — button stayed clickable, status text didn't change. Now disables immediately and shows a "Requesting…" status.
- A regression in TODAY's own earlier community-likes fix: the blanket `state.communityLikes = {}` reset also wiped SEED-post likes on every single community-screen visit (not just across a login switch) — a same-session like on a seed post silently reverted on next visit. Fixed by scoping the reset to only the post ids the backend actually tracks, leaving seed-post likes (which are deliberately local-only/persistent) untouched.

Also reviewed and found solid (no changes needed): the Play Billing native branch's web-fallback path (no dead code, falls through to Razorpay correctly when not native), its error handling (catches all errors, friendly fallback message, explicit check for a missing purchaseToken) — though cancellation-specific messaging and the beta-kill-switch asymmetry (native purchases aren't blocked by `NAKSHATRA_BETA`, only web ones are) are worth a product decision, not obviously bugs; CV upload edge cases (huge/tiny/odd-aspect-ratio images, corrupt files, GIF/BMP); expert chat (topic classification, XSS-safe message rendering, rapid-send protection, cross-login isolation, same-user history restore); and account deletion flow (reset-on-cancel, double-click safety).

## Backlog — still pending from this QA pass

- [ ] Google Play Billing deployment checklist (service account creation, 4 Play Console product IDs/prices, 2 edge function secrets, License Tester setup) — fully documented in `backend/SETUP.md`, not yet done on the real accounts.
- [ ] Broader exploratory QA (beyond the automated suite) — in progress, see next session notes / chat for findings.

## Done tonight (2026-09-30), for reference

- Legacy Supabase API keys fully rotated and disabled; new key system validated end to end.
- Critical vulnerability fixed: four SECURITY DEFINER functions were callable by any authenticated user, allowing free paid-tier access — fixed in `backend/sql/012_lock_down_functions.sql`, committed and pushed as `8a4b5db`.
- Production bug fixed: `birth_data.city_tz` column was missing (migration 006 never applied), silently breaking chart saves for every new signup — applied via SQL Editor, verified end to end including RLS.
- Card redesign fully designed (competitive research, three directions, final direction chosen and refined to real brand fonts/colors) and implemented in the canvas-based `drawShareCard()`.
- Fixed a paywall bypass: the bottom-nav Report tab reached screen-fullreport with no entitlement check. Added a single guard in showScreen() covering every path in, plus entitlementsLoadFailed tracking so a failed entitlements fetch doesn't send a paying user toward checkout.
