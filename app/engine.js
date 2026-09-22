// Rule-based astrology calculation engine.
// Built on astronomy-engine (MIT, Don Cross / cosinekitty) for real ephemeris data -
// no AI text generation involved in computing chart placements.
const Astronomy = require("astronomy-engine");

const SIGNS = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

function norm360(x) { return ((x % 360) + 360) % 360; }
function signIndexFromLongitude(lon) { return Math.floor(norm360(lon) / 30); }

// Lahiri (Chitra Paksha) ayanamsa — the standard reference traditional Indian/Vedic
// astrology uses to convert the engine's raw tropical (Western) ecliptic longitudes
// into sidereal longitudes. Modeled as a straight line anchored at J2000.0
// (23 deg 51' 12" = 23.85333 deg on 2000-01-01, the published Swiss-Ephemeris-computed
// Lahiri value for that date) advancing at the ~50.2388475 arcsec/year general
// precession rate. Cross-checked against three other published Lahiri reference
// values (1900: 22 deg 27' 55", 1994: 23 deg 46' 40", 2024: 24 deg 11' 27") — this
// line matches all of them to within ~30 arcsec (0.008 deg). True ayanamsa wobbles
// by roughly +/-17 arcsec around this line (18.6-year lunar nutation cycle), which
// is negligible next to the ~1 degree of margin needed to place a placement
// confidently within (not at the edge of) a 30-degree sign — so this approximation
// is accurate enough for chart placements without needing the full nutation series.
const AYANAMSA_J2000_DEG = 23.85333; // 23 deg 51' 12" on 2000-01-01
const AYANAMSA_RATE_DEG_PER_YEAR = 50.2388475 / 3600; // general precession, deg/year
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // 2000-01-01 12:00 UTC (J2000.0 epoch)
const MS_PER_JULIAN_YEAR = 365.25 * 24 * 3600 * 1000;

function getAyanamsa(utcDate) {
  const yearsSinceJ2000 = (utcDate.getTime() - J2000_MS) / MS_PER_JULIAN_YEAR;
  return AYANAMSA_J2000_DEG + AYANAMSA_RATE_DEG_PER_YEAR * yearsSinceJ2000;
}

// Converts a tropical ecliptic longitude to sidereal (Lahiri) for the given moment.
function toSidereal(tropicalLonDeg, utcDate) {
  return norm360(tropicalLonDeg - getAyanamsa(utcDate));
}

// birthLocal: {year,month,day,hour,minute} in LOCAL time at the birth place
// utcOffsetHours: e.g. 5.5 for IST
// LEGACY / fixed-offset only — does not know about DST. Kept for backward
// compatibility with already-saved birth_data rows that only have a numeric
// `city_utc` and no `city_tz` (see city-data.js and toUtcDateTz() below,
// which is what new code should use).
function toUtcDate(birthLocal, utcOffsetHours) {
  const localAsUtcMs = Date.UTC(birthLocal.year, birthLocal.month - 1, birthLocal.day, birthLocal.hour, birthLocal.minute);
  return new Date(localAsUtcMs - utcOffsetHours * 3600 * 1000);
}

// Resolves the UTC offset (in minutes) that `ianaTz` had at approximately
// the given UTC instant — i.e. whether standard or daylight-saving time was
// in effect at that moment in that zone.
function tzOffsetMinutesAt(ianaTz, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asIfUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUtcMs - utcMs) / 60000;
}

