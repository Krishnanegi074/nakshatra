// Playwright test for Phase 3 i18n: language switching from both entry points,
// dashboard blurb/sign-name translation, mid-session switching back to English,
// the two innerHTML-rebuilt interactive spans (methodology toggle, redeem
// opener) still work after a switch, and switching language doesn't break the
// CV scan or gifting flows that were already verified in English.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  if (!fs.existsSync("shots-i18n")) fs.mkdirSync("shots-i18n");
  const shot = (name) => page.screenshot({ path: `shots-i18n/${name}.png` });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));

  // --- Default language should be English (test browser locale is en-US) ---
  const startBtnTextEn = await page.textContent("#btn-landing-start");
  console.log("Default landing CTA text:", startBtnTextEn, "(expect English 'Begin Your Reading')");
  await shot("01-landing-en");

  // --- Switch to Hindi from the landing screen globe button ---
  await page.click("#btn-lang-toggle");
  await page.waitForTimeout(100);
  await page.click('.lang-option[data-lang="hi"]');
  await page.waitForTimeout(150);
  const startBtnTextHi = await page.textContent("#btn-landing-start");
  console.log("After switching to Hindi, landing CTA text:", startBtnTextHi);
  const htmlLangAttr = await page.evaluate(() => document.documentElement.lang);
  console.log("document.documentElement.lang:", htmlLangAttr, "(expect hi)");
  await shot("02-landing-hi");

  // --- Proceed through signup/onboarding in Hindi, check chrome stays translated ---
  await page.click("#btn-landing-start");
  await page.waitForTimeout(100);
  const authTitleHi = await page.textContent("#screen-auth h2");
  const authSubmitHi = await page.textContent("#btn-auth-submit");
  console.log("Auth screen title (hi):", authTitleHi, "| submit button (hi, expect 'Create account'-equivalent):", authSubmitHi);
  await shot("03-auth-hi");

  await page.fill("#input-name", "Ishaan Gupta");
  await page.fill("#input-email", "ishaan@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  const onbNextTextHi = await page.textContent("#btn-onb-next");
  console.log("Onboarding 'Continue' button (hi):", onbNextTextHi);
  await shot("04-onboarding-hi");

  await page.fill("#input-dob", "1992-07-15");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Jaipur"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  const calcBtnTextHi = await page.textContent("#btn-onb-next");
  console.log("Onboarding step-4 button (hi, expect 'Calculate' equivalent):", calcBtnTextHi);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(400);
  const calcStatusHi = await page.textContent("#calc-status");
  console.log("Calculating screen status text (hi):", calcStatusHi);
  await page.waitForTimeout(3000);

  // --- Dashboard: greeting, sign labels, blurb should all be Hindi ---
  const greetingHi = await page.textContent("#dash-greeting");
  const sunLabelHi = await page.textContent("#label-sun");
  const sunCategoryHi = await page.textContent("div.muted:has-text('सूर्य'), .muted");
  const blurbHi = await page.textContent("#dash-blurb");
  console.log("Dashboard greeting (hi):", greetingHi);
  console.log("Sun sign label shown (hi, should be Devanagari sign name):", sunLabelHi);
  console.log("Dashboard blurb (hi):", blurbHi);
  await shot("05-dashboard-hi");

  const langNoteVisible = await page.isVisible("#dash-lang-note");
  const langNoteText = langNoteVisible ? await page.textContent("#dash-lang-note") : null;
  console.log("Hindi content-scope note visible:", langNoteVisible, "| text:", langNoteText);

  // --- Methodology toggle span (rebuilt via innerHTML) must still open its sheet ---
  await page.click('[data-nav="screen-horoscope"]');
  await page.waitForTimeout(150);
  const methodologyText = await page.textContent("#horo-methodology-toggle");
  console.log("Methodology toggle span text (hi):", methodologyText);
  await page.click("#horo-methodology-toggle");
  await page.waitForTimeout(150);
  const methodSheetVisible = await page.evaluate(() => document.getElementById("sheet-method-backdrop").classList.contains("visible"));
  console.log("Methodology sheet opened after clicking rebuilt span (hi):", methodSheetVisible);
  await shot("06-methodology-sheet-hi");
  await page.click("#btn-close-method");
  await page.waitForTimeout(100);

  // --- Redeem-code opener span (also rebuilt via innerHTML) must still work ---
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await page.click("#open-redeem-sheet");
  await page.waitForTimeout(150);
  const redeemSheetVisible = await page.evaluate(() => document.getElementById("sheet-redeem-backdrop").classList.contains("visible"));
  console.log("Redeem sheet opened after clicking rebuilt span (hi):", redeemSheetVisible);
  await page.click("#btn-close-redeem");

  // --- Year Ahead: sign names should be Hindi ---
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-yearahead"]');
  await page.waitForTimeout(150);
  const jupSignHi = await page.textContent("#ya-jupiter-sign");
  console.log("Year Ahead Jupiter sign (hi):", jupSignHi);
  await shot("07-yearahead-hi");

  // --- Switch back to English mid-session and confirm everything reverts ---
  await page.click('.screen.active [data-back="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click("#btn-lang-toggle-dash");
  await page.waitForTimeout(100);
  await page.click('.lang-option[data-lang="en"]');
  await page.waitForTimeout(150);
  const greetingEn = await page.textContent("#dash-greeting");
  const sunLabelEn = await page.textContent("#label-sun");
  console.log("After switching back to English — greeting:", greetingEn, "| sun label:", sunLabelEn);
  await shot("08-dashboard-back-to-en");

  // --- CV scan + gifting flows should still work fine after language switching ---
  await page.click('[data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  const fileInput = await page.$("#palm-file-input");
  await fileInput.setInputFiles(path.resolve(__dirname, "test-assets-palm.png"));
  await page.waitForTimeout(300);
  await page.click("#btn-palm-analyze");
  await page.waitForTimeout(300);
  const cvStatusAfterLangSwitch = await page.textContent("#palm-cv-status");
  console.log("CV scan still works after language switching:", cvStatusAfterLangSwitch.slice(0, 40) + "...");

  console.log("\nERRORS FOUND:", errors.length);
  errors.forEach(e => console.log(" -", e));

  await browser.close();
})();
