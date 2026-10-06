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
- [ ] Make the app tests (`app/test-*.js`) refuse to run against production. Most
  of them sign up real accounts, and on a machine with internet they hit the
  production Supabase (a Mac run on 2026-10-06 created 13 junk `@example.com`
  accounts, since deleted). They should fail fast unless pointed at fakes or a scratch project.
- [ ] Test the heartbeat in a tab left in the background for a long time (browsers
  throttle timers; one gap of ~56s was seen, the stale limit is 2 minutes).
- [ ] A full end-to-end journey rehearsal: signup, onboarding, report purchase,
  expert checkout, chat, refund, as a customer and as the expert.

## Do now

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
  2026-09-30` filter — `guptasians.yash03@gmail.com` ("yash gupta"), and
  investigation showed it's not a beta tester. It's a real signup from
  2026-10-01 (after today's launch), with one saved chart and a single
  unpaid ₹399 report order (status `created`, no payment id — they tapped
  Buy and never completed checkout). Left alone; deleting would have cost a
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

- [x] Rotate the password on the expert test account (`krishnanegikdp@gmail.com`). Its session was still active during tonight's card preview testing, which is a sign it's overdue. Done 2026-09-30: new random password set, old one rejected, all sessions revoked, `EXPERT_PASSWORD` in `~/.nakshatra-realtime-test.env` updated (file also tightened to mode 600).

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
