// End-to-end verification that app.js's real Supabase wiring actually works,
// driven through the real UI (not just checking call shapes like
// nakshatra-backend/tests/test-data-layer.js does). A fake in-browser
// Supabase client (fake-supabase.js) is injected via addInitScript before
// any app script runs, so NakshatraDB.db becomes non-null and every
// backend-integration code path added to app.js in this pass actually
// executes — against a faithful reimplementation of sql/002_schema.sql's
// tables, RLS-equivalent row scoping, and the two RPC functions.
//
// Because this sandbox has no real network access to Supabase (see
// nakshatra-backend/SETUP.md), this is the most rigorous verification of
// the frontend integration layer available here. It complements, not
// replaces: nakshatra-backend/tests/test-rls.js (schema + RLS against real
// Postgres) and test-data-layer.js (call-shape correctness).
const { chromium } = require("playwright");
const path = require("path");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
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

async function loginUser(page, email) {
  await page.click("#btn-landing-login");
  await page.fill("#input-email", email);
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(300);
}

async function logout(page) {
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(80);
  if (!(await page.isVisible("#screen-dashboard.active"))) {
    // Might already be on the dashboard, or a couple of screens deep — walk back.
    for (let i = 0; i < 3 && !(await page.isVisible("#screen-dashboard.active")); i++) {
      await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
      await page.waitForTimeout(80);
    }
  }
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const results = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  // "recordTestPurchase failed: simulated failure" is EXPECTED — Group 3
  // deliberately forces that one RPC call to fail to test the error path.
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (msg.text().includes("ERR_TUNNEL_CONNECTION_FAILED")) return;
    if (msg.text().includes("simulated failure")) return;
    errors.push("CONSOLE ERROR: " + msg.text());
  });

  const fakeSupabaseSrc = require("fs").readFileSync(path.join(__dirname, "fake-supabase.js"), "utf8");
  await page.addInitScript(fakeSupabaseSrc);

  await page.goto("file://" + path.resolve(__dirname, "..", "nakshatra-app.html"));

  console.log("== Group 1: signup creates a real session + onboarding persists real birth data ==");
  await signupUser(page, "Ananya Test", "ananya@example.com", "1990-08-10", "Mumbai"); // Cancer (sidereal)
  check("Reached dashboard after signup+onboarding", await page.isVisible("#screen-dashboard.active"), results);
  let store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Exactly one birth_data row exists after onboarding", store.birth_data.length === 1, results);
  check("birth_data row has the right city and a numeric sun_idx", store.birth_data[0].city_name === "Mumbai" && Number.isInteger(store.birth_data[0].sun_idx), results);
  check("profiles row was auto-created at signup with the entered name", store.profiles[0] && store.profiles[0].name === "Ananya Test", results);
  const userA = store.profiles[0].id;

  console.log("\n== Group 2: palm report persists ==");
  await page.click('[data-nav="screen-palm"]').catch(async () => { await page.click('.nav-item[data-nav="screen-palm"]'); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelectorAll(".option-grid").forEach(g => g.querySelector(".option-btn").click()));
  await page.waitForTimeout(100);
  await page.click("#btn-palm-generate");
  await page.waitForTimeout(150);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Exactly one palm_reports row exists after generating", store.palm_reports.length === 1, results);
  check("palm_reports row belongs to the signed-in user", store.palm_reports[0].user_id === userA, results);

  console.log("\n== Group 3: checkout failure path (forced) does NOT unlock, then a retry succeeds ==");
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#btn-report-checkout");
  await page.waitForTimeout(150);
  await page.fill("#input-upi", "ananya@okhdfc");
  await page.evaluate(() => window.__fakeSupabaseForceNextError());
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2000);
  check("Forced RPC failure sends the user back to checkout, NOT success", await page.isVisible("#screen-checkout.active"), results);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("No purchases/unlocks row was created by the failed attempt", store.purchases.length === 0 && store.unlocks.length === 0, results);

  await page.click("#btn-pay-submit"); // retry, no forced error this time
  await page.waitForTimeout(2000);
  check("Retrying (without a forced error) reaches the success screen", await page.isVisible("#screen-success.active"), results);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("record_test_purchase() RPC created exactly one purchases row", store.purchases.length === 1 && store.purchases[0].tier === "bundle", results);
  check("record_test_purchase() RPC correctly unlocked the user (source=purchase)", store.unlocks.length === 1 && store.unlocks[0].unlocked === true && store.unlocks[0].source === "purchase", results);

  console.log("\n== Group 4: chat messages persist through the real send/greeting path ==");
  await page.click("#btn-success-continue");
  await page.waitForTimeout(150);
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(150);
  await page.click('[data-astro="priya"]');
  await page.waitForTimeout(200);
  check("Opening a fresh chat renders exactly one greeting bubble", (await page.$$(".chat-bubble.astro")).length === 1, results);
  await page.fill("#chat-input", "What does my career look like?");
  await page.click("#btn-chat-send");
  await page.waitForTimeout(1000);
  const bubbleCount = (await page.$$(".chat-bubble")).length;
  check("After sending, there are 3 bubbles total (greeting + user + reply)", bubbleCount === 3, results);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  const priyaMsgs = store.chat_messages.filter(m => m.astrologer_id === "priya" && m.user_id === userA);
  check("chat_messages has exactly 3 real rows for this user+astrologer (greeting, user, astro reply)", priyaMsgs.length === 3, results);
  check("The 3 rows are in the right order (astro, user, astro) matching what was sent", priyaMsgs.map(m => m.sender).join(",") === "astro,user,astro", results);

  console.log("\n== Group 5: community post + like + unlike round-trip through the real backend ==");
  await page.click('.screen.active [data-back="screen-chat-picker"]').catch(() => {});
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-fullreport"]');
  await page.waitForTimeout(150);
  await page.click("#btn-open-share");
  await page.waitForTimeout(150);
  await page.click("#btn-post-community");
  await page.waitForTimeout(600);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("community_posts has exactly one real row after posting", store.community_posts.length === 1, results);
  const realPostId = store.community_posts[0].id;
  check("Real post appears in the rendered feed (not just the seed posts)", await page.isVisible(`.community-post[data-post="${realPostId}"]`), results);

  await page.click(`.community-post[data-post="${realPostId}"] .post-like-btn`);
  await page.waitForTimeout(200);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Liking a real post inserts a real community_likes row", store.community_likes.length === 1 && store.community_likes[0].post_id === realPostId, results);
  const likedCountText = await page.textContent(`.community-post[data-post="${realPostId}"] .like-count`);
  check("Like count shows 1 after liking", likedCountText.trim() === "1", results);

  await page.click(`.community-post[data-post="${realPostId}"] .post-like-btn`);
  await page.waitForTimeout(200);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Unliking removes the community_likes row again", store.community_likes.length === 0, results);

  await page.click('[data-like^="seed-"]');
  await page.waitForTimeout(150);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Liking a SEED post never touches the real backend (still 0 community_likes rows)", store.community_likes.length === 0, results);

  console.log("\n== Group 6: gift send creates a real code; a different user redeems it for real ==");
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(150);
  await page.fill("#gift-recipient-name", "A Friend");
  await page.click("#btn-gift-continue");
  await page.waitForTimeout(150);
  await page.fill("#input-upi", "ananya@okhdfc");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2000);
  check("Gift purchase reaches the gift-sent screen", await page.isVisible("#screen-gift-sent.active"), results);
  const giftCode = (await page.textContent("#gift-code-display")).trim();
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  const codeRow = store.gift_codes.find(g => g.code === giftCode);
  check("A real gift_codes row was created for the displayed code, owned by user A, not yet redeemed", !!codeRow && codeRow.sender_id === userA && codeRow.redeemed === false, results);

  console.log("\n== Group 7: self-redeem is blocked by the RPC (via the real UI, not just a unit test) ==");
  // A is not yet unlocked-by-gift (only by the earlier direct purchase), but
  // the UI already short-circuits on state.unlocked before calling the RPC —
  // so to actually exercise GIFT_CODE_SELF_REDEEM we need a user who owns a
  // code but isn't unlocked by any other means yet. Send a second gift as A
  // won't work (A is unlocked) — use a fresh third user instead.
  await page.click("#btn-gift-done");
  await page.waitForTimeout(100);
  await logout(page);
  await signupUser(page, "Chetan Test", "chetan@example.com", "1992-01-15", "Delhi");
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(150);
  await page.fill("#gift-recipient-name", "Someone");
  await page.click("#btn-gift-continue");
  await page.waitForTimeout(150);
  await page.fill("#input-upi", "chetan@okhdfc");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2000);
  const chetanCode = (await page.textContent("#gift-code-display")).trim();
  await page.click("#btn-gift-done");
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#open-redeem-sheet");
  await page.waitForTimeout(150);
  await page.fill("#input-gift-code", chetanCode);
  await page.click("#btn-redeem-submit");
  await page.waitForTimeout(300);
  check("Self-redeeming your own gift code is blocked", !(await page.isVisible("#screen-fullreport.active")), results);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Chetan is still not unlocked after the blocked self-redeem attempt", store.unlocks.every(u => u.user_id !== store.profiles.find(p => p.name === "Chetan Test").id), results);
  await page.click("#btn-close-redeem"); // the sheet stays open after a blocked attempt — close it before navigating away
  await page.waitForTimeout(100);

  console.log("\n== Group 8: a DIFFERENT user successfully redeems user A's earlier gift code ==");
  await logout(page);
  await signupUser(page, "Divya Test", "divya@example.com", "1988-11-02", "Mumbai");
  const userD = (await page.evaluate(() => window.__fakeSupabaseStore.profiles)).find(p => p.name === "Divya Test").id;
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#open-redeem-sheet");
  await page.waitForTimeout(150);
  await page.fill("#input-gift-code", giftCode); // user A's code from Group 6
  await page.click("#btn-redeem-submit");
  await page.waitForTimeout(300);
  check("Redeeming a real gift code sent by a different real user unlocks the full report", await page.isVisible("#screen-fullreport.active"), results);
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  const dUnlock = store.unlocks.find(u => u.user_id === userD);
  check("record via redeem_gift_code() RPC set source=gift for the redeemer", dUnlock && dUnlock.unlocked === true && dUnlock.source === "gift", results);
  const redeemedCodeRow = store.gift_codes.find(g => g.code === giftCode);
  check("The gift_codes row is now marked redeemed, by the correct redeemer", redeemedCodeRow.redeemed === true && redeemedCodeRow.redeemed_by === userD, results);

  console.log("\n== Group 9: redeeming again while already unlocked short-circuits before ever calling the RPC ==");
  // Divya is already unlocked from Group 8 — the UI's `if (state.unlocked)`
  // guard should send her straight to the full report without touching the
  // backend again at all (not even a redundant successful RPC call).
  const unlocksCountBeforeRepeat = (await page.evaluate(() => window.__fakeSupabaseStore.unlocks)).length;
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#open-redeem-sheet");
  await page.waitForTimeout(150);
  await page.fill("#input-gift-code", giftCode);
  await page.click("#btn-redeem-submit");
  await page.waitForTimeout(300);
  check("Re-submitting the redeem form while already unlocked lands back on the full report", await page.isVisible("#screen-fullreport.active"), results);
  const unlocksCountAfterRepeat = (await page.evaluate(() => window.__fakeSupabaseStore.unlocks)).length;
  check("No new/duplicate unlocks row was created by the redundant redeem attempt", unlocksCountAfterRepeat === unlocksCountBeforeRepeat, results);

  console.log("\n== Group 10: data isolation — every signed-up user's data stays separate ==");
  store = await page.evaluate(() => window.__fakeSupabaseStore);
  check("Exactly 3 distinct birth_data rows exist for the 3 signed-up users (no cross-contamination)", store.birth_data.length === 3, results);
  check("Only user A has a palm_reports row (Chetan/Divya never generated one)", store.palm_reports.length === 1 && store.palm_reports[0].user_id === userA, results);

  console.log("\n== Group 11: logout really calls signOut() and clears the local session ==");
  const sessionBeforeLogout = await page.evaluate(() => window.__fakeSupabaseGetSession());
  check("A session exists before logout", !!sessionBeforeLogout, results);
  await logout(page);
  const sessionAfterLogout = await page.evaluate(() => window.__fakeSupabaseGetSession());
  check("auth.signOut() was actually called — no session remains in the fake backend", sessionAfterLogout === null, results);
  check("UI returned to the landing screen after logout", await page.isVisible("#screen-landing.active"), results);

  console.log("\n== Group 12: a real page reload silently resumes an existing session (bootstrapSession) ==");
  await signupUser(page, "Rahul Reload", "rahul@example.com", "1993-06-20", "Delhi");
  await page.click('[data-nav="screen-palm"]').catch(async () => { await page.click('.nav-item[data-nav="screen-palm"]'); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelectorAll(".option-grid").forEach(g => g.querySelector(".option-btn").click()));
  await page.click("#btn-palm-generate");
  await page.waitForTimeout(150);
  const snapshot = await page.evaluate(() => ({
    store: window.__fakeSupabaseStore,
    session: window.__fakeSupabaseGetSession(),
  }));
  check("Sanity: snapshot captured a live session before reload", !!snapshot.session, results);
  await page.addInitScript(`window.__fakeSupabaseApplySeed(${JSON.stringify(snapshot)});`);
  await page.reload();
  await page.waitForTimeout(1500); // bootstrapSession() is async — give it a moment after load
  check("After a real reload, the user is silently signed back in (no landing/login screen)", !(await page.isVisible("#screen-landing.active")), results);
  check("Reload lands directly on the dashboard (birth data existed) rather than onboarding", await page.isVisible("#screen-dashboard.active"), results);
  const sunLabelAfterReload = await page.textContent("#label-sun");
  check("Dashboard shows a real sign name after reload (chart data was restored, not blank)", !!sunLabelAfterReload && sunLabelAfterReload.trim().length > 0, results);
  await page.click('[data-nav="screen-palm"]').catch(async () => { await page.click('.nav-item[data-nav="screen-palm"]'); });
  await page.waitForTimeout(150);
  check("Palm report generated before reload is still there after reload (not asked to redo it)", await page.isVisible("#palm-result"), results);

  console.log("\n== Group 13: self-service account deletion (Settings -> Delete My Account) ==");
  const rahulId = (await page.evaluate(() => window.__fakeSupabaseStore.profiles.find(p => p.email === "rahul@example.com"))).id;
  await page.click('.screen.active [data-back="screen-dashboard"]').catch(() => {});
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-settings"]');
  await page.waitForTimeout(150);
  check("Settings screen shown", await page.isVisible("#screen-settings.active"), results);
  check("Delete confirmation is NOT shown yet (step 1 only)", !(await page.isVisible("#settings-delete-step2")), results);
  await page.click("#btn-settings-delete-start");
  await page.waitForTimeout(100);
  check("Clicking Delete My Account reveals the irreversible-warning confirmation step", await page.isVisible("#settings-delete-step2"), results);
  await page.click("#btn-settings-delete-cancel");
  await page.waitForTimeout(100);
  check("Cancel returns to step 1 without deleting anything", !(await page.isVisible("#settings-delete-step2")) && (await page.evaluate(() => window.__fakeSupabaseGetSession())) !== null, results);

  await page.click("#btn-settings-delete-start");
  await page.waitForTimeout(100);
  await page.click("#btn-settings-delete-confirm");
  await page.waitForTimeout(300);
  check("After confirming, the app returns to the landing screen", await page.isVisible("#screen-landing.active"), results);
  const sessionAfterDelete = await page.evaluate(() => window.__fakeSupabaseGetSession());
  check("No session remains after account deletion", sessionAfterDelete === null, results);
  const storeAfterDelete = await page.evaluate(() => window.__fakeSupabaseStore);
  check("The deleted user's row is gone from every table that referenced them (profile, birth data, users)",
    !storeAfterDelete.profiles.some(r => r.id === rahulId) &&
    !storeAfterDelete.birth_data.some(r => r.user_id === rahulId) &&
    !storeAfterDelete.users.some(r => r.id === rahulId),
    results);
  check("Deleting Rahul's account left the other 3 already-signed-up users' data untouched", storeAfterDelete.birth_data.length === 3, results);

  console.log("\n== Group 14: a deleted account's email can be used to sign up again (proves it's a real delete, not just a local reset) ==");
  await signupUser(page, "Rahul Again", "rahul@example.com", "1993-06-20", "Delhi");
  check("Re-signing up with the deleted account's email succeeds (no longer taken)", await page.isVisible("#screen-dashboard.active"), results);

  console.log("\nJS ERRORS:", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map(f => f.label));

  await browser.close();
  process.exit(failed.length || errors.length ? 1 : 0);
})();
