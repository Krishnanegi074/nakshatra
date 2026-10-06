// Shared gate for the two scripts that deliberately run against the REAL Supabase project.
// Without CONFIRM_PRODUCTION=yes in the environment they refuse to start, before any client is
// created. Never set it automatically or in a shell profile: type it for the one run you mean.
//   CONFIRM_PRODUCTION=yes SUPABASE_SERVICE_ROLE_KEY=... node backend/tests/realtime-test.js
function requireProductionConfirmation({ script, url, willDo }) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { console.error(`${script}: SUPABASE_URL is not a valid URL.`); process.exit(1); }
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return;
  if (process.env.CONFIRM_PRODUCTION === "yes") {
    console.log(`CONFIRM_PRODUCTION=yes: ${script} is running against ${host}.`);
    return;
  }
  console.error(
    `\nREFUSING TO RUN: ${script} writes to a real Supabase project (${host}).\n` +
    `It will: ${willDo}\n` +
    `If that is what you want, run it again with CONFIRM_PRODUCTION=yes in the environment.\n`
  );
  process.exit(1);
}
module.exports = { requireProductionConfirmation };
