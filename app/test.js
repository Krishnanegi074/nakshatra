const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 400, height: 860 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  const shot = (name) => page.screenshot({ path: `shots/${name}.png` });
  const fs = require("fs");
  if (!fs.existsSync("shots")) fs.mkdirSync("shots");

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
  await page.waitForTimeout(300);
  await shot("01-landing");

  await page.click("#btn-landing-start");
  await page.waitForTimeout(200);
  await shot("02-auth");

  await page.fill("#input-name", "Ananya Sharma");
  await page.fill("#input-email", "ananya@example.com");
  await page.fill("#input-password", "test1234");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(200);
  await shot("03-onboarding-step0");

  await page.fill("#input-dob", "1998-08-17");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(150);
  await shot("04-onboarding-step1");

  await page.fill("#input-tob", "06:15");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(150);
  await shot("05-onboarding-step2-city");

  await page.click("#input-city");
  await page.waitForTimeout(150);
  await shot("05b-city-sheet");
  await page.fill("#city-search", "Mumbai");
  await page.waitForTimeout(150);
  await shot("05c-city-search");
  await page.click(".city-item");
  await page.waitForTimeout(150);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(150);
  await shot("06-onboarding-step3-summary");

  await page.click("#btn-onb-next"); // Calculate My Chart
  await page.waitForTimeout(600);
  await shot("07-calculating");
  await page.waitForTimeout(2600);
  await shot("08-dashboard");

  // Horoscope (locked)
  await page.click('[data-nav="screen-horoscope"]');
  await page.waitForTimeout(200);
  await shot("09-horoscope-locked");

  // Back to dashboard, then Palm
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  await shot("10-palm-intro");

  const qids = await page.$$eval(".option-grid", els => els.map(e => e.dataset.qid));
  for (const qid of qids) {
    await page.click(`.option-grid[data-qid="${qid}"] .option-btn:first-child`);
  }
  await page.waitForTimeout(150);
  await shot("11-palm-answered");
  await page.click("#btn-palm-generate");
  await page.waitForTimeout(200);
  await shot("12-palm-result-locked");

  // Love energy
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-love"]');
  await page.waitForTimeout(1200);
  await shot("13-love-energy");

  // Report / paywall
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(150);
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(150);
  await shot("14-paywall-tiers");

  await page.click('.tier-card[data-tier="onetime"]');
  await page.click("#btn-report-checkout");
  await page.waitForTimeout(200);
  await shot("15-checkout-upi");

  await page.click('.paytab[data-pay="card"]');
  await page.waitForTimeout(150);
  await shot("16-checkout-card");
  await page.click('.paytab[data-pay="upi"]');
  await page.fill("#input-upi", "ananya@okhdfcbank");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(400);
  await shot("17-processing");
  await page.waitForTimeout(1600);
  await shot("18-success");

  await page.click("#btn-success-continue");
  await page.waitForTimeout(300);
  await shot("19-fullreport-top");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(100);
  await shot("20-fullreport-mid");
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(100);
  await shot("21-fullreport-bottom");

  await page.click("#btn-fullreport-share");
  await page.waitForTimeout(400);
  await shot("22-share-sheet");

  // Re-check horoscope now unlocked
  await page.click("#btn-close-share");
  await page.click('.bottom-nav [data-nav="screen-horoscope"]');
  await page.waitForTimeout(200);
  await shot("23-horoscope-unlocked");

  console.log("ERRORS FOUND:", errors.length);
  errors.forEach(e => console.log(" -", e));

  await browser.close();
})();
