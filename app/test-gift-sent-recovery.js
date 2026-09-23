// Regression test for item #20 of the full-site QA pass: "gift code review —
// fix dead loadSentGift(), document cross-device behavior." Two real things
// were wrong:
//
//   1. supabase-client.js's loadSentGift(code) existed but was never called
//      anywhere in app.js — dead code. A sender's own view of a code they'd
//      just generated lived ONLY in state.lastGiftCode/state.giftCodes,
//      both purely in-memory, so a real page refresh lost it completely even
//      though the row was always still sitting in the real backend.
//   2. screen-gift-send's demo note claimed gift codes "are redeemable only
//      within this same browser tab/session" — no longer true since the real
//      Razorpay + Supabase gift_codes/redeem_gift_code() path shipped;
//      redemption genuinely works cross-device. The note undersold a
//      working feature.
//
// Fixed with a new supabase-client.js loadSentGifts() (plural — lists every
// code this signed-in user has sent, gift_codes_select_own_sent's RLS scope
// needs no per-code filter) wired into a new "Your Sent Gifts" section on
// screen-gift-send (state.sentGifts / loadSentGiftsList() / renderSentGiftsList()
// in app.js), refetched from the backend every time that screen is shown —
// so it survives a real reload — plus the demo-note copy correction.
//
// This exercises the real end-to-end purchase path (fake Razorpay + fake
// Supabase), following the same pattern as test-gifting.js and
// tests-backend/test-backend-integration.js's Group 12 reload test.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const results = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
    errors.push("CONSOLE ERROR: " + msg.text());
  });

  const fakeSupabaseSrc = fs.readFileSync(path.join(__dirname, "tests-backend", "fake-supabase.js"), "utf8");
  const fakeRazorpaySrc = fs.readFileSync(path.join(__dirname, "tests-backend", "fake-razorpay.js"), "utf8");
  await page.addInitScript(fakeSupabaseSrc);
  await page.addInitScript(fakeRazorpaySrc);

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));

  // ---------------- Sign up + onboard the sender ----------------
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Recovery Sender");
  await page.fill("#input-email", "recovery-sender@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1994-06-05");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Mumbai"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);

  // ---------------- Send a gift (real checkout path) ----------------
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(150);

  const demoNoteText = await page.textContent("#auth-demo-note").catch(() => "");
  const giftDemoNoteText = await page.evaluate(() => {
    const el = document.querySelector('[data-i18n="gift.demo-note"]');
    return el ? el.textContent : "";
  });
  check("THE OTHER FIX: gift demo-note no longer claims same-tab-only redemption (outdated copy)", !/same browser tab|same.*session/i.test(giftDemoNoteText), results);
  check("...and instead correctly describes real cross-device redemption", /any device/i.test(giftDemoNoteText), results);

  await page.fill("#gift-recipient-name", "Priya");
  await page.click('#gift-tier-list .tier-card[data-tier="onetime"]');
  await page.waitForTimeout(100);
  await page.click("#btn-gift-continue");
  await page.waitForTimeout(150);
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2000);
  check("Reached screen-gift-sent after the gift purchase completes", await page.isVisible("#screen-gift-sent.active, #screen-gift-sent"), results);

  const sentCode = (await page.textContent("#gift-code-display")).trim();
  check("A gift code was generated", /^NKSH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(sentCode), results);

  await page.click("#btn-gift-done");
  await page.waitForTimeout(150);

  // Immediately revisiting the Gift screen (same session, no reload) should
  // already show it in "Your Sent Gifts" — proves the list itself works
  // before even testing the harder "survived a refresh" case below.
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(400);
  const listVisibleBeforeReload = await page.isVisible("#gift-sent-list-wrap");
  const listTextBeforeReload = await page.textContent("#gift-sent-list");
  check("'Your Sent Gifts' section appears in the same session, right after sending", listVisibleBeforeReload, results);
  check("...and shows the code + recipient + pending status", listTextBeforeReload.includes(sentCode) && listTextBeforeReload.includes("Priya") && /not redeemed/i.test(listTextBeforeReload), results);

  // ---------------- THE FIX: survives a real page reload ----------------
  // state.lastGiftCode/state.giftCodes (the OLD, purely in-memory storage)
  // are wiped by this reload exactly like they always were — the point is
  // that the NEW list no longer depends on them at all, only on re-fetching
  // from the backend, which a reload doesn't touch.
  const snapshot = await page.evaluate(() => ({
    store: window.__fakeSupabaseStore,
    session: window.__fakeSupabaseGetSession(),
    seq: window.__fakeSupabaseGetSeq(),
  }));
  check("Sanity: snapshot captured a live session with the sent gift_codes row before reload", !!snapshot.session && snapshot.store.gift_codes.some((g) => g.code === sentCode), results);
  await page.addInitScript(`window.__fakeSupabaseApplySeed(${JSON.stringify(snapshot)});`);
  await page.reload();
  await page.waitForTimeout(1500);

  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(500);
  const listVisibleAfterReload = await page.isVisible("#gift-sent-list-wrap");
  const listTextAfterReload = await page.textContent("#gift-sent-list");
  check("THE FIX: 'Your Sent Gifts' still shows the code after a real page reload", listVisibleAfterReload, results);
  check("...with the right recipient name and code, re-fetched from the backend", listTextAfterReload.includes(sentCode) && listTextAfterReload.includes("Priya"), results);

  // ---------------- Status updates once redeemed ----------------
  await page.evaluate((code) => {
    const g = window.__fakeSupabaseStore.gift_codes.find((r) => r.code === code);
    if (g) { g.redeemed = true; g.redeemed_by = "someone-else"; }
  }, sentCode);
  // Currently ON screen-gift-send — leave via its own back button (not a
  // bottom-nav item, so [data-nav="screen-dashboard"] doesn't exist here)
  // then re-enter to force a fresh loadSentGiftsList() fetch.
  await page.click('#screen-gift-send [data-back="screen-dashboard"]');
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(500);
  const listTextAfterRedeem = await page.textContent("#gift-sent-list");
  check("Sent-gifts list reflects a redeemed code as 'Redeemed', not still pending", /redeemed/i.test(listTextAfterRedeem) && !/not redeemed/i.test(listTextAfterRedeem), results);

  check("No unexpected JS errors across the whole flow", errors.length === 0, results);
  if (errors.length) errors.forEach((e) => console.log(" -", e));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})();
