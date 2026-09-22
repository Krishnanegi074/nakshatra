// Regression test for two related fixes from the full-site QA pass:
//   #7 "Replace fixed city UTC offsets with IANA-timezone + birth-date +
//       DST-aware handling" — engine.js/engine.browser.js's toUtcDateTz()
//   #8 "Fix compatibility using the first user's city timezone for their
//       partner" — app.js's initCompat() now requires + uses
//       state.compatPartnerCity via birthLocalToUtc(), never state.birth.city
//
// This is a plain Node script (not Playwright) — same pattern as
// engine.js's own `if (require.main === module)` self-test — because the
// thing being verified (does toUtcDateTz produce the astronomically correct
// UTC instant for a given city+date, and is the offset actually
// person-specific rather than shared) is a pure calculation question, not a
// UI question. The UI-level "does the compat form require + use a picked
// partner city" behavior is covered separately in test-phase2.js/test-final.js.
const assert = require("assert");
const { toUtcDate, toUtcDateTz, getSunSign, getMoonSign, SIGNS } = require("./engine.js");
const CITIES = require("./city-data.js");

function city(name) {
  const c = CITIES.find((c) => c.name === name);
  assert.ok(c, `city-data.js should have an entry named "${name}"`);
  return c;
}

let passed = 0;
function check(label, cond) {
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
  if (cond) passed++;
}

// ---- 1. Every city's IANA tz identifier actually resolves ----
// (a typo here would silently fall back to birthLocalToUtc()'s legacy
// fixed-offset path in app.js, defeating the whole fix for that city)
let badTz = [];
for (const c of CITIES) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: c.tz }); }
  catch (e) { badTz.push(`${c.name} -> "${c.tz}"`); }
}
check(`All ${CITIES.length} cities have a valid IANA tz identifier`, badTz.length === 0);
if (badTz.length) console.log("  invalid:", badTz);

// ---- 2. DST-aware conversion is actually DST-aware, not just relabeled ----
// New York: same wall-clock birth time (9:00 AM), different times of year.
// A fixed-offset scheme (old city.utc = -5 for New York, i.e. EST only) gets
// the January case right and the July case wrong by a full hour.
const ny = city("New York");
const julyNY = toUtcDateTz({ year: 1994, month: 7, day: 1, hour: 9, minute: 0 }, ny.tz);
const janNY = toUtcDateTz({ year: 1994, month: 1, day: 1, hour: 9, minute: 0 }, ny.tz);
check("July NY birth (9AM local) resolves to 13:00 UTC — EDT, UTC-4", julyNY.toISOString() === "1994-07-01T13:00:00.000Z");
check("January NY birth (9AM local) resolves to 14:00 UTC — EST, UTC-5", janNY.toISOString() === "1994-01-01T14:00:00.000Z");
check("The OLD fixed city.utc (-5) would have gotten the July case wrong by an hour", ny.utc === -5 && julyNY.toISOString() !== toUtcDate({ year: 1994, month: 7, day: 1, hour: 9, minute: 0 }, ny.utc).toISOString());

// ---- 3. India (no DST) is unaffected: tz-aware and legacy fixed-offset agree exactly ----
const kolkata = city("Mumbai"); // utc: 5.5, tz: "Asia/Kolkata"
const juneMumbaiTz = toUtcDateTz({ year: 1996, month: 6, day: 21, hour: 6, minute: 40 }, kolkata.tz);
const juneMumbaiFixed = toUtcDate({ year: 1996, month: 6, day: 21, hour: 6, minute: 40 }, kolkata.utc);
check("Mumbai (no DST): tz-aware and legacy fixed-offset results match exactly", juneMumbaiTz.toISOString() === juneMumbaiFixed.toISOString());

// ---- 4. THE core compat fix: partner's OWN city, not the logged-in user's ----
// Simulates: a Chennai-based logged-in user runs a compatibility check on a
// partner actually born in New York. The OLD, buggy behavior silently used
// the LOGGED-IN USER's city (Chennai, fixed UTC+5.5) to convert the
// PARTNER's birth time — this reproduces that old behavior for comparison,
// then shows the FIXED behavior (using the partner's own New York city)
// produces a materially different, and correct, UTC instant.
const chennai = city("Chennai"); // the logged-in user's own city in this scenario
const partnerBirthLocal = { year: 1994, month: 7, day: 1, hour: 9, minute: 0 }; // 9AM, partner's local time in New York
const oldBuggyUtc = toUtcDate(partnerBirthLocal, chennai.utc); // OLD: used the USER's city (wrong)
const fixedUtc = toUtcDateTz(partnerBirthLocal, ny.tz); // FIXED: uses the PARTNER's own city
const offsetDiffHours = Math.abs(oldBuggyUtc.getTime() - fixedUtc.getTime()) / 3600000;
check("Old buggy conversion (partner's time via the USER's Chennai offset) differs from the fixed one by a large, wrong amount", offsetDiffHours > 9);
check("Fixed conversion (partner's time via the PARTNER's own New York tz) is the astronomically correct EDT instant", fixedUtc.toISOString() === "1994-07-01T13:00:00.000Z");

// Sun sign sanity: with the offsets this far apart, they can even land on
// different UTC calendar days, which can occasionally flip a sidereal sign
// near a boundary — not asserted as a fixed expected sign here (that would
// make this test fragile to date choice), just printed for visibility.
console.log("  Sun sign via buggy (Chennai-offset) conversion:", SIGNS[getSunSign(oldBuggyUtc)]);
console.log("  Sun sign via fixed (partner's own NY tz) conversion:", SIGNS[getSunSign(fixedUtc)]);

// ---- 5. London: DST-aware too (BST in summer, GMT in winter) ----
const london = city("London");
const julyLondon = toUtcDateTz({ year: 2000, month: 7, day: 1, hour: 9, minute: 0 }, london.tz);
const janLondon = toUtcDateTz({ year: 2000, month: 1, day: 1, hour: 9, minute: 0 }, london.tz);
check("July London birth (9AM local) resolves to 08:00 UTC — BST, UTC+1", julyLondon.toISOString() === "2000-07-01T08:00:00.000Z");
check("January London birth (9AM local) resolves to 09:00 UTC — GMT, UTC+0", janLondon.toISOString() === "2000-01-01T09:00:00.000Z");

const totalChecks = 9;
console.log(`\n=== RESULT: ${passed} / ${totalChecks} checks passed ===`);
if (passed !== totalChecks) {
  console.log(`FAILURE: expected ${totalChecks} passing checks, got ${passed}`);
  process.exit(1);
}
console.log("ALL TIMEZONE/DST REGRESSION TESTS PASSED");
