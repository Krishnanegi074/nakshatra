// Small regression tests for two behaviours added after the 0f4ef4c release build:
//   1. After a FAILED entitlements fetch the app retries exactly ONCE (scheduleEntitlementsRetry, 9d9ff9a): not
//      zero times, not in a loop, and not at all when the first fetch works.
//   2. The share-card background stars are seeded (seededRandom, 9d9ff9a): the same seed gives the same stars, so the
//      same user on the same day always gets the identical card image.
//
// Both live inside app.js's closure, so this test builds a TEMPORARY copy of app/nakshatra-app.html with a one-line
// hook (window.__t) appended after the SITE_DOMAIN constant. The hook only exposes existing internals; app code is
// unchanged. The browser is launched through launchGuarded() and talks to the in-memory fake Supabase only.
//   node app/build.js && node app/test-release-small.js
const { chromium } = require("playwright");
const { launchGuarded } = require("./test-guard");
const fs = require("fs");
const os = require("os");
const path = require("path");

const results = [];
function check(label, cond, extra) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label + (cond || extra === undefined ? "" : "  [" + extra + "]"));
}

async function signupUser(page, name, email, dob, city) {
  await page.click("#btn-landing-start");
  await page.fill("#input-name", name);
  await page.fill("#input-email", email);
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(200);
  await page.fill("#input-dob", dob);
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", city); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);
}

// Wraps the fake client so reads of user_entitlements are counted and the first __entFail of them fail.
const ENTITLEMENT_PROBE = `
(function () {
  window.__entCalls = 0; window.__entFail = 0;
  var realCreate = window.supabase.createClient;
  window.supabase.createClient = function () {
    var client = realCreate.apply(this, arguments);
    var realFrom = client.from.bind(client);
    client.from = function (table) {
      var builder = realFrom(table);
      if (table !== "user_entitlements") return builder;
      var realSelect = builder.select.bind(builder);
      builder.select = function () {
        window.__entCalls++;
        if (window.__entCalls <= window.__entFail) {
          var failing = { eq: function () { return Promise.resolve({ data: null, error: { message: "simulated entitlements failure" } }); } };
          return failing;
        }
        return realSelect.apply(null, arguments);
      };
      return builder;
    };
    return client;
  };
})();`;

(async () => {
  // Build the hooked temp copy
  const builtPath = path.join(__dirname, "nakshatra-app.html");
  if (!fs.existsSync(builtPath)) { console.log("FATAL: run `node app/build.js` first"); process.exit(1); }
  const built = fs.readFileSync(builtPath, "utf8");
  const anchor = 'const SITE_DOMAIN = "nakshatra.ind.in";';
  if (built.split(anchor).length !== 2) { console.log("FATAL: hook anchor not found exactly once"); process.exit(1); }
  const hooked = built.replace(anchor, anchor + "\nwindow.__t = () => ({ state, seededRandom, drawShareCard, loadUserDataFromBackend });  // test-only hook, never in the real build");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-small-"));
  const url = "file://" + path.join(tmp, "app.html");
  fs.writeFileSync(path.join(tmp, "app.html"), hooked);
  const fakeSupabase = fs.readFileSync(path.join(__dirname, "tests-backend", "fake-supabase.js"), "utf8");

  const browser = await launchGuarded(chromium, { executablePath: "/opt/pw-browsers/chromium", headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(t)) return;   // the guard blocking the network
    if (/\[backend\] loadEntitlements failed/.test(t)) return;                   // the failure this test injects on purpose
    errors.push("CONSOLE ERROR: " + t);
  });
  await page.addInitScript(fakeSupabase);
  await page.addInitScript(ENTITLEMENT_PROBE);
  await page.goto(url);
  await page.waitForTimeout(150);

  console.log("== entitlements retry: exactly once ==");
  await signupUser(page, "Retry Tester", "retry@example.com", "1990-08-10", "Mumbai");
  check("signed up through the fake backend and reached the dashboard", await page.isVisible("#screen-dashboard.active"));
  const calls = () => page.evaluate(() => window.__entCalls);
  const failedFlag = () => page.evaluate(() => window.__t().state.entitlementsLoadFailed);
  const run = async (failFirst) => {
    await page.evaluate((n) => { window.__entCalls = 0; window.__entFail = n; }, failFirst);
    await page.evaluate(() => window.__t().loadUserDataFromBackend());
  };

  // A: the first fetch fails, the retry works
  await run(1);
  check("A: the initial fetch happened once, right away", (await calls()) === 1, await calls());
  await page.waitForTimeout(1300);
  check("A: ...and no retry has fired yet before the 1.8 s delay", (await calls()) === 1, await calls());
  await page.waitForTimeout(1500);
  check("A: after the delay exactly one retry has run (2 fetches in total)", (await calls()) === 2, await calls());
  check("A: the successful retry clears the failed flag", (await failedFlag()) === false);
  await page.waitForTimeout(2500);
  check("A: nothing further is fetched later (still 2)", (await calls()) === 2, await calls());

  // B: both fetches fail: still only one retry, no loop
  await run(99);
  await page.waitForTimeout(2800);
  check("B: when the retry fails too there were 2 fetches (initial + one retry)", (await calls()) === 2, await calls());
  check("B: the failed flag stays set", (await failedFlag()) === true);
  await page.waitForTimeout(4500);
  check("B: it does NOT keep retrying (still 2 after 7 s)", (await calls()) === 2, await calls());

  // C: the first fetch works: no retry at all
  await run(0);
  await page.waitForTimeout(3000);
  check("C: when the first fetch works there is no retry (1 fetch in total)", (await calls()) === 1, await calls());

  // D: two loads in quick succession while failing: one pending retry, not two
  await page.evaluate(() => { window.__entCalls = 0; window.__entFail = 2; });
  await page.evaluate(async () => { await window.__t().loadUserDataFromBackend(); await window.__t().loadUserDataFromBackend(); });
  await page.waitForTimeout(3200);
  check("D: two failed loads in a row leave only one retry timer (2 initial + 1 retry = 3 fetches)", (await calls()) === 3, await calls());

  console.log("\n== share-card stars: seeded ==");
  const seq = (seed, n = 8) => page.evaluate(([s, k]) => { const r = window.__t().seededRandom(s); return Array.from({ length: k }, () => r()); }, [seed, n]);
  const a1 = await seq("retry@example.com-2026-10-08"), a2 = await seq("retry@example.com-2026-10-08");
  const b = await seq("retry@example.com-2026-10-09"), c = await seq("someone-else@example.com-2026-10-08");
  check("the same seed (user + day) gives the same sequence", JSON.stringify(a1) === JSON.stringify(a2));
  check("a different day gives a different sequence", JSON.stringify(a1) !== JSON.stringify(b));
  check("a different user gives a different sequence", JSON.stringify(a1) !== JSON.stringify(c));
  check("every value is in [0, 1)", a1.concat(b, c).every((v) => v >= 0 && v < 1));

  const draw = () => page.evaluate(async () => { await window.__t().drawShareCard(); return document.getElementById("shareCanvas").toDataURL("image/png"); });
  const card1 = await draw(), card2 = await draw();
  check("the share card was actually drawn (a real image, not blank)", card1.length > 20000, card1.length);
  check("drawing the card twice for the same user and day gives the IDENTICAL image", card1 === card2);

  console.log("\nJS errors:", errors.length);
  errors.forEach((e) => console.log(" -", e));
  check("no unexpected JS errors", errors.length === 0);

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log("FATAL", e.stack || e.message); process.exit(1); });