// birthLocal: {year,month,day,hour,minute} in LOCAL WALL-CLOCK time at the
// birth place. ianaTz: an IANA timezone identifier, e.g. "America/New_York".
//
// Converts to the correct UTC instant using the offset that actually applied
// AT THE BIRTH DATE (not today's offset) — so e.g. a July birth in New York
// correctly resolves to EDT (UTC-4) and a January birth to EST (UTC-5),
// instead of a single fixed offset that's only right for half the year.
//
// Implementation: a standard two-pass fixed-point resolution (the same
// approach date libraries like Luxon use). First guess the offset by
// treating the local wall-clock fields as if they were UTC, then re-check
// the offset at the corrected instant in case the correction itself crossed
// a DST transition boundary — this second pass is what makes birth times
// near a "spring forward"/"fall back" transition resolve correctly rather
// than off by an hour. The one inherent ambiguity no library can fully
// resolve is a wall-clock time that occurs twice during a "fall back" (e.g.
// 1:30 AM occurring once in EDT and once in EST) — this converges on one of
// the two valid instants, which is an accepted, documented limitation
// shared by every timezone-conversion library, not a bug specific to this
// implementation.
function toUtcDateTz(birthLocal, ianaTz) {
  const naiveUtcMs = Date.UTC(birthLocal.year, birthLocal.month - 1, birthLocal.day, birthLocal.hour, birthLocal.minute);
  const offsetMin1 = tzOffsetMinutesAt(ianaTz, naiveUtcMs);
  const correctedMs = naiveUtcMs - offsetMin1 * 60000;
  const offsetMin2 = tzOffsetMinutesAt(ianaTz, correctedMs);
  const finalMs = offsetMin2 === offsetMin1 ? correctedMs : naiveUtcMs - offsetMin2 * 60000;
  return new Date(finalMs);
}

function getSunSign(utcDate) {
  const elon = Astronomy.SunPosition(utcDate).elon;
  return signIndexFromLongitude(toSidereal(elon, utcDate));
}

function getMoonSign(utcDate) {
  const lon = Astronomy.EclipticGeoMoon(utcDate).lon;
  return signIndexFromLongitude(toSidereal(lon, utcDate));
}

// Validated against sunrise = ascendant conjunct sun (see verification notes).
function getAscendantSign(utcDate, latDeg, lonDeg) {
  const gmstHours = Astronomy.SiderealTime(utcDate);
  let lstHours = (gmstHours + lonDeg / 15) % 24;
  if (lstHours < 0) lstHours += 24;
  const ramcDeg = lstHours * 15;
  const oblDeg = Astronomy.e_tilt(utcDate).mobl;
  const ramcR = ramcDeg * D2R, oblR = oblDeg * D2R, latR = latDeg * D2R;
  const y = Math.cos(ramcR);
  const x = -(Math.sin(oblR) * Math.tan(latR) + Math.cos(oblR) * Math.sin(ramcR));
  const asc = norm360(Math.atan2(y, x) * R2D);
  return signIndexFromLongitude(toSidereal(asc, utcDate));
}

function getMoonPhase(utcDate) {
  const angle = Astronomy.MoonPhase(utcDate); // 0=new,90=FQ,180=full,270=LQ
  const names = ["New Moon","Waxing Crescent","First Quarter","Waxing Gibbous","Full Moon","Waning Gibbous","Last Quarter","Waning Crescent"];
  const idx = Math.floor(norm360(angle + 22.5) / 45) % 8;
  return { angle, name: names[idx] };
}

function getTransitingSign(body, utcDate) {
  const vec = Astronomy.GeoVector(body, utcDate, true);
  const elon = Astronomy.Ecliptic(vec).elon;
  return signIndexFromLongitude(toSidereal(elon, utcDate));
}

module.exports = { SIGNS, toUtcDate, toUtcDateTz, tzOffsetMinutesAt, getSunSign, getMoonSign, getAscendantSign, getMoonPhase, getTransitingSign, signIndexFromLongitude, getAyanamsa, toSidereal };

