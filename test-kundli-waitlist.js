// Playwright regression test for the Kundli Matching waitlist form (item #10
// of the full-site QA pass — kundli-matching.html + kundli-waitlist.js +
// backend/sql/007_kundli_waitlist.sql).
//
// Before this fix, "Join the Waitlist" was <form onsubmit="return false;"> —
// pure decoration, throwing every address away. This test proves the real
// wiring: a successful join shows a success message and clears the field, a
// second join with the same (differently-cased) email is treated as already
// joined rather than an error, a hard failure shows an error message, the
// form disables itself while the request is in flight, and — with no
// backend reachable at all (this sandbox's actual condition; there is no
// network path to supabase.com here) — the form fails closed with a
// friendly message instead of throwing or silently doing nothing.
//
// Two runs against two fresh pages:
//   1. No fake injected at all — exercises the real "supabase-js didn't
//      load" fallback branch in kundli-waitlist.js, using the sandbox's own
//      lack of network access rather than simulating it.
//   2. A small in-memory fake `window.supabase.createClient(...)` (just the
//      one table this page touches — not the full app-level
//      tests-backend/fake-supabase.js, which is scoped to the app/ SPA and
//      its much larger schema) — exercises success, case-insensitive
//      duplicate handling, and a forced generic failure.
const { chromium } = require("playwright");
const path = require("path");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

