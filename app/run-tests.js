// Runs the app's tests with the network guard. Safe by construction:
//   1. lint: no test file may call chromium.launch() directly (they must use launchGuarded)
//   2. the guard self-test must pass on this machine, otherwise nothing else runs
//   3. the app is rebuilt (app/nakshatra-app.html, gitignored), then each test file runs with a timeout
//
//   NODE_PATH=$HOME/comet-karts/node_modules:<dir with astronomy-engine> node app/run-tests.js
//   node app/run-tests.js --list        # show what would run, run nothing
//
// Not included: app/bughunt.js (an exploratory script, not an assertion test) and
// backend/tests/* (see backend/SETUP.md). The two backend scripts that really write to production
// are gated separately by CONFIRM_PRODUCTION=yes and are never run from here.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP = __dirname;
const ROOT = path.resolve(APP, "..");
const TIMEOUT_MS = 5 * 60 * 1000;

const tests = [
  ...fs.readdirSync(APP).filter((f) => /^test-.*\.js$/.test(f) && !/^test-guard/.test(f)).sort().map((f) => path.join("app", f)),
  "app/test.js",
  "app/verify-fixes.js",
  "app/tests-backend/test-backend-integration.js",
  "test-kundli-waitlist.js",
].filter((f, i, a) => a.indexOf(f) === i && fs.existsSync(path.join(ROOT, f)));

if (process.argv.includes("--list")) { console.log(tests.join("\n")); process.exit(0); }

function fatal(msg) { console.error("\n" + msg + "\n"); process.exit(1); }

// 1. lint: every file that drives a browser must go through the guard
const offenders = [...tests, "app/bughunt.js", "app/preview.js"].filter((f) => {
  const p = path.join(ROOT, f); if (!fs.existsSync(p)) return false;
  return /chromium\.launch\s*\(/.test(fs.readFileSync(p, "utf8"));
});
if (offenders.length) fatal("These files call chromium.launch() directly instead of launchGuarded():\n  " + offenders.join("\n  "));
console.log("lint OK: no test launches a browser outside the guard");

try { require.resolve("playwright"); } catch (_) {
  fatal('Playwright is not resolvable. Set NODE_PATH to a node_modules that has it, e.g. NODE_PATH=$HOME/comet-karts/node_modules (see backend/SETUP.md, "Running the app tests").');
}

// 2. the guard must be proven on this machine first
const st = spawnSync("node", [path.join(APP, "test-guard-selftest.js")], { stdio: "inherit", env: process.env, timeout: 3 * 60 * 1000 });
if (st.status !== 0) fatal("Guard self-test did not pass: NOT running any test. Nothing else was started.");

// 3. build, then run
const b = spawnSync("node", ["build.js"], { cwd: APP, stdio: "inherit", env: process.env });
if (b.status !== 0) fatal("app/build.js failed.");

let bad = 0;
console.log("\n== running " + tests.length + " test files (guarded) ==");
for (const f of tests) {
  const t0 = Date.now();
  const r = spawnSync("node", [path.join(ROOT, f)], { cwd: path.dirname(path.join(ROOT, f)), env: process.env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 50e6 });
  const out = (r.stdout || "") + (r.stderr || "");
  const logDir = process.env.TEST_LOG_DIR; if (logDir) { fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(path.join(logDir, f.replace(/[\\/]/g, "__") + ".log"), out); }
  const p = (out.match(/^PASS/gm) || []).length, fl = (out.match(/^FAIL/gm) || []).length;
  const ok = r.status === 0 && fl === 0; if (!ok) bad++;
  console.log((ok ? "OK  " : "BAD ") + f.padEnd(48) + `PASS ${p} FAIL ${fl} exit ${r.status}${r.error ? " " + r.error.code : ""} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(bad ? `\n${bad} of ${tests.length} file(s) NOT clean` : `\nall ${tests.length} files clean`);
process.exit(bad ? 1 : 0);
