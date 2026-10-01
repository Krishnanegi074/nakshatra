# Nakshatra — Project Checklist

Last updated: 2026-10-01

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
- [ ] **Deploy today's bug fixes to the live site.** Since Razorpay is
  confirmed live and taking real payments, the double-click-creates-
  duplicate-charges bug fixed in today's QA pass is very likely still
  active in production right now (`app/index.html` hasn't been rebuilt
  since before this fix) — this is the top priority now, ahead of any
  marketing push. Rebuild (`node build.js` from `app/`, confirm the beta
  banner is off), review, then push live the same way the last release was
  (see `ac32bba`'s approach / `deploy.sh`).

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
- [ ] Make the share card's star field deterministic (seeded) instead of random on every open, if a consistent image between opens matters.
- [ ] Double-check the chip icon badge colors in the card against the exact `--plum`/`--plum-light` tokens — looked slightly more saturated in one screenshot, may just be compression.
- [ ] Users who hit the `city_tz` save bug before the `006_city_timezone.sql` fix (applied 2026-09-30) have no saved chart and will need to redo onboarding once. Very low impact given the current user count, but worth knowing if anyone reports a "lost my chart" issue.
- [ ] Localize the "Couldn't verify your access — please try again" toast (currently a hardcoded English string in showScreen's paywall guard) — add proper keys to `I18N.en` and `I18N.hi` in `i18n.js` if/when it's worth translating a rare failure-path message.
- [ ] Consider automatic retry for a failed entitlements fetch. Right now, on failure the user just gets redirected to the dashboard with a toast — no retry happens on its own, they have to reload or renavigate to trigger a fresh `loadUserDataFromBackend()` call.
- [x] Review the Hindi strings added with the Today score and Current Dasha work (`e7a7c20`): `fr.section.today`, `fr.section.dasha`, `fr.dasha.mahadasha`, `fr.dasha.antardasha`, `fr.today-recovery`, `fr.dasha-recovery`, `fr.time-approx`, plus the "आज की रीडिंग, वर्तमान दशा" addition to the Hindi `content.hi-note` sentence. Reviewed 2026-09-30: grammar and astrological terminology (महादशा, अंतर्दशा, etc.) confirmed correct, and all consistent with existing phrasing in the app. Not a blocker any more.
- [ ] Optional: a true native-speaker fluency/naturalness pass over those same strings, for extra confidence. The review above was a careful check, not a certified native review, so this is nice-to-have rather than required. Changes would be one-line edits per key in `app/i18n.js`, then a rebuild and a redeploy of the release build (the strings are live).
- [ ] Decide how real experts are staffed and onboarded once there is more than one expert. Today there is exactly one ("Test Expert"), so this is deliberately deferred. Open questions for then: who the experts are and how each is added (an auth user plus a `public.experts` row, by hand for now), how experts keep their online/offline toggle honest (there is no presence check or session timeout, so an expert who leaves a tab "online" gets matched to paying customers), and that matching gives each expert one live session at a time.

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
