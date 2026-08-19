// Playwright test for responsive layout across phone/tablet/desktop viewports.
// Covers: mobile is pixel-behavior-identical to before (nav fixed, single column),
// the tablet/desktop "phone card" shell properly CONTAINS the nav bar (regression
// test for a real bug found during this pass — the nav used to render pinned to the
// literal browser window edge, visibly detached from the rounded card above it),
// the desktop nav reflows into a horizontal bar, grid-list containers reflow into
// multiple columns at wider widths, and scrolling still reaches below-the-fold
// content at every size.
const { chromium } = require("playwright");
const path = require("path");

function check(label, cond, results) {
  results.push({ label, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
}

async function reachDashboard(page) {
  await page.click("#btn-landing-start");
  await page.fill("#input-name", "Responsive Tester");
  await page.fill("#input-email", "responsive@example.com");
  await page.fill("#input-password", "abcdef");
  await page.click("#btn-auth-submit");
  await page.waitForTimeout(150);
  await page.fill("#input-dob", "1990-08-10");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#toggle-unknown-time");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#input-city"); await page.fill("#city-search", "Mumbai"); await page.waitForTimeout(100); await page.click(".city-item");
  await page.click("#btn-onb-next"); await page.waitForTimeout(100);
  await page.click("#btn-onb-next");
  await page.waitForTimeout(3200);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });
  const results = [];
  const errors = [];

  console.log("== Group 1: mobile (390x844) — must be pixel-behavior-identical to the pre-existing design ==");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => errors.push("PAGEERROR(mobile): " + e.message));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR(mobile): " + msg.text()); });
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await reachDashboard(page);
    const rootWidth = await page.$eval("#app-root", el => el.getBoundingClientRect().width);
    check("Mobile app shell is full viewport width (no card/margin treatment)", Math.round(rootWidth) === 390, results);
    const exploreDisplay = await page.$eval(".stack.grid-list", el => getComputedStyle(el).display);
    check("Mobile Explore list stays a plain flex column (no grid) below 700px", exploreDisplay === "flex", results);
    const navPosition = await page.$eval("#bottom-nav", el => getComputedStyle(el).position);
    check("Mobile nav bar is position:fixed (unchanged mobile behavior)", navPosition === "fixed", results);
    const navFlexDir = await page.$eval(".nav-item", el => getComputedStyle(el).flexDirection);
    check("Mobile nav items stay stacked icon-over-label (not the desktop horizontal style)", navFlexDir === "column", results);
    await page.close();
  }

  console.log("\n== Group 2: tablet (768x900) — widened card, 2-col grids, still mobile-style stacked nav ==");
  {
    const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
    page.on("pageerror", (e) => errors.push("PAGEERROR(tablet): " + e.message));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR(tablet): " + msg.text()); });
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await reachDashboard(page);
    const rootWidth = await page.$eval("#app-root", el => el.getBoundingClientRect().width);
    check("Tablet app shell widens beyond the mobile 460px cap", rootWidth > 460 && rootWidth <= 660, results);
    const exploreDisplay = await page.$eval(".stack.grid-list", el => getComputedStyle(el).display);
    check("Tablet Explore list becomes a CSS grid at >=700px", exploreDisplay === "grid", results);
    const tileCols = await page.$$eval(".stack.grid-list .card", els => {
      const tops = els.slice(0, 2).map(e => Math.round(e.getBoundingClientRect().top));
      return tops[0] === tops[1]; // first two tiles share the same row (side-by-side)
    });
    check("Tablet Explore tiles actually sit side-by-side (2 columns), not just display:grid with 1 column", tileCols, results);
    const navPosition = await page.$eval("#bottom-nav", el => getComputedStyle(el).position);
    check("Tablet nav bar switches to position:absolute (anchored to the card, not the viewport)", navPosition === "absolute", results);
    const navFlexDir = await page.$eval(".nav-item", el => getComputedStyle(el).flexDirection);
    check("Tablet nav items stay stacked (still touch-oriented below the 1024px desktop breakpoint)", navFlexDir === "column", results);
    await page.close();
  }

  console.log("\n== Group 3: desktop (1280x700) — nav bar containment fix (regression test) + horizontal nav + scrolling ==");
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    page.on("pageerror", (e) => errors.push("PAGEERROR(desktop): " + e.message));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push("CONSOLE ERROR(desktop): " + msg.text()); });
    await page.goto("file://" + path.resolve(__dirname, "nakshatra-app.html"));
    await reachDashboard(page);

    const rootWidth = await page.$eval("#app-root", el => el.getBoundingClientRect().width);
    check("Desktop app shell widens further still (up to the 800px cap)", rootWidth > 660 && rootWidth <= 820, results);

    // The actual bug found in this pass: at desktop widths the pre-fix nav bar was
    // position:fixed to the VIEWPORT, so once #app-root became a bounded, margined
    // card it visually detached — the nav floated at the literal bottom of the
    // browser window instead of the bottom of the card. Assert the two boxes now align.
    const navBox = await page.$eval("#bottom-nav", el => el.getBoundingClientRect());
    const rootBox = await page.$eval("#app-root", el => el.getBoundingClientRect());
    check("Nav bar's bottom edge aligns with the card's bottom edge (regression: used to float separately)", Math.abs(navBox.bottom - rootBox.bottom) < 3, results);
    check("Nav bar's left/right edges align with the card's edges (properly contained, not full-viewport-width)", Math.abs(navBox.left - rootBox.left) < 3 && Math.abs(navBox.right - rootBox.right) < 3, results);

    const navFlexDir = await page.$eval(".nav-item", el => getComputedStyle(el).flexDirection);
    check("Desktop nav items reflow horizontally (icon beside label, not stacked)", navFlexDir === "row", results);

    const exploreDisplay = await page.$eval(".stack.grid-list", el => getComputedStyle(el).display);
    check("Desktop Explore list is a grid", exploreDisplay === "grid", results);

    // Scrolling: the viewport (700px tall) is shorter than the full dashboard content,
    // so below-the-fold tiles must still be reachable by scrolling — this is the
    // practical check that overflow:hidden on #app-root isn't clipping real content.
    const beforeScroll = await page.isVisible('[data-nav="screen-community"]');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    const communityBox = await page.$eval('[data-nav="screen-community"]', el => el.getBoundingClientRect());
    check("Scrolling reaches below-the-fold content (not clipped by overflow:hidden on the card)", communityBox.top >= 0 && communityBox.top < 700, results);
    await page.click('[data-nav="screen-community"]');
    await page.waitForTimeout(200);
    check("A below-the-fold tile reached by scrolling is still clickable/functional", await page.isVisible("#screen-community.active"), results);

    // Chat bubble width cap
    await page.click('.screen.active [data-back="screen-dashboard"]');
    await page.waitForTimeout(100);
    await page.click('[data-nav="screen-chat-picker"]');
    await page.waitForTimeout(150);
    await page.click('[data-astro="priya"]');
    await page.waitForTimeout(150);
    const bubbleWidth = await page.$eval(".chat-bubble.astro", el => el.getBoundingClientRect().width);
    check("Chat bubbles are capped to a reasonable fixed width on desktop (not 78% of an 800px card)", bubbleWidth <= 420, results);

    await page.close();
  }

  console.log("\nJS ERRORS:", errors.length);
  errors.forEach(e => console.log(" -", e));
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== RESULT: ${results.length - failed.length} / ${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:", failed.map(f => f.label));

  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
