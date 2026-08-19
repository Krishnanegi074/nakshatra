// Playwright integration test for the Phase 3 "Scan Palm From Photo" UI:
// upload -> crop rectangle appears -> drag/resize it -> Scan -> suggestions
// get applied to the question buttons -> user can still override -> Generate
// still works end to end. This exercises the actual browser canvas/ImageData
// path, not just the Node-side cv-engine.js unit tests.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR: " + msg.text()); });

  if (!fs.existsSync("shots-cv")) fs.mkdirSync("shots-cv");
  const shot = (name) => page.screenshot({ path: `shots-cv/${name}.png` });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Aisha Khan");
  await page.fill("#input-email", "aisha@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1994-06-05");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.fill("#input-tob", "09:15");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Mumbai"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);

  await page.click('.bottom-nav [data-nav="screen-palm"]');
  await page.waitForTimeout(150);

  // --- Upload the synthetic palm photo ---
  const fileInput = await page.$("#palm-file-input");
  await fileInput.setInputFiles(path.resolve(__dirname, "test-assets-palm.png"));
  await page.waitForTimeout(300);
  const cropVisible = await page.isVisible("#palm-crop-rect");
  console.log("Crop rectangle visible after upload:", cropVisible);
  await shot("01-crop-default");

  const rectBoxBefore = await page.evaluate(() => {
    const el = document.getElementById("palm-crop-rect");
    return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
  });
  console.log("Default crop rect:", JSON.stringify(rectBoxBefore));

  // --- Drag the rectangle body to move it ---
  const wrapBox = await page.$eval("#palm-crop-wrap", el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top }; });
  const rectBox = await page.$eval("#palm-crop-rect", el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  const centerX = rectBox.left + rectBox.width / 2, centerY = rectBox.top + rectBox.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 15, centerY + 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const rectBoxAfterMove = await page.evaluate(() => {
    const el = document.getElementById("palm-crop-rect");
    return { left: el.style.left, top: el.style.top };
  });
  console.log("Crop rect after drag-move:", JSON.stringify(rectBoxAfterMove), "(should differ from default x/y)");

  // --- Drag a corner handle to resize ---
  const handleBox = await page.$eval('.crop-handle[data-h="br"]', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(handleBox.x, handleBox.y);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 20, handleBox.y - 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await shot("02-crop-after-drag-resize");

  // --- Run the scan ---
  await page.click("#btn-palm-analyze");
  await page.waitForTimeout(300);
  const statusText = await page.textContent("#palm-cv-status");
  console.log("Scan status text:", statusText);
  await shot("03-post-scan-suggestions");

  // Check that suggestions were applied: analyzable questions should have a selected option + visible cv-tag
  const ANALYZABLE = ["lifeLength", "lifeDepth", "heartShape", "headShape", "fate", "heartStart"];
  for (const qid of ANALYZABLE) {
    const info = await page.evaluate((qid) => {
      const group = document.querySelector(`.option-grid[data-qid="${qid}"]`);
      const selected = group ? group.querySelector(".option-btn.selected") : null;
      const tag = document.getElementById("cv-tag-" + qid);
      return {
        hasSelection: !!selected,
        selectedValue: selected ? selected.dataset.v : null,
        tagVisible: tag ? tag.style.display !== "none" : false,
        tagText: tag ? tag.textContent : null,
      };
    }, qid);
    console.log(`  [${qid}]`, JSON.stringify(info));
  }

  // "mount" is the one question left manual by design (see cv-engine.js) — it
  // must NOT have been auto-selected, but the photo should now carry finger
  // labels (Index/Middle/Ring/Pinky/Thumb) so answering it needs no palmistry
  // knowledge, just a glance at the labeled picture.
  const mountInfo = await page.evaluate(() => {
    const group = document.querySelector('.option-grid[data-qid="mount"]');
    const selected = group ? group.querySelector(".option-btn.selected") : null;
    return { hasSelection: !!selected };
  });
  console.log("  [mount] (should be manual-only, hasSelection=false):", JSON.stringify(mountInfo));

  const fingerLabels = await page.evaluate(() => {
    const box = document.getElementById("palm-finger-labels");
    return box ? Array.from(box.children).map(el => ({ text: el.textContent, left: el.style.left, top: el.style.top })) : [];
  });
  console.log("Finger labels rendered on photo:", JSON.stringify(fingerLabels));

  // Generate button should still be disabled (mount unanswered)
  const genDisabled = await page.evaluate(() => document.getElementById("btn-palm-generate").disabled);
  console.log("Generate disabled before mount answered:", genDisabled);

  // --- User overrides one scanned suggestion ---
  const heartGroup = await page.$('.option-grid[data-qid="heartShape"]');
  const heartButtons = await heartGroup.$$(".option-btn");
  await heartButtons[0].click(); // click first option regardless of what's selected, to test override path
  await page.waitForTimeout(100);
  const heartTagHiddenAfterOverride = await page.evaluate(() => {
    const tag = document.getElementById("cv-tag-heartShape");
    return tag.style.display === "none";
  });
  console.log("cv-tag hidden after manual override of heartShape:", heartTagHiddenAfterOverride);

  // --- Answer the one manual-only question (mount) to complete the form ---
  await page.click('.option-grid[data-qid="mount"] .option-btn:first-child');
  await page.waitForTimeout(100);
  const genEnabledNow = await page.evaluate(() => !document.getElementById("btn-palm-generate").disabled);
  console.log("Generate enabled after all 7 questions answered:", genEnabledNow);

  await page.click("#btn-palm-generate");
  await page.waitForTimeout(200);
  const resultShown = await page.isVisible("#palm-result");
  console.log("Palm result screen shown after Generate:", resultShown);
  await shot("04-palm-result");

  // --- Edge case: logout and start a second user, upload a DIFFERENT photo, verify no stale crop/tags/suggestions ---
  await page.click('.bottom-nav [data-nav="screen-dashboard"]');
  await page.waitForTimeout(100);
  await page.click("#btn-dash-logout");
  await page.waitForTimeout(150);
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Second User");
  await page.fill("#input-email", "second@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1988-03-03");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Delhi"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next"); await page.waitForTimeout(3200);
  await page.click('.bottom-nav [data-nav="screen-palm"]');
  await page.waitForTimeout(150);
  const staleCropVisible = await page.isVisible("#palm-crop-rect");
  const staleTagVisible = await page.evaluate(() => {
    const tag = document.getElementById("cv-tag-heartShape");
    return tag ? tag.style.display !== "none" : false;
  });
  const staleSelection = await page.evaluate(() => document.querySelectorAll(".option-btn.selected").length);
  console.log("RESET-CHECK: stale crop rect visible for new user:", staleCropVisible, "| stale cv-tag visible:", staleTagVisible, "| stale selected buttons:", staleSelection);

  // --- Low-quality photo: a blank/featureless image should trigger the
  // "try a clearer photo" guidance instead of silently showing bogus answers ---
  const blankFileInput = await page.$("#palm-file-input");
  await blankFileInput.setInputFiles(path.resolve(__dirname, "test-assets-palm-blank.png"));
  await page.waitForTimeout(300);
  await page.click("#btn-palm-analyze");
  await page.waitForTimeout(300);
  const qualityWarningVisible = await page.isVisible("#palm-quality-warning");
  const qualityStatusText = await page.textContent("#palm-cv-status");
  console.log("Blank photo -> quality warning shown:", qualityWarningVisible, "| status text:", qualityStatusText);
  await shot("05-blank-photo-quality-warning");

  console.log("\nERRORS FOUND:", errors.length);
  errors.forEach(e => console.log(" -", e));

  await browser.close();
})();
