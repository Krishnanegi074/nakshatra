const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, permissions: [] });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  const fs = require("fs");
  if (!fs.existsSync("shots2")) fs.mkdirSync("shots2");
  const shot = (name) => page.screenshot({ path: `shots2/${name}.png` });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Priya Nair");
  await page.fill("#input-email", "priya@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1997-02-14"); // Aquarius
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.fill("#input-tob", "11:20");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Bengaluru"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);
  await shot("01-dashboard-with-new-tiles");

  // --- Compatibility ---
  await page.click('[data-nav="screen-compat"]');
  await page.waitForTimeout(150);
  await shot("02-compat-form-empty");
  const genDisabled1 = await page.evaluate(() => document.getElementById("btn-compat-generate").disabled);
  console.log("Compat generate disabled with empty form:", genDisabled1);

  await page.fill("#compat-name", "Rohan Verma");
  const genDisabled2 = await page.evaluate(() => document.getElementById("btn-compat-generate").disabled);
  console.log("Compat generate disabled with name only (no dob):", genDisabled2);

  await page.fill("#compat-dob", "1995-09-10");
  await page.waitForTimeout(100);
  const genDisabled3 = await page.evaluate(() => document.getElementById("btn-compat-generate").disabled);
  console.log("Compat generate disabled with name+dob:", genDisabled3);

  // future date rejection test
  await page.fill("#compat-dob", "2099-01-01");
  await page.click("#btn-compat-generate");
  await page.waitForTimeout(150);
  const stillOnForm = await page.isVisible("#compat-form");
  console.log("Future partner DOB rejected (still on form):", stillOnForm);
  await page.fill("#compat-dob", "1995-09-10");

  await page.click("#btn-compat-generate");
  await page.waitForTimeout(200);
  await shot("03-compat-result-locked");
  const compatScore = await page.textContent("#compat-score");
  console.log("Compat score shown:", compatScore);

  // Try a different person
  await page.click("#btn-compat-reset");
  await page.waitForTimeout(150);
  await shot("04-compat-reset");
  const backOnForm = await page.isVisible("#compat-form");
  const nameCleared = await page.inputValue("#compat-name");
  console.log("Back on form after reset:", backOnForm, "| name field cleared:", JSON.stringify(nameCleared));

  // --- Year Ahead ---
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-yearahead"]');
  await page.waitForTimeout(150);
  await shot("05-yearahead-locked");
  const jupText = await page.textContent("#ya-jupiter-sign");
  const satText = await page.textContent("#ya-saturn-sign");
  console.log("Jupiter sign shown:", jupText, "| Saturn sign shown:", satText);

  // --- Notifications ---
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(100);
  await page.click("#btn-open-notif");
  await page.waitForTimeout(150);
  await shot("06-notif-sheet");
  const notifStatus = await page.textContent("#notif-status-text");
  console.log("Notif status text:", notifStatus);
  await page.click("#btn-close-notif");

  // --- Unlock and re-check full report includes new sections ---
  await page.click('[data-nav="screen-report"]');
  await page.waitForTimeout(100);
  await page.click("#btn-report-checkout");
  await page.waitForTimeout(100);
  await page.fill("#input-upi", "priya@okaxis");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2200);
  await page.click("#btn-success-continue");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 1600));
  await page.waitForTimeout(100);
  await shot("07-fullreport-yearahead-compat");

  // Re-check compat/yearahead screens are now unlocked (no lock overlay)
  await page.click('.bottom-nav [data-nav="screen-dashboard"]');
  await page.waitForTimeout(150);
  await page.click('.screen.active [data-nav="screen-compat"]');
  await page.waitForTimeout(150);
  await shot("08-compat-unlocked");
  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(100);
  await page.click('[data-nav="screen-yearahead"]');
  await page.waitForTimeout(150);
  await shot("09-yearahead-unlocked");

  console.log("\nERRORS FOUND:", errors.length);
  errors.forEach(e => console.log(" -", e));

  await browser.close();
})();
