// Local preview of the BUILT app, in demo mode, with no way to reach production.
//
//   NODE_PATH=$HOME/comet-karts/node_modules node app/preview.js            # rebuilds, opens a window
//   NODE_PATH=$HOME/comet-karts/node_modules node app/preview.js --check    # headless self-check, then exits
//   options: --no-build  --port 8765  --headless
//
// WHY. Opening app/nakshatra-app.html in an ordinary browser tab connects to the REAL Supabase project and, with
// live Razorpay keys, to real checkout. This helper opens it in a browser started through launchGuarded() (the same
// network block the tests use: every hostname except localhost / 127.0.0.1 fails to resolve), so supabase-js never
// loads, the app stays in demo mode (accounts live in the page only) and nothing can leave the machine.
//
// It refuses to open the app unless it first proves the block works: a neutral host and the production Supabase host
// must both be unreachable from the page. The server binds to 127.0.0.1 and serves only the built file.
// What demo mode cannot show: anything that needs the backend (real accounts, payments, expert chat, the refund note).

const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { launchGuarded } = require("./test-guard");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const CHECK = flag("--check");
const HEADLESS = CHECK || flag("--headless");
const PORT = Number(val("--port", 0));
const SUPABASE_HOST = "xinelwrxgveztrtokwbt.supabase.co";   // production project in app/supabase-client.js
const BUILT = path.join(__dirname, "nakshatra-app.html");

function die(msg) { console.error("\n" + msg + "\n"); process.exit(1); }

if (!flag("--no-build")) {
  const b = spawnSync("node", ["build.js"], { cwd: __dirname, stdio: "inherit" });
  if (b.status !== 0) die("app/build.js failed.");
}
if (!fs.existsSync(BUILT)) die("app/nakshatra-app.html is missing: run without --no-build.");
const html = fs.readFileSync(BUILT);
const text = html.toString("utf8");
const markers = {
  "window.NAKSHATRA_BETA=true": (text.match(/window\.NAKSHATRA_BETA=true/g) || []).length,
  "noindex": (text.match(/noindex/g) || []).length,
  "PRIVATE BETA": (text.match(/PRIVATE BETA/g) || []).length,
};

(async () => {
  // Only ever served on loopback, and only the one file.
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/nakshatra-app.html"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } else { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await launchGuarded(chromium, {
    headless: HEADLESS,
    args: HEADLESS ? [] : ["--window-size=470,960", "--window-position=80,40"],
  });
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const blocked = new Map();
  context.on("requestfailed", (r) => {
    try { const h = new URL(r.url()).hostname; if (/ERR_NAME_NOT_RESOLVED/.test((r.failure() || {}).errorText || "")) blocked.set(h, (blocked.get(h) || 0) + 1); } catch (_) {}
  });
  const page = await context.newPage();
  // A small label so a preview window can never be mistaken for the real site. Added in the browser only; it is not in the build.
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const d = document.createElement("div");
      d.textContent = "PREVIEW · DEMO MODE · no backend";
      d.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#1f3a5f;color:#fff;font:600 10px/1 sans-serif;text-align:center;padding:3px;pointer-events:none;opacity:.85";
      document.body.appendChild(d);
    });
  });

  // 1. Prove the block BEFORE showing the app (credential-free probes; stops at the first sign it is not working).
  await page.goto(url + "?guard-check");
  const reach = (u) => page.evaluate(async (x) => { try { await fetch(x, { mode: "no-cors", cache: "no-store" }); return "REACHED"; } catch (e) { return "failed"; } }, u);
  const control = await reach("https://example.com/");
  if (control !== "failed") { await browser.close(); server.close(); die("GUARD NOT EFFECTIVE (example.com was reachable). Nothing was opened. Do not use a normal browser tab on the built app either."); }
  const prod = await reach(`https://${SUPABASE_HOST}/rest/v1/`);
  if (prod !== "failed") { await browser.close(); server.close(); die("GUARD NOT EFFECTIVE (production Supabase was reachable). Nothing was opened."); }

  // 2. Open the app and confirm it is in demo mode.
  await page.goto(url);
  await page.waitForTimeout(600);
  const demo = await page.evaluate(() => typeof window.supabase === "undefined");
  const landing = await page.evaluate(() => !!document.querySelector("#btn-landing-start"));
  console.log("Guard proven: example.com and the production Supabase host are unreachable from this window.");
  console.log(`App loaded: ${landing ? "landing screen visible" : "LANDING NOT FOUND"} | demo mode (no supabase client): ${demo ? "yes" : "NO"}`);
  console.log(`Beta markers in this build: NAKSHATRA_BETA=true ${markers["window.NAKSHATRA_BETA=true"]}, noindex ${markers.noindex}, PRIVATE BETA ${markers["PRIVATE BETA"]}  (all three must be 0 for a release)`);
  if (!demo) { await browser.close(); server.close(); die("The app is NOT in demo mode (a supabase client exists). Closing."); }

  const summary = () => {
    const hosts = [...blocked.entries()].map(([h, n]) => `${h} x${n}`).join(", ") || "none";
    console.log(`Blocked outbound requests: ${hosts}`);
  };
  if (CHECK) {
    const ok = landing && demo && markers["window.NAKSHATRA_BETA=true"] === 0 && markers.noindex === 0 && markers["PRIVATE BETA"] === 0;
    summary();
    console.log(ok ? "\nPREVIEW SELF-CHECK PASSED" : "\nPREVIEW SELF-CHECK FAILED");
    await browser.close(); server.close(); process.exit(ok ? 0 : 1);
  }

  console.log(`\nPreview open at ${url}  (DEMO MODE: accounts exist only inside this window, nothing is sent anywhere).`);
  console.log("Sign up with any made-up details to look around. Close the window, or press Ctrl+C, to stop.");
  const stop = async () => { summary(); try { await browser.close(); } catch (_) {} server.close(); process.exit(0); };
  browser.on("disconnected", () => { summary(); server.close(); process.exit(0); });
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