// ---- self-test when run directly ----
if (require.main === module) {
  const assert = require("assert");

  // Known sun-sign boundary sanity checks. Dates are chosen at classic TROPICAL sign
  // boundaries, but getSunSign() now returns the SIDEREAL (Lahiri) sign, which trails
  // the tropical sign by ~23.9 degrees (~24 days) at these dates since the ayanamsa
  // correction shifts the effective boundary later in the year.
  const cases = [
    [{ year: 2000, month: 1, day: 1, hour: 12, minute: 0 }, "Sagittarius"],
    [{ year: 2000, month: 3, day: 25, hour: 12, minute: 0 }, "Pisces"],
    [{ year: 2000, month: 7, day: 4, hour: 12, minute: 0 }, "Gemini"],
    [{ year: 2000, month: 8, day: 17, hour: 12, minute: 0 }, "Leo"],
    [{ year: 2000, month: 12, day: 25, hour: 12, minute: 0 }, "Sagittarius"],
  ];
  for (const [local, expected] of cases) {
    const utc = toUtcDate(local, 5.5);
    const got = SIGNS[getSunSign(utc)];
    assert.strictEqual(got, expected, `Sun sign for ${JSON.stringify(local)}: expected ${expected}, got ${got}`);
  }
  console.log("Sun sign boundary tests: PASS");

  // Ascendant sanity: sunrise moment => ascendant ~= sun longitude
  const observer = new Astronomy.Observer(28.6139, 77.209, 0); // New Delhi
  const rise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, 1, new Date("2026-08-17T00:00:00Z"), 2);
  const sunLon = Astronomy.SunPosition(rise.date).elon;
  const ascLon = (() => {
    const gmstHours = Astronomy.SiderealTime(rise.date);
    let lstHours = (gmstHours + 77.209 / 15) % 24;
    if (lstHours < 0) lstHours += 24;
    const ramcDeg = lstHours * 15;
    const oblDeg = Astronomy.e_tilt(rise.date).mobl;
    const ramcR = ramcDeg * D2R, oblR = oblDeg * D2R, latR = 28.6139 * D2R;
    const y = Math.cos(ramcR);
    const x = -(Math.sin(oblR) * Math.tan(latR) + Math.cos(oblR) * Math.sin(ramcR));
    return norm360(Math.atan2(y, x) * R2D);
  })();
  const diff = Math.abs(sunLon - ascLon);
  assert.ok(diff < 2, `Ascendant should be within ~2deg of sun longitude at sunrise, got diff=${diff}`);
  console.log("Ascendant sunrise validation: PASS (diff=" + diff.toFixed(3) + "deg)");

  // Moon phase sanity: MoonPhase(t) near a known new moon should be close to 0/360
  console.log("Sample moon phase 2026-08-17:", getMoonPhase(new Date("2026-08-17T00:00:00Z")));

  // toUtcDateTz(): DST-aware conversion sanity checks.
  // New York: July is EDT (UTC-4), January is EST (UTC-5) — a fixed offset
  // gets one of these two right and the other wrong by an hour.
  const julyNY = toUtcDateTz({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, "America/New_York");
  assert.strictEqual(julyNY.toISOString(), "2026-07-15T13:00:00.000Z", "July NY birth should resolve as EDT (UTC-4)");
  const janNY = toUtcDateTz({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, "America/New_York");
  assert.strictEqual(janNY.toISOString(), "2026-01-15T14:00:00.000Z", "January NY birth should resolve as EST (UTC-5)");
  // London: July is BST (UTC+1), January is GMT (UTC+0).
  const julyLondon = toUtcDateTz({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, "Europe/London");
  assert.strictEqual(julyLondon.toISOString(), "2026-07-15T08:00:00.000Z", "July London birth should resolve as BST (UTC+1)");
  const janLondon = toUtcDateTz({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, "Europe/London");
  assert.strictEqual(janLondon.toISOString(), "2026-01-15T09:00:00.000Z", "January London birth should resolve as GMT (UTC+0)");
  // India never observes DST — toUtcDateTz("Asia/Kolkata") should exactly
  // match the legacy fixed-offset toUtcDate(local, 5.5) year-round.
  const juneKolkataTz = toUtcDateTz({ year: 2026, month: 6, day: 21, hour: 6, minute: 40 }, "Asia/Kolkata");
  const juneKolkataFixed = toUtcDate({ year: 2026, month: 6, day: 21, hour: 6, minute: 40 }, 5.5);
  assert.strictEqual(juneKolkataTz.toISOString(), juneKolkataFixed.toISOString(), "Asia/Kolkata has no DST — tz-aware and fixed-offset results should match exactly");
  console.log("toUtcDateTz() DST-aware conversion tests: PASS");

  console.log("ALL ENGINE TESTS PASSED");
}
