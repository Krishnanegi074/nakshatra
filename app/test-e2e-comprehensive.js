// Comprehensive end-to-end pass requested after Phase 4: targeted edge cases that no
// prior test file exercised, plus one continuous cross-feature user journey (every
// previous test starts a fresh page load per feature — this checks nothing leaks or
// breaks when a single session touches nearly everything in sequence).
const { chromium } = require("playwright");
const path = require("path");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

async function signup(page, name, email, dob, city) {
  await page.click("#btn-landing-start");
  await page.fill("#input-name", name);
  await page.fill("#input-email", email);
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", dob);
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", city); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const results = [];
  const errors = [];
  let dialogFired = false;
  page.on("dialog", async (d) => { dialogFired = true; await d.dismiss(); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
  await signup(page, "Journey Tester", "journey@example.com", "1990-08-10", "Mumbai"); // Cancer (sidereal)

  console.log("\n== Group 1: chat XSS / HTML-injection safety ==");
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(150);
  await page.click('[data-astro="meera"]');
  await page.waitForTimeout(150);
  const malicious = '<img src=x onerror="window.__xssFired=true"> & <script>window.__xssFired2=true</script> "quoted" \'apos\'';
  await page.fill("#chat-input", malicious);
  await page.click("#btn-chat-send");
  await page.waitForTimeout(200);
  const xssFired = await page.evaluate(() => !!(window.__xssFired || window.__xssFired2));
  check("Malicious chat input does not execute as HTML/JS", !xssFired, results);
  check("No native dialog was triggered by the injected content", !dialogFired, results);
  const renderedText = await page.textContent(".chat-bubble.user");
  check("Malicious text renders back as literal text, unmangled", renderedText.includes("<img") && renderedText.includes("<script>"), results);
  const imgTagCount = await page.$$eval(".chat-bubble.user img", els => els.length);
  check("No actual <img> element was created from the injected markup", imgTagCount === 0, results);

  console.log("\n== Group 2: input disabled while a reply is pending (prevents overlapping replies) ==");
  await page.fill("#chat-input", "Tell me about my family situation");
  await page.click("#btn-chat-send");
  await page.waitForTimeout(50); // well before the 700ms reply delay
  const inputDisabledWhilePending = await page.$eval("#chat-input", el => el.disabled);
  const sendDisabledWhilePending = await page.$eval("#btn-chat-send", el => el.disabled);
  check("Chat input is disabled immediately after sending, before the reply lands", inputDisabledWhilePending, results);
  check("Send button is disabled immediately after sending, before the reply lands", sendDisabledWhilePending, results);
  // Attempting to send again while disabled should be a no-op (Playwright can still
  // programmatically fill a disabled input's value, so drive this via keyboard/click
  // which respects the disabled state)
  const bubbleCountBeforeDoubleSend = await page.$$eval(".chat-bubble", els => els.length);
  await page.click("#btn-chat-send", { force: false }).catch(() => {}); // disabled buttons refuse the click
  await page.waitForTimeout(50);
  const bubbleCountAfterDoubleSend = await page.$$eval(".chat-bubble", els => els.length);
  check("Clicking Send while disabled does not add an extra bubble", bubbleCountBeforeDoubleSend === bubbleCountAfterDoubleSend, results);
  await page.waitForTimeout(900);
  const inputEnabledAfterReply = await page.$eval("#chat-input", el => !el.disabled);
  check("Chat input re-enables once the reply lands", inputEnabledAfterReply, results);

  console.log("\n== Group 3: the astrologer-switch-during-typing-delay bug (regression) ==");
  // Send a message to Meera, then IMMEDIATELY switch to Priya's chat before Meera's
  // 700ms reply delay elapses. Meera's reply must still be recorded (not silently
  // dropped) so it's there when the user comes back to her conversation.
  const meeraBubblesBefore = await page.$$eval(".chat-bubble", els => els.length);
  await page.fill("#chat-input", "One more question for you");
  await page.click("#btn-chat-send");
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(60); // well under 700ms — Meera's reply has not landed yet
  await page.click('[data-astro="priya"]');
  await page.waitForTimeout(150);
  const onPriyaNow = (await page.textContent("#chat-astrologer-name")).trim() === "Priya";
  check("Successfully switched to Priya's chat mid-delay", onPriyaNow, results);
  await page.waitForTimeout(900); // let Meera's background reply resolve
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('[data-astro="meera"]');
  await page.waitForTimeout(150);
  const meeraBubblesAfter = await page.$$eval(".chat-bubble", els => els.length);
  check("Meera's reply was NOT lost after switching away mid-delay (regression check)", meeraBubblesAfter === meeraBubblesBefore + 2, results);
  const meeraInputEnabled = await page.$eval("#chat-input", el => !el.disabled);
  check("Meera's chat input is re-enabled after returning (reply already landed)", meeraInputEnabled, results);

  console.log("\n== Group 4: language switch mid-chat and mid-community (chrome translates, generated content stays English) ==");
  await page.click("#btn-lang-toggle-dash").catch(() => {}); // may not be visible from chat screen; fall back below
  let toggled = await page.isVisible("#sheet-lang-backdrop.visible");
  if (!toggled) {
    await page.click('[data-back="screen-chat-picker"]');
    await page.waitForTimeout(100);
    await page.click('.screen.active [data-back="screen-dashboard"]');
    await page.waitForTimeout(100);
    await page.click("#btn-lang-toggle-dash");
  }
  await page.waitForTimeout(100);
  await page.click('.lang-option[data-lang="hi"]');
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(150);
  const chatDisclaimerHi = await page.textContent("#screen-chat-picker p[data-i18n='chat.demo-note']");
  check("Chat picker disclaimer translates to Hindi", /[ऀ-ॿ]/.test(chatDisclaimerHi), results);
  await page.click('[data-astro="kabir"]');
  await page.waitForTimeout(150);
  const chatPlaceholderHi = await page.getAttribute("#chat-input", "placeholder");
  check("Chat input placeholder translates to Hindi", /[ऀ-ॿ]/.test(chatPlaceholderHi), results);
  const kabirGreetingStillEnglish = await page.textContent(".chat-bubble.astro");
  // Check for absence of Devanagari specifically (not "pure ASCII" — the greeting
  // legitimately contains an em dash and emoji, neither of which are ASCII).
  check("Existing chat message content stays English (deep-content scope boundary)", !/[ऀ-ॿ]/.test(kabirGreetingStillEnglish), results);

  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-community"]');
  await page.waitForTimeout(150);
  const communityTitleHi = await page.textContent("#screen-community h2");
  check("Community screen title translates to Hindi", /[ऀ-ॿ]/.test(communityTitleHi), results);
  const seedSignLabelHi = await page.textContent(".community-post .post-head .muted");
  check("Seed post's sign name translates to Hindi (dynamic re-render on language switch)", /[ऀ-ॿ]/.test(seedSignLabelHi), results);

  // Switch back to English for the rest of the journey
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click("#btn-lang-toggle-dash");
  await page.waitForTimeout(100);
  await page.click('.lang-option[data-lang="en"]');
  await page.waitForTimeout(150);

  console.log("\n== Group 5: community post caption fallback when no horoscope was ever viewed ==");
  // Post straight from the Full Report screen's share button WITHOUT visiting the
  // Weekly Horoscope screen first, so state._lastHoroscope is still unset — exercises
  // the tr("community.default-caption", ...) fallback path.
  await page.click('[data-nav="screen-fullreport"]');
  await page.waitForTimeout(150);
  await page.click("#btn-open-share");
  await page.waitForTimeout(200);
  const shareOpenedNoThrow = await page.isVisible("#sheet-share-backdrop.visible");
  check("Share sheet opens fine with no prior horoscope view (no crash)", shareOpenedNoThrow, results);
  await page.click("#btn-post-community");
  await page.waitForTimeout(200);
  const postsAfterFallback = await page.$$(".community-post");
  const topCaption = await postsAfterFallback[0].$eval(".post-caption", el => el.textContent);
  check("Fallback caption post succeeds and contains the user's sign name", topCaption.includes("Cancer"), results);

  console.log("\n== Group 6: gifting still works correctly after all the above (cross-feature isolation) ==");
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-gift-send"]');
  await page.waitForTimeout(150);
  await page.fill("#gift-recipient-name", "A Friend");
  await page.click("#btn-gift-continue");
  await page.waitForTimeout(150);
  await page.fill("#input-upi", "journeytester@okhdfc");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2000); // processing delay is 1700ms
  const giftSentShown = await page.isVisible("#screen-gift-sent.active");
  check("Gifting flow still completes correctly after chat/community/language usage", giftSentShown, results);
  const giftCode = (await page.textContent("#gift-code-display")).trim();
  check("Gift code has the expected format", /^NKSH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(giftCode), results);

  console.log("\n== Group 7: logout resets chat but preserves community/gift state for the next user ==");
  await page.click("#btn-gift-done");
  await page.waitForTimeout(100);
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);
  await signup(page, "Second Journey User", "journey2@example.com", "1995-03-01", "Delhi");
  await page.click('[data-nav="screen-community"]');
  await page.waitForTimeout(150);
  const secondUserSeesPost = (await page.$$(".community-post")).length >= 7; // 6 seed posts + 1 own post from Group 5
  check("Second user still sees prior posts (community state survives logout)", secondUserSeesPost, results);
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('[data-astro="kabir"]');
  await page.waitForTimeout(150);
  const secondUserChatFresh = (await page.$$eval(".chat-bubble", els => els.length)) === 1;
  check("Second user's chat starts fresh (chat state resets on logout, unlike community)", secondUserChatFresh, results);
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#open-redeem-sheet");
  await page.waitForTimeout(100);
  await page.fill("#input-gift-code", giftCode.toLowerCase()); // also exercises case-insensitivity
  await page.click("#btn-redeem-submit");
  await page.waitForTimeout(200);
  const redeemedOk = await page.isVisible("#screen-fullreport.active");
  check("Second user can redeem the gift code generated earlier in this journey", redeemedOk, results);

  console.log("\nJS ERRORS:", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map(f => f.label));

  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
