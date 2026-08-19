// Playwright test for Phase 4's simulated "Chat with an Astrologer" feature: picker
// screen shows all 3 astrologers with a visible demo disclaimer, opening a chat shows
// a sign-aware greeting, sending messages produces topic-appropriate canned replies
// (not random/AI), the typing indicator appears and clears, switching astrologers
// keeps separate conversation histories, and logging out clears all chat state while
// a fresh second user starts clean.
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

  // --- Sign up and get to the dashboard (Cancer Sun, sidereal/Lahiri, for deterministic content checks) ---
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Test Chatter");
  await page.fill("#input-email", "chatter@example.com");
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

  // --- Dashboard tile navigates to the astrologer picker ---
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(150);
  check("Chat picker screen shown", await page.isVisible("#screen-chat-picker.active"), results);
  const astroCards = await page.$$("#chat-astrologer-list [data-astro]");
  check("All 3 astrologers listed", astroCards.length === 3, results);
  const disclaimerVisible = await page.isVisible("#screen-chat-picker p[data-i18n='chat.demo-note']");
  check("Demo disclaimer visible on picker screen", disclaimerVisible, results);

  // --- Open a chat, verify sign-aware greeting appears ---
  await page.click('[data-astro="kabir"]');
  await page.waitForTimeout(150);
  check("Chat screen shown", await page.isVisible("#screen-chat.active"), results);
  const astroName = await page.textContent("#chat-astrologer-name");
  check("Chat header shows Kabir", astroName.trim() === "Kabir", results);
  let bubbles = await page.$$eval(".chat-bubble.astro", els => els.map(e => e.textContent));
  check("Greeting message present", bubbles.length === 1 && bubbles[0].length > 10, results);
  check("Greeting mentions Cancer (the test user's Sun sign)", bubbles[0].includes("Cancer"), results);
  const shortDisclaimerVisible = await page.isVisible("#screen-chat p[data-i18n='chat.demo-note-short']");
  check("Short demo disclaimer visible on chat screen", shortDisclaimerVisible, results);

  // --- Send a love-topic message, expect a love-flavored reply after a typing delay ---
  await page.fill("#chat-input", "How is my relationship going to go this year?");
  await page.click("#btn-chat-send");
  const inputClearedImmediately = (await page.inputValue("#chat-input")) === "";
  check("Input clears immediately after sending", inputClearedImmediately, results);
  const userBubbleAppeared = await page.isVisible(".chat-bubble.user");
  check("User's message bubble appears immediately", userBubbleAppeared, results);
  const typingVisible = await page.isVisible(".chat-bubble.typing");
  check("Typing indicator appears right after sending", typingVisible, results);
  await page.waitForTimeout(1000);
  const typingGone = (await page.$(".chat-bubble.typing")) === null;
  check("Typing indicator clears once the reply lands", typingGone, results);
  bubbles = await page.$$eval(".chat-bubble.astro", els => els.map(e => e.textContent));
  check("A second astrologer reply was appended", bubbles.length === 2, results);
  check("Reply text is non-trivial (not empty/echo)", bubbles[1].length > 15, results);

  // --- Determinism: same astrologer/sign/topic/turn should reproduce the same class of reply ---
  // (verified at the unit level in test-phase4-rules.js; here we just confirm the UI
  // doesn't crash on a second message and produces a DIFFERENT bubble, i.e. it's not
  // stuck re-showing the greeting or duplicating text)
  await page.fill("#chat-input", "What about my career though?");
  await page.click("#btn-chat-send");
  await page.waitForTimeout(1000);
  bubbles = await page.$$eval(".chat-bubble.astro", els => els.map(e => e.textContent));
  check("Third astrologer reply appended after second message", bubbles.length === 3, results);
  check("Career-topic reply differs from the love-topic reply", bubbles[2] !== bubbles[1], results);

  // --- Enter key also sends ---
  await page.fill("#chat-input", "Thanks!");
  await page.press("#chat-input", "Enter");
  await page.waitForTimeout(1000);
  const userBubbleCount = await page.$$eval(".chat-bubble.user", els => els.length);
  check("Enter key sends a message too", userBubbleCount === 3, results);

  // --- Empty input does not send a blank bubble ---
  const beforeCount = await page.$$eval(".chat-bubble", els => els.length);
  await page.click("#btn-chat-send");
  await page.waitForTimeout(200);
  const afterCount = await page.$$eval(".chat-bubble", els => els.length);
  check("Clicking Send with empty input does nothing", beforeCount === afterCount, results);

  // --- Go back to picker, open a DIFFERENT astrologer — should get its own fresh greeting, not Kabir's history ---
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('[data-astro="priya"]');
  await page.waitForTimeout(150);
  const priyaName = await page.textContent("#chat-astrologer-name");
  check("Switched to Priya's chat", priyaName.trim() === "Priya", results);
  const priyaBubbles = await page.$$eval(".chat-bubble", els => els.length);
  check("Priya's conversation starts fresh (just her greeting, not Kabir's history)", priyaBubbles === 1, results);

  // --- Going back to Kabir's chat should preserve his earlier history ---
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('[data-astro="kabir"]');
  await page.waitForTimeout(150);
  const kabirBubblesAgain = await page.$$eval(".chat-bubble", els => els.length);
  // greeting + (user msg + reply) x3 (the love question, the career question, "Thanks!" via Enter) = 7
  check("Returning to Kabir's chat preserves prior conversation history", kabirBubblesAgain === 7, results);

  // --- Logout clears chat state; a fresh second user starts with no leftover history ---
  await page.click('[data-back="screen-chat-picker"]');
  await page.waitForTimeout(100);
  // Multiple hidden screens share a [data-back="screen-dashboard"] button — scope to
  // the currently active screen so Playwright doesn't grab a hidden one and time out.
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Second Chatter");
  await page.fill("#input-email", "second@example.com");
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
  await page.click('[data-nav="screen-chat-picker"]');
  await page.waitForTimeout(100);
  await page.click('[data-astro="kabir"]');
  await page.waitForTimeout(150);
  const secondUserBubbles = await page.$$eval(".chat-bubble", els => els.length);
  check("Fresh second user's chat with Kabir starts clean (no leftover history)", secondUserBubbles === 1, results);

  console.log("\nJS ERRORS:", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map(f => f.label));

  await browser.close();
  process.exit(failed.length || errors.length ? 1 : 0);
})();
