// Self-test for app/test-guard.js: proves, on THIS machine, that a guarded browser cannot reach
// production Supabase (REST and realtime WebSocket), Razorpay, or the CDN the app loads
// supabase-js from, while localhost and file:// still work.
//
//   NODE_PATH=$HOME/comet-karts/node_modules node app/test-guard-selftest.js
//
// The probes carry no credentials (no apikey, no token), so even if the guard were broken they
// could not write anything. A neutral control host (example.com) is probed FIRST: if it is
// reachable the guard is not working and the run stops before touching any real host.
// Run it before the browser tests; app/run-tests.js does so automatically.

const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchGuarded } = require("./test-guard");

const SUPABASE_HOST = "xinelwrxgveztrtokwbt.supabase.co";   // the production project in app/supabase-client.js

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) pass++; else fail++;
  console.log((cond ? "PASS" : "FAIL") + " - " + label + (extra ? "  [" + extra + "]" : ""));
  return !!cond;
}

(async () => {
  // A local page to run the probes from, and a local endpoint that must stay reachable.
  const server = http.createServer((req, res) => {
    if (req.url === "/ping") { res.setHeader("Content-Type", "text/plain"); res.end("pong"); return; }
    res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>probe</title><body>probe</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-selftest-"));
  const filePage = path.join(tmp, "page.html");
  fs.writeFileSync(filePage, "<!doctype html><title>file page</title><body>file</body>");

  const browser = await launchGuarded(chromium, { headless: true });
  const page = await browser.newPage();
  const failures = [];
  page.on("requestfailed", (r) => failures.push({ url: r.url(), text: (r.failure() && r.failure().errorText) || "" }));
  await page.goto(local + "/");

  const probeFetch = (url) => page.evaluate(async (u) => {
    try { await fetch(u, { mode: "no-cors", cache: "no-store" }); return "REACHED"; } catch (e) { return "failed"; }
  }, url);
  const probeScript = (url) => page.evaluate((u) => new Promise((resolve) => {
    const s = document.createElement("script"); s.src = u; s.onload = () => resolve("REACHED"); s.onerror = () => resolve("failed");
    document.head.appendChild(s); setTimeout(() => resolve("timeout"), 8000);
  }), url);
  const probeWebSocket = (url) => page.evaluate((u) => new Promise((resolve) => {
    let opened = false;
    let ws; try { ws = new WebSocket(u); } catch (e) { resolve("failed"); return; }
    ws.onopen = () => { opened = true; resolve("REACHED"); try { ws.close(); } catch (e) {} };
    ws.onerror = () => resolve(opened ? "REACHED" : "failed");
    ws.onclose = () => resolve(opened ? "REACHED" : "failed");
    setTimeout(() => resolve(opened ? "REACHED" : "timeout"), 8000);
  }), url);
  const dnsFailed = (host) => failures.some((f) => f.url.includes(host) && /ERR_NAME_NOT_RESOLVED/.test(f.text));

  console.log("== control: a neutral host must be unreachable (checked first; stops here if not) ==");
  const control = await probeFetch("https://example.com/");
  const controlOk = check("https://example.com is unreachable (guard is active)", control === "failed" && dnsFailed("example.com"), `${control}; DNS-blocked=${dnsFailed("example.com")}`);
  if (!controlOk) {
    console.log("\nGUARD NOT EFFECTIVE: stopping before probing any real host. Do NOT run the browser tests on this machine.");
    await browser.close(); server.close(); process.exit(1);
  }

  console.log("\n== production and payment hosts must be unreachable ==");
  const rest = await probeFetch(`https://${SUPABASE_HOST}/rest/v1/`);
  check(`Supabase REST API (${SUPABASE_HOST}) is unreachable`, rest === "failed" && dnsFailed(SUPABASE_HOST), `${rest}; DNS-blocked=${dnsFailed(SUPABASE_HOST)}`);
  const ws = await probeWebSocket(`wss://${SUPABASE_HOST}/realtime/v1/websocket?vsn=1.0.0`);
  check(`Supabase realtime WebSocket (wss://${SUPABASE_HOST}/realtime/v1/websocket) never opens`, ws === "failed", ws);
  const rzpScript = await probeScript("https://checkout.razorpay.com/v1/checkout.js");
  check("Razorpay checkout script (checkout.razorpay.com) is unreachable", rzpScript === "failed" && dnsFailed("checkout.razorpay.com"), `${rzpScript}; DNS-blocked=${dnsFailed("checkout.razorpay.com")}`);
  const rzpApi = await probeFetch("https://api.razorpay.com/v1/");
  check("Razorpay API (api.razorpay.com) is unreachable", rzpApi === "failed" && dnsFailed("api.razorpay.com"), `${rzpApi}; DNS-blocked=${dnsFailed("api.razorpay.com")}`);
  const cdn = await probeScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
  check("the CDN the app loads supabase-js from (cdn.jsdelivr.net) is unreachable, so the app stays in demo mode", cdn === "failed" && dnsFailed("cdn.jsdelivr.net"), `${cdn}; DNS-blocked=${dnsFailed("cdn.jsdelivr.net")}`);

  console.log("\n== what must still work ==");
  const ping = await page.evaluate(async () => { try { return await (await fetch("/ping")).text(); } catch (e) { return "error"; } });
  check("localhost still works (a local fake server stays reachable)", ping === "pong", ping);
  await page.goto("file://" + filePage);
  check("file:// pages still load (the tests open the built app this way)", (await page.title()) === "file page");

  console.log("\n== the guard itself ==");
  const { GUARD_ARGS } = require("./test-guard");
  check("the browser is launched with the block-all rule and no system proxy", GUARD_ARGS.some((a) => /host-resolver-rules=MAP \* ~NOTFOUND/.test(a)) && GUARD_ARGS.includes("--no-proxy-server"));

  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n=== GUARD SELF-TEST: ${pass} / ${pass + fail} checks passed ===`);
  if (fail) console.log("GUARD NOT PROVEN: do NOT run the browser tests on this machine.");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("FATAL", e.stack || e.message); process.exit(1); });
