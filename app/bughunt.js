const { chromium } = require("playwright");
const path = require("path");

const findings = [];
function note(id, desc, severity) { findings.push({ id, desc, severity }); console.log(`[${severity}] ${id}: ${desc}`); }

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));

  // --- TEST 1: Auth validation ---
  await page.click("#btn-landing-start");
  await page.click("#btn-auth-submit"); // empty everything
  let toastText = await page.textContent("#toast");
  console.log("Empty submit toast:", toastText);

  await page.fill("#input-email", "not-an-email");
  await page.fill("#input-password", "123456");
  await page.fill("#input-name", "Bug Hunter");
  await page.click("#btn-auth-submit");
  toastText = await page.textContent("#toast");
  console.log("Bad email toast:", toastText);
  if (!toastText.toLowerCase().includes("email")) note("AUTH-1", "Invalid email did not surface a clear toast", "medium");

  await page.fill("#input-email", "bughunter@example.com");
  await page.fill("#input-password", "123");
  await page.click("#btn-auth-submit");
  toastText = await page.textContent("#toast");
  console.log("Short password toast:", toastText);

  // --- TEST 2: Onboarding back navigation ---
  await page.fill("#input-password", "123456");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  const stepVisible = async (n) => page.isVisible(`#onb-step-${n}`);
  console.log("step0 visible:", await stepVisible(0));

  await page.fill("#input-dob", "1990-01-01");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  console.log("step1 visible after next:", await stepVisible(1));

  await page.click("#btn-onb-back");
  await page.waitForTimeout(100);
  console.log("back from step1 -> step0 visible:", await stepVisible(0));
  const dobPreserved = await page.inputValue("#input-dob");
  console.log("DOB preserved after back:", dobPreserved);
  if (dobPreserved !== "1990-01-01") note("ONB-1", "DOB value lost when navigating back a step", "high");

  // --- TEST 3: Future DOB (should probably be rejected, currently likely allowed) ---
  await page.fill("#input-dob", "2099-01-01");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  const advancedWithFutureDob = await stepVisible(1);
  console.log("Advanced past step0 with a FUTURE dob (2099):", advancedWithFutureDob);
  if (advancedWithFutureDob) note("ONB-2", "Future date of birth (e.g. 2099) is accepted with no validation", "medium");
  else console.log("  -> FIXED: future date correctly rejected, still on step0");
  // proceed with a sane date (still on step0 since the future date was rejected)
  await page.fill("#input-dob", "1990-01-01");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);

  await page.fill("#input-tob", "10:30");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  await page.click("#input-city");
  await page.fill("#city-search", "Pune");
  await page.waitForTimeout(100);
  await page.click(".city-item");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); // calculate
  await page.waitForTimeout(3200);
  console.log("Reached dashboard:", await page.isVisible("#screen-dashboard"));

  // --- TEST 4: Palm reading full answer + generate, then logout, then re-signup, check for stale state ---
  await page.click('[data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  const qids = await page.$$eval(".option-grid", els => els.map(e => e.dataset.qid));
  for (const qid of qids) await page.click(`.option-grid[data-qid="${qid}"] .option-btn:nth-child(2)`);
  await page.click("#btn-palm-generate");
  await page.waitForTimeout(150);
  console.log("Palm result shown:", await page.isVisible("#palm-result"));

  await page.click(".screen.active [data-back=\"screen-dashboard\"]");
  await page.waitForTimeout(100);
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);

  // New user signs up
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Second User");
  await page.fill("#input-email", "second@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);

  const staleDob = await page.inputValue("#input-dob");
  console.log("DOB field value for brand-new second user (should be empty):", JSON.stringify(staleDob));
  if (staleDob) note("RESET-1", `Onboarding date field retains previous user's DOB ("${staleDob}") after logout + new signup`, "high");

  await page.fill("#input-dob", "2001-11-20");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  const staleTob = await page.inputValue("#input-tob");
  const unknownStillChecked = await page.evaluate(() => document.getElementById("check-unknown-time").classList.contains("checked"));
  console.log("TOB field for second user (should be empty):", JSON.stringify(staleTob), "| unknown-time still checked:", unknownStillChecked);
  if (staleTob) note("RESET-2", `Onboarding time field retains previous user's time ("${staleTob}") after logout + new signup`, "high");

  await page.fill("#input-tob", "14:00");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  const staleCity = await page.inputValue("#input-city");
  console.log("City field for second user (should be empty):", JSON.stringify(staleCity));
  if (staleCity) note("RESET-3", `Onboarding city field retains previous user's city ("${staleCity}") after logout + new signup`, "high");

  await page.click("#input-city");
  await page.fill("#city-search", "Chennai");
  await page.waitForTimeout(100);
  await page.click(".city-item");
  await page.click("#btn-onb-next");
  await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);

  // Now check palm screen for stale selections / stale enabled Generate button
  await page.click('[data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  const generateDisabled = await page.evaluate(() => document.getElementById("btn-palm-generate").disabled);
  const selectedCount = await page.evaluate(() => document.querySelectorAll(".option-btn.selected").length);
  console.log("Second user palm screen -> Generate disabled:", generateDisabled, "| stale selected option buttons:", selectedCount);
  if (!generateDisabled) note("PALM-1", "Generate button is enabled for a brand-new user who hasn't answered any palm questions yet (stale state from previous user)", "high");
  if (selectedCount > 0) note("PALM-2", `${selectedCount} palm option buttons show as visually selected for a brand-new user who never answered them`, "high");

  if (!generateDisabled) {
    await page.click("#btn-palm-generate");
    await page.waitForTimeout(150);
    const palmLine0 = await page.textContent("#palm-line-0");
    console.log("Palm line0 text if generated with stale/empty answers:", JSON.stringify(palmLine0));
    if (!palmLine0 || !palmLine0.trim()) note("PALM-3", "Clicking Generate with empty answers produces a blank palm report (no free line, likely empty locked section too)", "high");
  }

  console.log("\nJS ERRORS DURING BUG HUNT:", jsErrors.length);
  jsErrors.forEach(e => console.log(" -", e));

  console.log("\n=== FINDINGS SUMMARY ===");
  findings.forEach(f => console.log(`${f.severity.toUpperCase()} | ${f.id} | ${f.desc}`));

  await browser.close();
})();
