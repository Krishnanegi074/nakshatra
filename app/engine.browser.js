// Rule-based astrology calculation engine (browser build).
// Uses the globally-loaded `Astronomy` library (astronomy-engine, MIT, cosinekitty)
// for real ephemeris data. No AI text generation is involved in computing placements —
// see validation notes in the accompanying product plan.
const SIGNS = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const SIGN_SYMBOLS = ["♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓"];
const ENGINE_D2R = Math.PI / 180, ENGINE_R2D = 180 / Math.PI;

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

function toUtcDate(birthLocal, utcOffsetHours) {
  const localAsUtcMs = Date.UTC(birthLocal.year, birthLocal.month - 1, birthLocal.day, birthLocal.hour, birthLocal.minute);
  return new Date(localAsUtcMs - utcOffsetHours * 3600 * 1000);
}

function getSunSign(utcDate) {
  const elon = Astronomy.SunPosition(utcDate).elon;
  return signIndexFromLongitude(toSidereal(elon, utcDate));
}

function getMoonSign(utcDate) {
  const lon = Astronomy.EclipticGeoMoon(utcDate).lon;
  return signIndexFromLongitude(toSidereal(lon, utcDate));
}

function getAscendantSign(utcDate, latDeg, lonDeg) {
  const gmstHours = Astronomy.SiderealTime(utcDate);
  let lstHours = (gmstHours + lonDeg / 15) % 24;
  if (lstHours < 0) lstHours += 24;
  const ramcDeg = lstHours * 15;
  const oblDeg = Astronomy.e_tilt(utcDate).mobl;
  const ramcR = ramcDeg * ENGINE_D2R, oblR = oblDeg * ENGINE_D2R, latR = latDeg * ENGINE_D2R;
  const y = Math.cos(ramcR);
  const x = -(Math.sin(oblR) * Math.tan(latR) + Math.cos(oblR) * Math.sin(ramcR));
  const asc = norm360(Math.atan2(y, x) * ENGINE_R2D);
  return signIndexFromLongitude(toSidereal(asc, utcDate));
}

function getMoonPhase(utcDate) {
  const angle = Astronomy.MoonPhase(utcDate);
  const names = ["New Moon","Waxing Crescent","First Quarter","Waxing Gibbous","Full Moon","Waning Gibbous","Last Quarter","Waning Crescent"];
  const idx = Math.floor(norm360(angle + 22.5) / 45) % 8;
  return { angle, name: names[idx] };
}

// Real transiting (current-sky) position of an outer planet — used for the
// Year Ahead report. Validated against known transit history (e.g. Jupiter's
// 2021-2023 Aquarius/Pisces retrograde wobble, current Leo transit).
function getTransitingSign(body, utcDate) {
  const vec = Astronomy.GeoVector(body, utcDate, true);
  const elon = Astronomy.Ecliptic(vec).elon;
  return signIndexFromLongitude(toSidereal(elon, utcDate));
}
