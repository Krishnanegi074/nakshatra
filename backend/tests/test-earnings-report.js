// Tests for backend/scripts/expert-earnings-report.js. No production, no real network:
// the script is pointed at a tiny in-process fake of the Supabase REST API on 127.0.0.1.
//   node backend/tests/test-earnings-report.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../scripts/expert-earnings-report.js");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) pass++; else fail++;
  console.log((cond ? "PASS" : "FAIL") + " - " + label + (cond || !extra ? "" : "  [" + extra + "]"));
}
async function throws(fn) { try { await fn(); return false; } catch (_) { return true; } }

// ---------- fixture (October 2026, IST) ----------
const E1 = "e1000000-0000-0000-0000-000000000001", E2 = "e2000000-0000-0000-0000-000000000002", E3 = "e3000000-0000-0000-0000-000000000003";
const U1 = "u1000000-0000-0000-0000-000000000001", U2 = "u2000000-0000-0000-0000-000000000002", U3 = "u3000000-0000-0000-0000-000000000003", U4 = "u4000000-0000-0000-0000-000000000004";
const S = (n) => `5${n}000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const sess = (n, o) => ({ id: S(n), user_id: U1, expert_id: E1, status: "ended", amount_paise: 19900, razorpay_order_id: "order_" + n, play_purchase_token: null, ended_reason: null, created_at: "2026-10-10T10:00:00+00:00", ended_at: "2026-10-10T10:20:00+00:00", ...o });
const SESSIONS = [
  sess(1, {}),                                                                                       // earned
  sess(2, { user_id: U2, ended_reason: "expert_silent", created_at: "2026-10-06T10:00:00+00:00" }),  // refunded (refund lands in Nov)
  sess(3, { user_id: U1, expert_id: E2, razorpay_order_id: null, play_purchase_token: "tok-1", ended_reason: "expert_silent" }), // Play, manual
  sess(4, { user_id: U3, expert_id: E2, ended_reason: "expert_silent" }),                            // ledger failed
  sess(5, { user_id: U2, expert_id: E2, ended_reason: "expert_silent" }),                            // ledger pending
  sess(6, { user_id: U3, status: "active", ended_at: null }),                                        // still active
  sess(7, { user_id: U4 }),                                                                          // test account (excluded)
  sess(8, { amount_paise: 0, razorpay_order_id: null }),                                             // Rs 0
  sess(9, { created_at: "2026-09-30T18:29:59+00:00" }),                                              // 23:59:59 IST on 30 Sep -> September
  sess(10, { created_at: "2026-09-30T18:30:00+00:00" }),                                             // 00:00:00 IST on 1 Oct -> October, earned
  sess(11, { created_at: "2026-10-31T18:30:00+00:00" }),                                             // 00:00:00 IST on 1 Nov -> November
  sess(13, { user_id: U2 }),                                                                         // order not verified
  sess(14, { user_id: U3, ended_reason: "expert_silent" }),                                          // silent, no ledger row
];
const ORDERS = SESSIONS.filter((s) => s.razorpay_order_id).map((s) => ({ order_id: s.razorpay_order_id, status: s.razorpay_order_id === "order_13" ? "created" : "verified", verified_at: s.created_at }));
const LEDGER = [
  { session_id: S(2), status: "refunded", amount_paise: 19900, refund_id: "rfnd_TEST2", last_error: null, attempts: 1 },
  { session_id: S(3), status: "manual", amount_paise: 19900, refund_id: null, last_error: "Google Play purchase: refund in Play Console", attempts: 0 },
  { session_id: S(4), status: "failed", amount_paise: 19900, refund_id: null, last_error: "refund failed (400): bad request", attempts: 8 },
  { session_id: S(5), status: "pending", amount_paise: 19900, refund_id: null, last_error: null, attempts: 0 },
];
const EXPERTS = [{ id: E1, name: "Asha Expert" }, { id: E2, name: "Ravi, Expert" }, { id: E3, name: "=Evil" }];
const NUMS = [1, 2, 3, 4, 5].map((n) => ({ id: "n" + n }));

// ---------- fake PostgREST ----------
function startFake() {
  const tables = { chat_sessions: SESSIONS, razorpay_orders: ORDERS, expert_session_refunds: LEDGER, experts: EXPERTS, nums: NUMS };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, "http://x");
    const table = u.pathname.replace("/rest/v1/", "");
    let rows = tables[table];
    if (!rows) { res.statusCode = 404; res.end("no such table"); return; }
    for (const g of u.searchParams.getAll("created_at")) {
      const m = /^(gte|lt)\.(.*)$/.exec(g);
      if (m) rows = rows.filter((r) => (m[1] === "gte" ? Date.parse(r.created_at) >= Date.parse(m[2]) : Date.parse(r.created_at) < Date.parse(m[2])));
    }
    for (const col of ["session_id", "order_id"]) {
      const f = u.searchParams.get(col);
      if (f && f.startsWith("in.(")) { const set = new Set(f.slice(4, -1).split(",")); rows = rows.filter((r) => set.has(r[col])); }
    }
    const limit = Number(u.searchParams.get("limit") || 1000), offset = Number(u.searchParams.get("offset") || 0);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(rows.slice(offset, offset + limit)));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const FAKE_KEY = "sb_secret_FAKE_test_key_0123456789";
const readCsv = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => l);
const row = (lines, name) => lines.find((l) => l.includes(name));

(async () => {
  console.log("== helpers ==");
  const w = R.istMonthWindow("2026-10");
  check("October 2026 in IST = 2026-09-30T18:30Z to 2026-10-31T18:30Z", w.startIso === "2026-09-30T18:30:00.000Z" && w.endIso === "2026-10-31T18:30:00.000Z", w.startIso + " .. " + w.endIso);
  check("December rolls into the next year correctly", R.istMonthWindow("2026-12").endIso === "2026-12-31T18:30:00.000Z");
  check("a malformed month is rejected", (await throws(() => R.istMonthWindow("2026-13"))) && (await throws(() => R.istMonthWindow("2026-1"))) && (await throws(() => R.istMonthWindow(null))));
  check("fmtIst shows IST (+5:30)", R.fmtIst("2026-10-01T18:29:59+00:00") === "2026-10-01 23:59:59" && R.fmtIst(null) === "");
  check("csvCell quotes commas, doubles quotes, and neutralises spreadsheet formulas",
    R.csvCell("a,b") === '"a,b"' && R.csvCell('say "hi"') === '"say ""hi"""' && R.csvCell("=SUM(A1)") === "'=SUM(A1)" && R.csvCell("+1") === "'+1" && R.csvCell(5) === "5" && R.csvCell(null) === "");
  check("config: a rate outside 0-1, a non-number rate, and a bad exclusion list are rejected",
    (await throws(() => R.validateConfig({ expertRates: { x: 1.5 } }))) && (await throws(() => R.validateConfig({ expertRates: { x: "40%" } }))) && (await throws(() => R.validateConfig({ excludeUserIds: "abc" }))));
  check("config: a valid file is accepted", R.validateConfig({ expertRates: { x: 0.4 }, excludeUserIds: ["u"] }).expertRates.x === 0.4);

  console.log("\n== read-only guard ==");
  const rof = R.readOnlyFetch(async () => ({ ok: true }));
  check("POST, PATCH, PUT and DELETE are refused", ["POST", "PATCH", "PUT", "DELETE"].every((m) => { try { rof("http://x", { method: m }); return false; } catch (_) { return true; } }));
  check("GET (and no method) are allowed", (await rof("http://x", {})).ok && (await rof("http://x", { method: "GET" })).ok);

  console.log("\n== paging ==");
  const fake = await startFake();
  const api = R.makeApi(fake.url, FAKE_KEY, fetch);
  const all = await R.fetchAll(api, "nums", "select=id", 2);
  check("fetchAll walks every page (5 rows, page size 2)", all.length === 5 && all.map((x) => x.id).join() === "n1,n2,n3,n4,n5");
  check("a failing request surfaces the HTTP status", await throws(() => api.get("no_such_table?select=id")));

  console.log("\n== full run against the fake API, exclusions on ==");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earnings-test-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ expertRates: { [E1]: 0.4 }, excludeUserIds: [U4] }));
  const logs = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY, SUPABASE_URL: fake.url };
  const out = await R.main(["--month", "2026-10", "--out", dir], env, fetch, (m) => logs.push(m));
  const ex = readCsv(out.files.experts), se = readCsv(out.files.sessions), att = fs.readFileSync(out.files.attention, "utf8");
  const e1 = row(ex, "Asha Expert").split(","), e2 = row(ex, '"Ravi, Expert"');
  // columns: id,name,paid,earned,active,refunded,held,gross,refunded_rs,held_rs,net,rate,payout
  check("Asha: 6 paid sessions (excluded, Rs 0 and out-of-month ones are not counted)", e1[2] === "6", e1.join("|"));
  check("Asha: gross 1194.00, refunded 199.00, held back 398.00, net 597.00", e1[7] === "1194.00" && e1[8] === "199.00" && e1[9] === "398.00" && e1[10] === "597.00", e1.join("|"));
  check("Asha: payout = net x 0.4 = 238.80", e1[11] === "0.4" && e1[12] === "238.80", e1.join("|"));
  check("Asha: the still-active session counts as earned and is counted as active", e1[3] === "3" && e1[4] === "1", e1.join("|"));
  check("Ravi (Play + failed + pending): everything held back, net 0.00, payout blank (no rate)", !!e2 && e2.endsWith(",3,0,0,0,3,597.00,0.00,597.00,0.00,,") , e2);
  check("an expert name with a comma is quoted; one starting with '=' is neutralised", !!e2 && ex.some((l) => l.includes("'=Evil")));
  check("TOTAL row: 9 paid, gross 1791.00, net 597.00, payout blank because not every expert has a rate", /TOTAL,9,/.test(row(ex, "TOTAL")) && row(ex, "TOTAL").includes("1791.00") && row(ex, "TOTAL").endsWith("597.00,,"), row(ex, "TOTAL"));
  check("September 23:59:59 IST belongs to September; 00:00:00 IST on 1 Oct is in October; 1 Nov is out",
    !se.some((l) => l.startsWith(S(9))) && se.some((l) => l.startsWith(S(10))) && !se.some((l) => l.startsWith(S(11))));
  check("the test account's session (excluded) and the Rs 0 session are not in the audit file", !se.some((l) => l.startsWith(S(7))) && !se.some((l) => l.startsWith(S(8))));
  check("the refunded session is in the audit file with its refund id and counts 0", /rfnd_TEST2/.test(row(se, S(2)) || "") && /,199\.00,0\.00,199\.00,0\.00,/.test(row(se, S(2)) || ""), row(se, S(2)));
  check("audit file uses truncated ids only (no full user id)", !se.some((l) => l.includes(U1)) && se.some((l) => l.includes(",u1000000,")));
  check("needs-attention lists pending, failed (with its error) and manual (Play) refunds", /refund pending/.test(att) && /refund failed: refund failed \(400\)/.test(att) && /refund manual/.test(att) && /google_play|Play Console/.test(att));
  check("needs-attention lists the still-active session, the unverified order and the silent-without-ledger session", /still active/.test(att) && /order not verified \(created\)/.test(att) && /no ledger row/.test(att));
  check("needs-attention says Ravi has no rate", /NO RATE\s+Ravi, Expert/.test(att) && !/NO RATE\s+Asha/.test(att));
  check("needs-attention reports 1 Rs 0 session ignored and 1 excluded session worth Rs 199.00", /1 Rs 0 session\(s\) ignored/.test(att) && /1 session\(s\) worth Rs 199\.00 skipped/.test(att));
  check("the report states it is gross-only and carries an as-of time", /Gross only/.test(att) && /as of 20\d\d-/.test(att));
  check("every request the script made was a GET", fake.seen.length > 0 && fake.seen.every((r) => r.method === "GET"), [...new Set(fake.seen.map((r) => r.method))].join());

  console.log("\n== reconciliation run (--no-exclusions) ==");
  const out2 = await R.main(["--month", "2026-10", "--out", dir, "--no-exclusions"], env, fetch, () => {});
  const ex2 = readCsv(out2.files.experts), att2 = fs.readFileSync(out2.files.attention, "utf8");
  const a2 = row(ex2, "Asha Expert").split(",");
  check("with exclusions off, the test account's session counts: 7 paid, net 796.00, payout 318.40", a2[2] === "7" && a2[10] === "796.00" && a2[12] === "318.40", a2.join("|"));
  check("...it goes to a separate folder and says exclusions are OFF", /-no-exclusions/.test(out2.files.experts) && /EXCLUSIONS OFF/.test(att2));
  check("...and the normal report's files were not overwritten", readCsv(out.files.experts).some((l) => l.includes("238.80")));
  check("Rs 0 sessions are still ignored with exclusions off", /1 Rs 0 session\(s\) ignored/.test(att2));

  console.log("\n== no config file ==");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "earnings-test-"));
  const out3 = await R.main(["--month", "2026-10", "--out", dir2], env, fetch, () => {});
  const ex3 = readCsv(out3.files.experts);
  check("with no config.json there is no default rate: every payout is blank, and the report says so", ex3.slice(1).every((l) => l.endsWith(",")) && /No config\.json found/.test(fs.readFileSync(out3.files.attention, "utf8")), ex3.join(" / "));

  console.log("\n== safety ==");
  check("refuses to write inside the git repo", await throws(() => R.main(["--month", "2026-10", "--out", path.join(R.REPO_ROOT, "tmp-reports")], env, fetch, () => {})) && await throws(() => R.main(["--month", "2026-10", "--out", R.REPO_ROOT], env, fetch, () => {})));
  check("refuses to run without the service key", await throws(() => R.main(["--month", "2026-10", "--out", dir], { SUPABASE_URL: fake.url }, fetch, () => {})));
  const usage = []; const nothing = await R.main([], env, fetch, (m) => usage.push(m));
  check("without --month it prints usage and does nothing", nothing === null && /usage/.test(usage.join()));
  const everything = [...logs, ...fs.readdirSync(path.join(dir, "2026-10")).map((f) => fs.readFileSync(path.join(dir, "2026-10", f), "utf8"))].join("\n");
  check("the service key is not in the output files or the log", !everything.includes(FAKE_KEY));
  check("the key was only ever sent as the auth header, to the fake", fake.seen.every((r) => r.auth === "Bearer " + FAKE_KEY && !r.url.includes(FAKE_KEY)));
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "expert-earnings-report.js"), "utf8");
  check("the script source contains no key-shaped literal", !/sb_secret_[A-Za-z0-9_-]{8,}|rzp_(live|test)_[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_-]{20,}/.test(src));
  check("the script has no code path that writes to the database (no POST/PATCH/DELETE/rpc)", !/method:\s*["'](POST|PATCH|PUT|DELETE)|\/rpc\//i.test(src.replace(/\/\/.*$/gm, "")));

  fake.server.close();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });
  console.log(`\n=== RESULT: ${pass} / ${pass + fail} checks passed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("FATAL", e.stack || e.message); process.exit(1); });
