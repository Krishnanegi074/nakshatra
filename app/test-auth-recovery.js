// Regression test for item #16 of the full-site QA pass: "verify the Forgot
// Password flow." Two real bugs were found and fixed in app.js:
//
//   1. Following a real password-reset email link establishes a valid
//      Supabase session (that's how updatePassword() can work at all).
//      bootstrapSession() — which runs unconditionally a moment after
//      initAuth() — saw that session, assumed it was an ordinary returning
//      visitor, and silently redirected away from screen-reset-password to
//      the dashboard/onboarding before the visitor could ever set a new
//      password. Fixed with an isPasswordRecovery flag initAuth() sets
//      synchronously before bootstrapSession() ever runs.
//   2. btn-forgot-resend had no loading/disabled state (unlike its sibling
//      btn-forgot-submit), so nothing stopped a visitor from mashing it and
//      firing off several reset emails before the first request resolved.
//
// This is a plain Node script using Playwright directly against the built
// app/nakshatra-app.html, following the same fake-supabase.js pattern as
// test-gifting.js/test-community.js/etc.
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
  // Part A: ordinary Forgot Password flow (not a recovery link — just a
  // visitor who clicked "Forgot password?" from the login tab).
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Expected in this sandbox — no route to the Google Fonts CDN this page
      // links to; unrelated to anything under test here.
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(fakeSupabaseSrc);

    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await page.click("#btn-landing-login");
    await page.waitForTimeout(150);
    check("Login tab active after 'I already have an account'", await page.isVisible("#screen-auth.active, #screen-auth"), results);

    await page.fill("#input-email", "recover-me@example.com");
    await page.click("#btn-forgot-password");
    await page.waitForTimeout(150);
    check("Forgot-password screen shown", await page.isVisible("#screen-forgot-password.active, #screen-forgot-password"), results);
    const carriedEmail = await page.inputValue("#input-forgot-email");
    check("Email typed on the login form carries over to the forgot-password form", carriedEmail === "recover-me@example.com", results);

    await page.click("#btn-forgot-submit");
    await page.waitForTimeout(150);
    const sentVisible = await page.evaluate(() => document.getElementById("forgot-sent-state").style.display !== "none");
    check("Submitting shows the 'check your email' sent-state", sentVisible, results);
    const sentDescText = await page.textContent("#forgot-sent-desc");
    check("Sent-state names the correct email address", sentDescText.includes("recover-me@example.com"), results);
    const emailIsBold = await page.$eval("#forgot-sent-desc strong", (el) => el.textContent.trim() === "recover-me@example.com").catch(() => false);
    check("Email address is rendered bold (<strong>), not swallowed as plain text", emailIsBold, results);

    // --- THE FIX: resend button now shows a loading/disabled state, matching submit ---
    // app.js sets btn.disabled = true SYNCHRONOUSLY as the very first thing the
    // click handler does, before its first `await` — so it's observable right
    // after .click() returns, in the same page.evaluate() call, with no need to
    // race the fake backend's (near-instant) resolution.
    const resendDisabledDuring = await page.evaluate(() => {
      const btn = document.getElementById("btn-forgot-resend");
      btn.click();
      return btn.disabled;
    });
    check("Resend button disables itself while the resend request is in flight", resendDisabledDuring === true, results);
    await page.waitForTimeout(150);
    const resendReenabled = await page.evaluate(() => !document.getElementById("btn-forgot-resend").disabled);
    check("Resend button re-enables once the resend request resolves", resendReenabled, results);

    check("No unexpected JS errors (ordinary forgot-password flow)", errors.length === 0, results);
    if (errors.length) errors.forEach((e) => console.log(" -", e));
    await page.close();
  }

  // ============================================================
  // Part B: THE actual bug — following a real recovery link.
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(fakeSupabaseSrc);
    // Simulate "this visitor already exists and just followed a password-reset
    // email link" — a real recovery link establishes a session the same way a
    // real signup/login would (see updateUser()'s comment in fake-supabase.js),
    // which is EXACTLY the condition that used to trip up bootstrapSession().
    await page.addInitScript(() => {
      window.__fakeSupabaseApplySeed({
        store: {
          users: [{ id: "recovery-user-1", email: "already-had-account@example.com", password: "oldpassword", user_metadata: { name: "Returning Visitor" } }],
          profiles: [{ id: "recovery-user-1", name: "Returning Visitor", email: "already-had-account@example.com" }],
          birth_data: [], palm_reports: [], user_entitlements: [], unlocks: [], purchases: [],
          chat_messages: [], community_posts: [], community_likes: [], razorpay_orders: [], gift_codes: [],
        },
        session: { user: { id: "recovery-user-1", email: "already-had-account@example.com", user_metadata: { name: "Returning Visitor" } } },
        seq: 1,
      });
    });

    // ?type=recovery is one of the two real shapes a Supabase recovery link
    // can take (see initAuth()'s comment on this in app.js) — this is the
    // synchronous-detection path, the one that most directly races bootstrapSession().
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html") + "?type=recovery");
    await page.waitForTimeout(50);
    check("Recovery link shows screen-reset-password immediately (synchronous detection)", await page.isVisible("#screen-reset-password.active, #screen-reset-password"), results);

    // THE regression: wait long enough for bootstrapSession()'s async getSession()
    // round trip to resolve and (pre-fix) redirect away.
    await page.waitForTimeout(400);
    const screenAfterWait = await page.evaluate(() => document.querySelector(".screen.active").id);
    check("THE FIX: screen-reset-password is STILL showing after bootstrapSession() resolves (not silently bounced to dashboard/onboarding)", screenAfterWait === "screen-reset-password", results);

    // And the actual password-update flow itself still works from here.
    await page.fill("#input-reset-password", "newpassword123");
    await page.fill("#input-reset-confirm", "newpassword123");
    await page.click("#btn-reset-submit");
    await page.waitForTimeout(200);
    const screenAfterReset = await page.evaluate(() => document.querySelector(".screen.active").id);
    check("Submitting a new password routes onward (onboarding, since this fake user has no birth_data)", screenAfterReset === "screen-onboarding", results);

    check("No unexpected JS errors (recovery-link flow)", errors.length === 0, results);
    if (errors.length) errors.forEach((e) => console.log(" -", e));
    await page.close();
  }

  // ============================================================
  // Part C: mismatched password confirmation is rejected client-side.
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(fakeSupabaseSrc);
    await page.addInitScript(() => {
      window.__fakeSupabaseApplySeed({
        store: {
          users: [{ id: "recovery-user-2", email: "mismatch@example.com", password: "oldpassword", user_metadata: { name: "Mismatch Tester" } }],
          profiles: [{ id: "recovery-user-2", name: "Mismatch Tester", email: "mismatch@example.com" }],
          birth_data: [], palm_reports: [], user_entitlements: [], unlocks: [], purchases: [],
          chat_messages: [], community_posts: [], community_likes: [], razorpay_orders: [], gift_codes: [],
        },
        session: { user: { id: "recovery-user-2", email: "mismatch@example.com", user_metadata: { name: "Mismatch Tester" } } },
        seq: 1,
      });
    });
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html") + "?type=recovery");
    await page.waitForTimeout(500);
    await page.fill("#input-reset-password", "newpassword123");
    await page.fill("#input-reset-confirm", "somethingelse");
    await page.click("#btn-reset-submit");
    await page.waitForTimeout(150);
    const stillOnReset = await page.isVisible("#screen-reset-password.active, #screen-reset-password");
    check("Mismatched confirm-password keeps the visitor on screen-reset-password (not silently accepted)", stillOnReset, results);
    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})();
