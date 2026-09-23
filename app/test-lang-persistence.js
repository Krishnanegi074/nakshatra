// Regression test for item #19 of the full-site QA pass: "persist Hindi
// language choice for signed-in users." Previously state.lang (app.js) was
// explicitly documented as NOT persisted — re-detected from
// navigator.language on every fresh page load — so a signed-in user who
// switched to Hindi would silently see English again on their next visit,
// even on the SAME device/browser. Fixed with a new profiles.preferred_lang
// column (sql/008_preferred_lang.sql): saved on explicit switch
// (initLangSwitch() in app.js), restored on login/session-restore
// (loadUserDataFromBackend()). Anonymous/pre-auth visitors are explicitly
// out of scope — they still get the browser-detected default every load,
// same as before.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const results = [];
  const fakeSupabaseSrc = fs.readFileSync(path.join(__dirname, "tests-backend", "fake-supabase.js"), "utf8");

  // ============================================================
  // Part A: a signed-in user explicitly switches to Hindi — the choice
  // is saved to their profile (not just applied client-side).
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(fakeSupabaseSrc);
    // A returning, already-signed-in user with a finished birth chart, so
    // bootstrapSession() routes straight to the dashboard (where the
    // language toggle lives) instead of onboarding.
    await page.addInitScript(() => {
      window.__fakeSupabaseApplySeed({
        store: {
          users: [{ id: "lang-user-1", email: "lang-switcher@example.com", password: "pw123456", user_metadata: { name: "Lang Switcher" } }],
          profiles: [{ id: "lang-user-1", name: "Lang Switcher", email: "lang-switcher@example.com" }],
          birth_data: [{ user_id: "lang-user-1", year: 1994, month: 6, day: 5, hour: 9, minute: 15, unknown_time: false, city_name: "Mumbai", city_country: "India", city_lat: 19.076, city_lon: 72.8777, city_utc: 5.5, city_tz: "Asia/Kolkata", sun_idx: 2, moon_idx: 4, asc_idx: 1, moon_phase: 0.3 }],
          palm_reports: [], user_entitlements: [], unlocks: [], purchases: [],
          chat_messages: [], community_posts: [], community_likes: [], razorpay_orders: [], gift_codes: [],
        },
        session: { user: { id: "lang-user-1", email: "lang-switcher@example.com", user_metadata: { name: "Lang Switcher" } } },
        seq: 1,
      });
    });

    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await page.waitForTimeout(400);
    check("Signed-in returning user with a saved chart lands on the dashboard", await page.isVisible("#screen-dashboard.active, #screen-dashboard"), results);
    check("Starts in English by default (no preferred_lang saved yet, browser locale is en-US)", (await page.evaluate(() => document.documentElement.lang)) === "en", results);

    await page.click("#btn-lang-toggle-dash");
    await page.waitForTimeout(100);
    check("Language sheet opens", await page.isVisible("#sheet-lang-backdrop.visible, #sheet-lang-backdrop"), results);
    await page.click('.lang-option[data-lang="hi"]');
    await page.waitForTimeout(200);
    check("UI switches to Hindi immediately (html lang attribute)", (await page.evaluate(() => document.documentElement.lang)) === "hi", results);

    const savedLang = await page.evaluate(() => window.__fakeSupabaseStore.profiles.find((p) => p.id === "lang-user-1").preferred_lang);
    check("THE FIX: the switch is saved to the user's profile (preferred_lang = 'hi'), not just applied client-side", savedLang === "hi", results);

    check("No unexpected JS errors (language switch)", errors.length === 0, results);
    if (errors.length) errors.forEach((e) => console.log(" -", e));
    await page.close();
  }

  // ============================================================
  // Part B: THE actual bug — a returning signed-in user whose profile
  // already has preferred_lang='hi' saved should see Hindi immediately on
  // load, even though the browser itself is set to English (the old,
  // pre-fix behavior: always re-detect from navigator.language, ignoring
  // any saved choice).
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(fakeSupabaseSrc);
    await page.addInitScript(() => {
      window.__fakeSupabaseApplySeed({
        store: {
          users: [{ id: "lang-user-2", email: "hindi-preferrer@example.com", password: "pw123456", user_metadata: { name: "Hindi Preferrer" } }],
          profiles: [{ id: "lang-user-2", name: "Hindi Preferrer", email: "hindi-preferrer@example.com", preferred_lang: "hi" }],
          birth_data: [], palm_reports: [], user_entitlements: [], unlocks: [], purchases: [],
          chat_messages: [], community_posts: [], community_likes: [], razorpay_orders: [], gift_codes: [],
        },
        session: { user: { id: "lang-user-2", email: "hindi-preferrer@example.com", user_metadata: { name: "Hindi Preferrer" } } },
        seq: 1,
      });
    });

    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    // Give applyLanguage("en") (the initial browser-detected default, run
    // synchronously on DOMContentLoaded) time to run FIRST, then
    // bootstrapSession()'s async profile load time to override it — this
    // ordering is exactly what used to be impossible before the fix, since
    // there was nothing to override it WITH.
    await page.waitForTimeout(500);
    check("THE FIX: a returning user's saved Hindi preference wins over the browser's English default", (await page.evaluate(() => document.documentElement.lang)) === "hi", results);
    check("Routed to onboarding (this fake user has no birth_data)", await page.isVisible("#screen-onboarding.active, #screen-onboarding"), results);
    const onbHeading = await page.textContent('[data-i18n="onb.h2.0"]');
    check("Onboarding heading text is actually rendered in Hindi, not just the html lang attribute flipped", onbHeading.trim() === "आपका जन्म कब हुआ?", results);

    check("No unexpected JS errors (session-restore language override)", errors.length === 0, results);
    if (errors.length) errors.forEach((e) => console.log(" -", e));
    await page.close();
  }

  // ============================================================
  // Part C: anonymous/pre-auth visitor — unaffected, still just the
  // browser-detected default, no backend call, no crash.
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "hi-IN" });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(fakeSupabaseSrc);
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await page.waitForTimeout(300);
    check("Anonymous visitor with a Hindi browser locale still gets the browser-detected default (Hindi)", (await page.evaluate(() => document.documentElement.lang)) === "hi", results);
    check("No unexpected JS errors (anonymous visitor, no session, no profile to load)", errors.length === 0, results);
    if (errors.length) errors.forEach((e) => console.log(" -", e));
    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})();