// Mirrors backend/sql/007_kundli_waitlist.sql closely enough to exercise
// kundli-waitlist.js's real code paths: insert-only, case-insensitive unique
// email (23505 on conflict), and a way to force a generic failure so the
// "something went wrong" branch (unreachable via the duplicate-email path)
// gets covered too.
const FAKE_SUPABASE_SRC = `
(function () {
  "use strict";
  var rows = [];
  window.__fakeWaitlistRows = rows;
  window.__fakeWaitlistForceError = false;
  window.__fakeWaitlistSetForceError = function (v) { window.__fakeWaitlistForceError = v; };
  window.__fakeWaitlistInsertDelayMs = 0;

  function insert(payload) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (window.__fakeWaitlistForceError) {
          window.__fakeWaitlistForceError = false;
          resolve({ data: null, error: { message: "simulated failure" } });
          return;
        }
        var email = payload.email;
        var dup = rows.some(function (r) { return r.email.toLowerCase() === email.toLowerCase(); });
        if (dup) {
          resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \\"kundli_waitlist_email_lower_idx\\"" } });
          return;
        }
        rows.push({ email: email, created_at: new Date().toISOString() });
        resolve({ data: null, error: null });
      }, window.__fakeWaitlistInsertDelayMs);
    });
  }

  var client = {
    from: function (table) {
      return {
        insert: function (payload) {
          if (table !== "kundli_waitlist") return Promise.resolve({ data: null, error: { message: "unknown table " + table } });
          return insert(payload);
        },
      };
    },
  };

  window.supabase = { createClient: function () { return client; } };
})();
`;

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const results = [];
  const url = "file://" + path.resolve(__dirname, "kundli-matching.html");

  // ============================================================
  // Run 1: no fake — real "backend unreachable" fallback path.
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Expected in this sandbox — no route to jsdelivr.net for the real
      // supabase-js CDN script, which is exactly the condition this run
      // means to exercise.
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });

    await page.goto(url);
    await page.waitForTimeout(150);

    check("Waitlist form present", await page.isVisible("#waitlist-form"), results);
    check("Email input has a real <label> (not just placeholder) via for/id", await page.$eval("label[for='waitlist-email']", (el) => !!el), results);
    check("Status region is role=status/aria-live=polite for screen readers", await page.$eval("#waitlist-status", (el) => el.getAttribute("role") === "status" && el.getAttribute("aria-live") === "polite"), results);

    await page.fill("#waitlist-email", "nobackend@example.com");
    await page.click("#waitlist-submit");
    await page.waitForTimeout(150);
    const statusText = (await page.textContent("#waitlist-status")) || "";
    check("With no backend reachable, submit fails closed with a friendly message (not silent, not a crash)", /could not connect|try again/i.test(statusText), results);
    check("The friendly fallback message names a real contact as a way forward", /support@nakshatra\.ind\.in/i.test(statusText), results);

    console.log("Run 1 (no fake) JS errors:", errors.length);
    errors.forEach((e) => console.log(" -", e));
    check("No unexpected JS errors on the no-backend run", errors.length === 0, results);

    await page.close();
  }

  // ============================================================
  // Run 2: fake backend — success / duplicate / forced-error / loading state.
  // ============================================================
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Same expected-in-this-sandbox network failure as Run 1 — the real
      // <script src=".../supabase-js@2/..."> tag still attempts to load
      // even though the fake below wins the race (addInitScript runs first
      // and the real tag's load never succeeds here to overwrite it).
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(msg.text())) return;
      errors.push("CONSOLE ERROR: " + msg.text());
    });
    await page.addInitScript(FAKE_SUPABASE_SRC);

    await page.goto(url);
    await page.waitForTimeout(150);

    // --- First join succeeds ---
    await page.fill("#waitlist-email", "  Priya.Sharma@Example.com  ");
    await page.click("#waitlist-submit");
    await page.waitForTimeout(150);
    let statusText = (await page.textContent("#waitlist-status")) || "";
    check("First-time join shows a success message", /you're on the list/i.test(statusText), results);
    check("Success message is rendered with the success color class", await page.$eval("#waitlist-status", (el) => el.classList.contains("nk-km-note--success")), results);
    const inputAfterSuccess = await page.inputValue("#waitlist-email");
    check("Email field clears after a successful join", inputAfterSuccess === "", results);
    const savedEmails = await page.evaluate(() => window.__fakeWaitlistRows.map((r) => r.email));
    check("Email is trimmed and lowercased before it reaches the backend", savedEmails.includes("priya.sharma@example.com"), results);

    // --- Second join, same address, different case/whitespace: not an error ---
    await page.fill("#waitlist-email", "priya.sharma@example.com");
    await page.click("#waitlist-submit");
    await page.waitForTimeout(150);
    statusText = (await page.textContent("#waitlist-status")) || "";
    check("Re-joining with the same (differently-cased) email is treated as already-joined, not an error", /already on the list/i.test(statusText), results);
    check("Already-joined message still uses the success color, not the error color", await page.$eval("#waitlist-status", (el) => el.classList.contains("nk-km-note--success") && !el.classList.contains("nk-km-note--error")), results);
    const rowCountAfterDup = await page.evaluate(() => window.__fakeWaitlistRows.length);
    check("Duplicate join did not create a second row (server-side dedup respected)", rowCountAfterDup === 1, results);

    // --- Loading state: button + input disabled while the request is in flight ---
    await page.evaluate(() => { window.__fakeWaitlistInsertDelayMs = 300; });
    await page.fill("#waitlist-email", "loading-check@example.com");
    await page.click("#waitlist-submit");
    await page.waitForTimeout(60); // request is in flight, not yet resolved
    const disabledWhileLoading = await page.evaluate(() => document.getElementById("waitlist-submit").disabled && document.getElementById("waitlist-email").disabled);
    check("Submit button and email field disable while the join request is in flight", disabledWhileLoading, results);
    const statusWhileLoading = (await page.textContent("#waitlist-status")) || "";
    check("Status region shows an in-progress message while loading", /joining/i.test(statusWhileLoading), results);
    await page.waitForTimeout(400);
    const enabledAfterLoad = await page.evaluate(() => !document.getElementById("waitlist-submit").disabled && !document.getElementById("waitlist-email").disabled);
    check("Submit button and email field re-enable once the request resolves", enabledAfterLoad, results);
    await page.evaluate(() => { window.__fakeWaitlistInsertDelayMs = 0; });

    // --- Forced generic failure: real error branch, distinct from the duplicate-email branch ---
    await page.fill("#waitlist-email", "will-fail@example.com");
    await page.evaluate(() => window.__fakeWaitlistSetForceError(true));
    await page.click("#waitlist-submit");
    await page.waitForTimeout(150);
    statusText = (await page.textContent("#waitlist-status")) || "";
    check("A genuine backend failure shows an error message (distinct from the duplicate-email success path)", /something went wrong/i.test(statusText), results);
    check("Error message is rendered with the error color class", await page.$eval("#waitlist-status", (el) => el.classList.contains("nk-km-note--error")), results);
    const rowCountAfterForcedError = await page.evaluate(() => window.__fakeWaitlistRows.length);
    check("A failed join is not silently recorded server-side", rowCountAfterForcedError === 2, results); // priya + loading-check only

    // --- Native email validation still gates submission (real <form>, not onsubmit="return false") ---
    await page.fill("#waitlist-email", "not-an-email");
    const validityOk = await page.$eval("#waitlist-email", (el) => el.checkValidity());
    check("Native browser email validation rejects a malformed address (type=email + required)", !validityOk, results);

    console.log("Run 2 (fake backend) JS errors:", errors.length);
    errors.forEach((e) => console.log(" -", e));
    check("No unexpected JS errors on the fake-backend run", errors.length === 0, results);

    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})();
