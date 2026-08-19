// Playwright test for Phase 4's simulated Community feed: seed posts render with the
// demo disclaimer, liking/unliking toggles correctly, posting your own card (via the
// existing Share sheet) prepends a real image+caption post, and both user posts and
// likes survive logout (matching the giftCodes precedent) so a fresh second user still
// sees them — demonstrating the "shared feed" concept without a real backend.
const { chromium } = require("playwright");
const path = require("path");

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
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));

  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Community Tester");
  await page.fill("#input-email", "community@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1990-08-10"); // Cancer (sidereal)
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Mumbai"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);
  check("Reached dashboard", await page.isVisible("#screen-dashboard.active"), results);

  // --- Seed posts render with disclaimer ---
  await page.click('[data-nav="screen-community"]');
  await page.waitForTimeout(150);
  check("Community screen shown", await page.isVisible("#screen-community.active"), results);
  const disclaimerVisible = await page.isVisible("#screen-community p[data-i18n='community.demo-note']");
  check("Demo disclaimer visible on community screen", disclaimerVisible, results);
  let posts = await page.$$(".community-post");
  check("At least 6 seed posts render", posts.length >= 6, results);

  // --- Like / unlike toggling on the first seed post ---
  const firstLikeBtn = await page.$(".community-post .post-like-btn");
  const initialCountText = await firstLikeBtn.$eval(".like-count", el => el.textContent);
  const initialCount = parseInt(initialCountText, 10);
  const initiallyLiked = await firstLikeBtn.evaluate(el => el.classList.contains("liked"));
  check("Seed post starts unliked", !initiallyLiked, results);
  await firstLikeBtn.click();
  await page.waitForTimeout(100);
  const afterLikeBtn = await page.$(".community-post .post-like-btn");
  const afterLikeCount = parseInt(await afterLikeBtn.$eval(".like-count", el => el.textContent), 10);
  const afterLiked = await afterLikeBtn.evaluate(el => el.classList.contains("liked"));
  check("Liking increments the count by 1", afterLikeCount === initialCount + 1, results);
  check("Liking marks the button as liked", afterLiked, results);
  await afterLikeBtn.click();
  await page.waitForTimeout(100);
  const afterUnlikeBtn = await page.$(".community-post .post-like-btn");
  const afterUnlikeCount = parseInt(await afterUnlikeBtn.$eval(".like-count", el => el.textContent), 10);
  check("Unliking returns the count to its original value", afterUnlikeCount === initialCount, results);

  // --- Post to community via the existing Share sheet (lives on the Full Report screen) ---
  await page.click('.screen.active[id="screen-community"] [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  // Visit the horoscope screen first so state._lastHoroscope is populated (the share
  // card includes a "this week" excerpt sourced from it).
  await page.click('[data-nav="screen-horoscope"]');
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-fullreport"]');
  await page.waitForTimeout(150);
  await page.click("#btn-open-share");
  await page.waitForTimeout(200);
  const shareSheetVisible = await page.isVisible("#sheet-share-backdrop.visible");
  check("Share sheet opens from the full report screen", shareSheetVisible, results);
  const postBtnVisible = await page.isVisible("#btn-post-community");
  check("'Post to Community' button visible in share sheet", postBtnVisible, results);
  await page.click("#btn-post-community");
  await page.waitForTimeout(200);
  check("Posting navigates to the community screen", await page.isVisible("#screen-community.active"), results);
  posts = await page.$$(".community-post");
  check("Post count increased by 1 (seed posts + 1 new own post)", posts.length >= 7, results);
  const firstPost = posts[0];
  const firstPostName = await firstPost.$eval("strong", el => el.textContent);
  check("Newest post (own post) appears at the top, attributed to the current user", firstPostName.trim() === "Community Tester", results);
  const firstPostImg = await firstPost.$("img");
  check("Own post includes a rendered image (from the share card canvas)", firstPostImg !== null, results);
  const ownPostSrc = firstPostImg ? await firstPostImg.getAttribute("src") : "";
  check("Own post image is a real, non-trivial data URL", ownPostSrc.startsWith("data:image/png;base64,") && ownPostSrc.length > 1000, results);

  // --- Own post is also likeable ---
  // Re-query fresh after the click rather than reusing `firstPost`/`ownLikeBtn` handles —
  // renderCommunityFeed() replaces the whole list's innerHTML on every like toggle, which
  // detaches old handles (they keep returning their stale pre-click snapshot instead of
  // throwing, so a stale-handle bug here reads as a silently-wrong count, not a crash).
  const ownInitialCount = parseInt(await page.$eval(".community-post .post-like-btn .like-count", el => el.textContent), 10);
  await page.click(".community-post .post-like-btn");
  await page.waitForTimeout(100);
  const ownAfterCount = parseInt(await page.$eval(".community-post .post-like-btn .like-count", el => el.textContent), 10);
  check("Own post is likeable like any other post", ownAfterCount === ownInitialCount + 1, results);

  // --- Logout: own post + likes should persist (this is the whole point of the demo feed) ---
  await page.click('.screen.active[id="screen-community"] [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Second Community User");
  await page.fill("#input-email", "second-community@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1995-03-01");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Delhi"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);
  await page.click('[data-nav="screen-community"]');
  await page.waitForTimeout(150);
  const secondUserPosts = await page.$$(".community-post");
  check("Fresh second user still sees the first user's post (shared-feed demo, survives logout)", secondUserPosts.length >= 7, results);
  const secondUserFirstPostLikeCount = parseInt(await secondUserPosts[0].$eval(".like-count", el => el.textContent), 10);
  check("Like count on the carried-over post persisted across logout", secondUserFirstPostLikeCount === ownAfterCount, results);
  const secondUserFirstPostLiked = await secondUserPosts[0].$eval(".post-like-btn", el => el.classList.contains("liked"));
  check("Liked state on the carried-over post persisted across logout too", secondUserFirstPostLiked, results);

  console.log("\nJS ERRORS:", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map(f => f.label));

  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
