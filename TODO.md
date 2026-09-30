# Nakshatra — Project Checklist

Last updated: 2026-09-30

## Do now

- [ ] Commit tonight's work as two separate commits:
  1. Engine additions: Moon Nakshatra + Pada (`getMoonNakshatra`, `getMoonSiderealLongitude`, `getNakshatraFromLongitude` in `engine.js`/`engine.browser.js`), birth Venus/Mars placements (`venusIdx`/`marsIdx` via `getTransitingSign`), Vimshottari Dasha (`getVimshottariDasha`). All verified against hand math and the Wikipedia reference table for lord years and nakshatra-lord mapping.
  2. Card redesign: `drawShareCard()` rewrite in `app.js` (5-chip placement row, Moon Nakshatra hero panel, insight line from `generateWeeklyHoroscope(...).paragraphs[0]`, ring-style love-energy metric), plus the font-loading fix (`document.fonts.load` + async gating on Download/Post to Community), the Google Fonts italic Poppins addition in `index.template.html`, and the love-energy blurb overflow fix. Verified via mock canvas and a real browser screenshot.
  - Nothing here touches root `index.html` or `app/index.html` — both stay as they were left earlier tonight (deliberately not pushed live).

- [x] Rotate the password on the expert test account (`krishnanegikdp@gmail.com`). Its session was still active during tonight's card preview testing, which is a sign it's overdue. Done 2026-09-30: new random password set, old one rejected, all sessions revoked, `EXPERT_PASSWORD` in `~/.nakshatra-realtime-test.env` updated (file also tightened to mode 600).

## Soon

- [ ] Fix the two Playwright tests that reference the old share card (`test-community.js`, `test-e2e-comprehensive.js`) — they likely assert on the old "Cosmic Snapshot" title and assume Download/Post to Community are enabled immediately, both of which changed tonight.
- [ ] Build the full reading screen for real: Today score, Current Dasha (Mahadasha/Antardasha), Year Ahead, Compatibility. Design approved — see the mockup discussed this session.
- [ ] Build the "Talk to our experts" CTA and birth-details consent sheet (Name/DOB/Time/Place shown for explicit opt-in before connecting) below the Compatibility section on the full reading screen. Wire it to the existing `chat_sessions` infrastructure — expert always sees the user's name even if birth details aren't shared (confirmed decision).

## Backlog — no urgency

- [ ] Deploy `create-expert-session-order` and `verify-expert-session-payment` Edge Functions for the first time (code already updated for the new key system, never deployed).
- [ ] Run one test-mode expert payment to confirm that flow works end to end.
- [ ] Refresh root `index.html` from the app build and push it live — deliberately deferred, no reason to revisit yet.
- [ ] Fuller security audit beyond the `012_lock_down_functions.sql` fix: auth settings in the Supabase dashboard, payment traceability, a read-through of the auth code.
- [ ] Make the share card's star field deterministic (seeded) instead of random on every open, if a consistent image between opens matters.
- [ ] Double-check the chip icon badge colors in the card against the exact `--plum`/`--plum-light` tokens — looked slightly more saturated in one screenshot, may just be compression.
- [ ] Users who hit the `city_tz` save bug before the `006_city_timezone.sql` fix (applied 2026-09-30) have no saved chart and will need to redo onboarding once. Very low impact given the current user count, but worth knowing if anyone reports a "lost my chart" issue.
- [ ] Localize the "Couldn't verify your access — please try again" toast (currently a hardcoded English string in showScreen's paywall guard) — add proper keys to `I18N.en` and `I18N.hi` in `i18n.js` if/when it's worth translating a rare failure-path message.
- [ ] Consider automatic retry for a failed entitlements fetch. Right now, on failure the user just gets redirected to the dashboard with a toast — no retry happens on its own, they have to reload or renavigate to trigger a fresh `loadUserDataFromBackend()` call.
- [x] Review the Hindi strings added with the Today score and Current Dasha work (`e7a7c20`): `fr.section.today`, `fr.section.dasha`, `fr.dasha.mahadasha`, `fr.dasha.antardasha`, `fr.today-recovery`, `fr.dasha-recovery`, `fr.time-approx`, plus the "आज की रीडिंग, वर्तमान दशा" addition to the Hindi `content.hi-note` sentence. Reviewed 2026-09-30: grammar and astrological terminology (महादशा, अंतर्दशा, etc.) confirmed correct, and all consistent with existing phrasing in the app. Not a blocker any more.
- [ ] Optional: a true native-speaker fluency/naturalness pass over those same strings, for extra confidence. The review above was a careful check, not a certified native review, so this is nice-to-have rather than required. Changes would be one-line edits per key in `app/i18n.js`, then a rebuild and a redeploy of the release build (the strings are live).
- [ ] Decide how real experts are staffed and onboarded once there is more than one expert. Today there is exactly one ("Test Expert"), so this is deliberately deferred. Open questions for then: who the experts are and how each is added (an auth user plus a `public.experts` row, by hand for now), how experts keep their online/offline toggle honest (there is no presence check or session timeout, so an expert who leaves a tab "online" gets matched to paying customers), and that matching gives each expert one live session at a time.

## Done tonight (2026-09-30), for reference

- Legacy Supabase API keys fully rotated and disabled; new key system validated end to end.
- Critical vulnerability fixed: four SECURITY DEFINER functions were callable by any authenticated user, allowing free paid-tier access — fixed in `backend/sql/012_lock_down_functions.sql`, committed and pushed as `8a4b5db`.
- Production bug fixed: `birth_data.city_tz` column was missing (migration 006 never applied), silently breaking chart saves for every new signup — applied via SQL Editor, verified end to end including RLS.
- Card redesign fully designed (competitive research, three directions, final direction chosen and refined to real brand fonts/colors) and implemented in the canvas-based `drawShareCard()`.
- Fixed a paywall bypass: the bottom-nav Report tab reached screen-fullreport with no entitlement check. Added a single guard in showScreen() covering every path in, plus entitlementsLoadFailed tracking so a failed entitlements fetch doesn't send a paying user toward checkout.
