const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !msg.text().includes("ERR_TUNNEL")) errors.push("CONSOLE: " + msg.text()); });
  const results = [];
  const check = (label, cond) => { results.push({ label, pass: !!cond }); console.log((cond ? "PASS" : "FAIL") + " - " + label); };

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));

  // 1. Signup
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Final Check");
  await page.fill("#input-email", "finalcheck@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  check("Reached onboarding after signup", await page.isVisible("#screen-onboarding"));

  // 2. Full onboarding
  await page.fill("#input-dob", "1996-07-22");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.fill("#input-tob", "16:40");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Chennai"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);
  check("Reached dashboard", await page.isVisible("#screen-dashboard"));

  // 3. Skip palm generation deliberately -> check full report recovery link later

  // 4. Weekly horoscope locked view
  await page.click('.screen.active [data-nav="screen-horoscope"]');
  await page.waitForTimeout(150);
  check("Horoscope headline populated", (await page.textContent("#horo-headline")).includes("Week"));

  // 5. Love energy
  await page.click(".bottom-nav [data-nav=\"screen-dashboard\"]"); await page.waitForTimeout(100);
  await page.click('.screen.active [data-nav="screen-love"]');
  await page.waitForTimeout(1200);
  const loveScore = await page.textContent("#love-score");
  check("Love score is a number 0-100", /^\d{1,2}$|^100$/.test(loveScore.trim()));

  // 6. Year ahead
  await page.click(".bottom-nav [data-nav=\"screen-dashboard\"]"); await page.waitForTimeout(100);
  await page.click('.screen.active [data-nav="screen-yearahead"]');
  await page.waitForTimeout(150);
  check("Year Ahead shows a real Jupiter sign", (await page.textContent("#ya-jupiter-sign")).trim().length > 0);

  // 7. Compatibility - generate then leave WITHOUT resetting (so full report can render it)
  await page.click(".screen.active [data-back=\"screen-dashboard\"]"); await page.waitForTimeout(100);
  await page.click('.screen.active [data-nav="screen-compat"]');
  await page.waitForTimeout(150);
  await page.fill("#compat-name", "Test Partner");
  await page.fill("#compat-dob", "1994-12-01");
  await page.click("#btn-compat-generate");
  await page.waitForTimeout(150);
  check("Compat result score shows a percentage", (await page.textContent("#compat-score")).includes("%"));

  // 8. Login tab (never fully exercised before) - open a second tab's worth of flow via logout/login
  await page.click(".screen.active [data-back=\"screen-dashboard\"]"); await page.waitForTimeout(100);
  await page.click("#btn-dash-logout"); await page.waitForTimeout(150);
  await page.click("#btn-landing-login");
  await page.waitForTimeout(100);
  check("Login tab active & name field hidden", await page.evaluate(() => document.getElementById("tab-login").classList.contains("active") && getComputedStyle(document.getElementById("field-name")).display === "none"));
  await page.fill("#input-email", "returning@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  check("Login submit routes to onboarding for a fresh session", await page.isVisible("#screen-onboarding"));

  // Re-onboard for this "returning" session
  await page.fill("#input-dob", "1990-02-10");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time"); // test unknown-time path this time
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Delhi"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);
  check("Dashboard shows Unknown rising for unknown-time path", (await page.textContent("#label-asc")).includes("Unknown"));

  // 9. Full report BEFORE generating palm/compat -> check recovery links present
  await page.click('.screen.active [data-nav="screen-report"]');
  await page.waitForTimeout(100);
  await page.click("#btn-report-checkout");
  await page.waitForTimeout(100);

  // 10. Netbanking payment path (never tested end-to-end before)
  await page.click('[data-pay="netbanking"]');
  await page.waitForTimeout(100);
  check("Netbanking panel visible", await page.isVisible("#pay-netbanking"));
  await page.selectOption("#input-bank", "HDFC Bank");
  await page.click("#btn-pay-submit");
  await page.waitForTimeout(2200);
  check("Netbanking payment reaches success screen", await page.isVisible("#screen-success"));
  await page.click("#btn-success-continue");
  await page.waitForTimeout(300);

  // 11. Full report recovery links (palm never generated, compat never generated THIS session)
  const palmLinkText = await page.textContent("#fr-palm");
  const compatLinkText = await page.textContent("#fr-compat");
  check("Full report shows palm recovery prompt", palmLinkText.includes("haven't generated"));
  check("Full report shows compat recovery prompt", compatLinkText.includes("haven't run"));
  await page.click('#fr-palm [data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  check("Clicking palm recovery link navigates to palm screen", await page.isVisible("#screen-palm"));

  // 12. Year Ahead + Saturn return / compat sections appear correctly in full report for THIS session
  await page.click(".bottom-nav [data-nav=\"screen-fullreport\"]");
  await page.waitForTimeout(150);
  const yaSection = await page.textContent("#fr-yearahead");
  check("Full report Year Ahead section populated", yaSection.includes("Jupiter"));

  // 13. Subscription tier selection + checkout price reflects it
  await page.click(".bottom-nav [data-nav=\"screen-dashboard\"]"); await page.waitForTimeout(100);
  await page.click('.screen.active [data-nav="screen-report"]');
  await page.waitForTimeout(100);
  check("Report screen shows Already Unlocked (already paid this session)", (await page.textContent("#btn-report-checkout")).includes("Already Unlocked"));

  console.log("\n=== JS ERRORS ===", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log("\n=== RESULT:", results.length - failed.length, "/", results.length, "checks passed ===");
  if (failed.length) { console.log("FAILED CHECKS:"); failed.forEach(f => console.log(" -", f.label)); }

  await browser.close();
  process.exit(failed.length || errors.length ? 1 : 0);
})();
