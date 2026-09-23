// Regression test for item #18 of the full-site QA pass: "palm upload has no
// validation." Before this fix, #palm-file-input's change handler did
// FileReader.readAsDataURL() immediately with no MIME check, no size limit,
// no HEIC/HEIF rejection, and no img.onerror handler — an unrenderable file
// (or an oversized one) left the visitor stuck on the upload screen with no
// feedback, or hung the tab trying to FileReader a huge file.
//
// This exercises the real browser upload path (not a Node-side unit test),
// following the same flow test-cv-ui.js already uses to reach screen-palm.
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
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg.text())) return;
    errors.push("CONSOLE ERROR: " + msg.text());
  });

  await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Palm Tester");
  await page.fill("#input-email", "palmtester@example.com");
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

  const fileInput = await page.$("#palm-file-input");
  const toastText = () => page.textContent("#toast");
  const cropWrapVisible = () => page.evaluate(() => document.getElementById("palm-crop-wrap").style.display !== "none");
  const uploadBoxVisible = () => page.evaluate(() => document.getElementById("palm-upload-box").style.display !== "none");

  // ---------------- HEIC rejection ----------------
  await fileInput.setInputFiles({ name: "iphone-palm.heic", mimeType: "image/heic", buffer: Buffer.from("fake heic bytes") });
  await page.waitForTimeout(150);
  check("HEIC file is rejected with a friendly toast (not silently accepted)", (await toastText()).toLowerCase().includes("heic"), results);
  check("HEIC rejection leaves the upload box showing (does not advance to crop screen)", await uploadBoxVisible(), results);
  check("HEIC rejection does not show the crop screen", !(await cropWrapVisible()), results);

  // ---------------- Non-image file rejected ----------------
  await fileInput.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("just some text, not a photo") });
  await page.waitForTimeout(150);
  const nonImageToast = (await toastText()).toLowerCase();
  check("Non-image file is rejected with a friendly toast", nonImageToast.includes("photo") || nonImageToast.includes("image"), results);
  check("Non-image rejection does not show the crop screen", !(await cropWrapVisible()), results);

  // ---------------- Oversized file rejected ----------------
  const oversized = Buffer.alloc(13 * 1024 * 1024, 1); // 13MB > the 12MB cap
  await fileInput.setInputFiles({ name: "huge-photo.png", mimeType: "image/png", buffer: oversized });
  await page.waitForTimeout(150);
  const oversizedToast = (await toastText()).toLowerCase();
  check("Oversized file is rejected with a friendly toast mentioning size", oversizedToast.includes("large") || oversizedToast.includes("12mb") || oversizedToast.includes("mb"), results);
  check("Oversized-file rejection does not show the crop screen", !(await cropWrapVisible()), results);

  // ---------------- Corrupt/undecodable image handled via img.onerror ----------------
  // Passes the MIME + size checks (claims to be a small PNG) but isn't real
  // image data, so the browser's <img> decode will fail — this is exactly
  // the "unrenderable file" case the missing img.onerror handler used to
  // leave silently stuck.
  await fileInput.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("not actually a png") });
  await page.waitForTimeout(300);
  const corruptToast = (await toastText()).toLowerCase();
  check("Undecodable image triggers img.onerror with a friendly toast (not a silent stuck screen)", corruptToast.includes("couldn't open") || corruptToast.includes("format"), results);
  check("Undecodable-image rejection does not leave the crop screen showing", !(await cropWrapVisible()), results);
  check("Undecodable-image rejection leaves the upload box available to try again", await uploadBoxVisible(), results);

  // ---------------- A real, valid image still works after all those rejections ----------------
  const validPng = await page.evaluate(() => {
    // 1x1 transparent PNG, base64-encoded — tiny, always decodes.
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  });
  await fileInput.setInputFiles({ name: "real-palm.png", mimeType: "image/png", buffer: Buffer.from(validPng, "base64") });
  await page.waitForTimeout(300);
  check("A genuinely valid PNG still advances to the crop screen (validation isn't over-strict)", await cropWrapVisible(), results);

  check("No unexpected JS errors across the whole validation sequence", errors.length === 0, results);
  if (errors.length) errors.forEach((e) => console.log(" -", e));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.label));
  process.exit(failed.length ? 1 : 0);
})();
