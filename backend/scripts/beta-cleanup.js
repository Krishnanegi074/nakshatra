// Deletes private-beta accounts (and, via ON DELETE CASCADE, their chart,
// entitlements, orders, chat sessions and messages).
//   node backend/scripts/beta-cleanup.js --since 2026-09-30 --keep a@x.com,b@x.com          # dry run
//   node backend/scripts/beta-cleanup.js --since 2026-09-30 --keep a@x.com,b@x.com --yes    # delete
// Needs SUPABASE_SERVICE_ROLE_KEY (env file: ~/.nakshatra-realtime-test.env). Never prints keys.
const URL_ = "https://xinelwrxgveztrtokwbt.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const since = arg("--since"), keep = (arg("--keep") || "").toLowerCase().split(",").filter(Boolean), doIt = process.argv.includes("--yes");
if (!KEY || !since || !keep.length) { console.error("need SUPABASE_SERVICE_ROLE_KEY, --since YYYY-MM-DD and --keep email,email"); process.exit(1); }
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
(async () => {
  const r = await fetch(`${URL_}/auth/v1/admin/users?per_page=1000`, { headers: H });
  const users = (await r.json()).users || [];
  const experts = await (await fetch(`${URL_}/rest/v1/experts?select=id`, { headers: H })).json();
  const expertIds = new Set(experts.map((e) => e.id));
  const victims = users.filter((u) => new Date(u.created_at) >= new Date(since) && !keep.includes((u.email || "").toLowerCase()) && !expertIds.has(u.id));
  console.log(`${users.length} users total; ${victims.length} beta accounts to delete:`);
  victims.forEach((u) => console.log("  -", u.email, u.created_at.slice(0, 10)));
  if (!doIt) return console.log("dry run — add --yes to delete");
  for (const u of victims) {
    await fetch(`${URL_}/rest/v1/gift_codes?redeemed_by=eq.${u.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ redeemed_by: null }) });
    const d = await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: H });
    console.log(d.ok ? "deleted" : "FAILED " + d.status, u.email);
  }
})();
