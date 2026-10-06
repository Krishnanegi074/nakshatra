// Test guard: every browser test must launch its browser through launchGuarded().
//
// WHY. The app embeds the production Supabase URL and key. The browser tests were written in a
// sandbox with no internet, where the real supabase-js never loaded and the app fell back to demo
// mode. On a machine with internet the same tests sign up real accounts, create real Razorpay
// orders and write real rows (a Mac run on 2026-10-06 created 13 junk accounts in production).
//
// WHAT. launchGuarded() starts Chromium with a host-resolver rule that makes EVERY hostname except
// localhost / 127.0.0.1 fail to resolve (net::ERR_NAME_NOT_RESOLVED): HTTP, HTTPS, WebSocket,
// CDNs, fonts, Supabase, Razorpay. file:// pages and a local server still work. That recreates the
// no-network conditions the tests were written for. --no-proxy-server stops a system proxy from
// resolving names on the browser's behalf, which would bypass the rule.
//
// Prove it on the machine you are using with:  node app/test-guard-selftest.js
//
// This needs Playwright, which is NOT a dependency of this repo. Tests do `require("playwright")`;
// on the owner's Mac use the copy in ~/comet-karts:
//   NODE_PATH=$HOME/comet-karts/node_modules:<dir containing astronomy-engine> node app/run-tests.js
// (see backend/SETUP.md, "Running the app tests").

const fs = require("fs");

const GUARD_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  "--no-proxy-server",
];

// `chromium` is Playwright's chromium object (so this file does not itself require Playwright).
async function launchGuarded(chromium, opts = {}) {
  const { executablePath, args = [], ...rest } = opts;
  // The tests hardcode a Linux-sandbox browser path; use it only if it exists here, otherwise use
  // Playwright's own browser. PW_CHROMIUM_PATH overrides both.
  const exe = process.env.PW_CHROMIUM_PATH || (executablePath && fs.existsSync(executablePath) ? executablePath : undefined);
  const launchOpts = { ...rest, args: [...GUARD_ARGS, ...args] };
  if (exe) launchOpts.executablePath = exe;
  return chromium.launch(launchOpts);
}

module.exports = { launchGuarded, GUARD_ARGS };
