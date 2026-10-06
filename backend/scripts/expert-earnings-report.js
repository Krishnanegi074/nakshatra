// Monthly expert earnings report. READ-ONLY: it only issues HTTP GETs against the
// Supabase REST API (a wrapper throws on any other method) and never calls a function.
//
//   source ~/.nakshatra-realtime-test.env        # provides SUPABASE_SERVICE_ROLE_KEY
//   node backend/scripts/expert-earnings-report.js --month 2026-10
//   node backend/scripts/expert-earnings-report.js --month 2026-10 --no-exclusions
//
// Writes, into <reports dir>/<month>/ :
//   expert-earnings-<month>.csv   one row per expert (+ a TOTAL row)
//   sessions-<month>.csv          one row per paid session (audit trail, ids only)
//   needs-attention-<month>.txt   things a human must resolve
//
// The reports dir (default ~/Documents/nakshatra-reports) is OUTSIDE the repo; the script refuses
// to write inside the repo. config.json lives in that same folder:
//   { "expertRates": { "<expert id>": 0.4 }, "excludeUserIds": ["<user id>", ...] }
// expertRates are fractions of gross (0.4 = 40%). There is deliberately no default rate: an expert
// with no rate gets a blank payout column. The service key is read from the environment, never
// printed, and never written to any output.
//
// How sessions count (decided with the owner, 2026-10-06):
//   * month = the month the customer paid, in IST; a later refund is netted against that month
//   * refunded (ledger 'refunded') and silent-refunded sessions earn Rs 0
//   * ledger 'pending' / 'failed' / 'manual', unverified orders, and 'expert_silent' sessions with no
//     ledger row are HELD BACK from net and listed under needs-attention
//   * answered-then-quiet sessions are earned; still-active sessions count as paid and are flagged
//   * Rs 0 sessions are always ignored; user ids in excludeUserIds are skipped unless --no-exclusions
//   * gross only: Razorpay / Google fees and GST are not subtracted

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_URL = "https://xinelwrxgveztrtokwbt.supabase.co";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const IST_MS = 330 * 60 * 1000;
const PAGE_SIZE = 1000;
const CHUNK = 40;

// ---------- read-only HTTP ----------

function readOnlyFetch(fetchImpl) {
  return (url, opts = {}) => {
    const method = String(opts.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error(`read-only script: refusing to send a ${method} request`);
    return fetchImpl(url, opts);
  };
}

function makeApi(base, key, fetchImpl) {
  const guarded = readOnlyFetch(fetchImpl);
  return {
    async get(pathAndQuery) {
      const res = await guarded(`${base}/rest/v1/${pathAndQuery}`, {
        method: "GET",
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`GET ${pathAndQuery.split("?")[0]} failed: HTTP ${res.status} ${text}`);
      }
      return res.json();
    },
  };
}

async function fetchAll(api, table, query, pageSize = PAGE_SIZE) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await api.get(`${table}?${query}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function fetchIn(api, table, column, ids, select) {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const list = ids.slice(i, i + CHUNK).map(encodeURIComponent).join(",");
    rows.push(...(await fetchAll(api, table, `select=${select}&${column}=in.(${list})&order=${column}`)));
  }
  return rows;
}

// ---------- time and money helpers ----------

// An IST calendar month as UTC instants: [start, end).
function istMonthWindow(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month || "");
  if (!m) throw new Error("--month must look like 2026-10");
  const y = Number(m[1]), mo = Number(m[2]);
  const start = Date.UTC(y, mo - 1, 1) - IST_MS;
  const end = Date.UTC(y, mo, 1) - IST_MS;
  return { start, end, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

function fmtIst(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t + IST_MS).toISOString().replace("T", " ").slice(0, 19);
}

const rupees = (paise) => (paise / 100).toFixed(2);
const shortId = (id) => (id ? String(id).slice(0, 8) : "");

// ---------- config ----------

function validateConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const expertRates = {};
  for (const [id, rate] of Object.entries(cfg.expertRates || {})) {
    if (typeof rate !== "number" || !(rate >= 0 && rate <= 1)) {
      throw new Error(`config.json: the rate for expert ${shortId(id)} must be a number from 0 to 1 (0.4 = 40%)`);
    }
    expertRates[id] = rate;
  }
  const excludeUserIds = cfg.excludeUserIds || [];
  if (!Array.isArray(excludeUserIds) || excludeUserIds.some((x) => typeof x !== "string")) {
    throw new Error("config.json: excludeUserIds must be a list of user id strings");
  }
  return { expertRates, excludeUserIds };
}

function loadConfig(dir) {
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) return { expertRates: {}, excludeUserIds: [], found: false };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error("config.json is not valid JSON"); }
  return { ...validateConfig(raw), found: true };
}

// ---------- the report (pure) ----------

function buildReport({ sessions, orders, ledger, experts, config, noExclusions = false, asOf, month }) {
  const excluded = noExclusions ? new Set() : new Set(config.excludeUserIds || []);
  const expertName = new Map(experts.map((e) => [e.id, e.name]));
  const rows = new Map();   // expert id -> aggregate
  const sessionRows = [];
  const attention = [];
  let ignoredZero = 0, excludedCount = 0, excludedPaise = 0;

  const rowFor = (id) => {
    if (!rows.has(id)) {
      rows.set(id, { expert_id: id, expert_name: expertName.get(id) || "(unknown expert)", paid: 0, earned: 0, active: 0, refunded: 0, held: 0, gross: 0, refundedP: 0, heldP: 0, netP: 0 });
    }
    return rows.get(id);
  };
  for (const e of experts) rowFor(e.id);

  for (const s of sessions) {
    if (!(s.amount_paise > 0)) { ignoredZero++; continue; }
    if (excluded.has(s.user_id)) { excludedCount++; excludedPaise += s.amount_paise; continue; }

    const gross = s.amount_paise;
    const channel = s.razorpay_order_id ? "razorpay" : s.play_purchase_token ? "google_play" : "unknown";
    const order = s.razorpay_order_id ? orders.get(s.razorpay_order_id) : null;
    const led = ledger.get(s.id) || null;
    const flags = [];
    let state, counted = 0, refunded = 0, held = 0;

    if (channel === "razorpay" && (!order || order.status !== "verified")) {
      state = "held"; held = gross;
      flags.push(`order not verified (${order ? order.status : "missing"})`);
    } else if (led) {
      if (led.status === "refunded") {
        state = "refunded"; refunded = gross;
        if (led.amount_paise !== gross) flags.push(`ledger refund amount ${rupees(led.amount_paise)} differs from paid ${rupees(gross)}`);
      } else {
        state = "held"; held = gross;
        flags.push(`refund ${led.status}${led.last_error ? ": " + led.last_error : ""}`);
      }
    } else if (s.ended_reason === "expert_silent") {
      state = "held"; held = gross;
      flags.push("ended as expert_silent but there is no ledger row");
    } else {
      counted = gross;
      state = s.status === "active" ? "active" : "earned";
      if (s.status === "active") flags.push("still active at report time");
    }
    if (!expertName.has(s.expert_id)) flags.push("expert id not in the experts table");

    const r = rowFor(s.expert_id);
    r.paid++; r.gross += gross; r.refundedP += refunded; r.heldP += held; r.netP += counted;
    if (state === "refunded") r.refunded++;
    if (state === "held") r.held++;
    if (state === "earned" || state === "active") r.earned++;
    if (state === "active") r.active++;

    sessionRows.push({
      session_id: s.id, channel, order_id: s.razorpay_order_id || "", customer: shortId(s.user_id),
      expert: expertName.get(s.expert_id) || shortId(s.expert_id),
      paid_at_ist: fmtIst(s.created_at), ended_at_ist: fmtIst(s.ended_at), status: s.status, ended_reason: s.ended_reason || "",
      ledger_status: led ? led.status : "", refund_id: led && led.refund_id ? led.refund_id : "",
      amount: rupees(gross), counted: rupees(counted), refunded: rupees(refunded), held: rupees(held), flags: flags.join("; "),
    });
    if (flags.length) {
      attention.push(`${state.toUpperCase().padEnd(8)} session ${shortId(s.id)} | ${expertName.get(s.expert_id) || shortId(s.expert_id)} | Rs ${rupees(gross)} | ${flags.join("; ")}`);
    }
  }

  const expertRows = [];
  let allHavePayout = true, payoutTotalP = 0;
  const totals = { paid: 0, earned: 0, active: 0, refunded: 0, held: 0, gross: 0, refundedP: 0, heldP: 0, netP: 0 };
  for (const r of [...rows.values()].sort((a, b) => a.expert_name.localeCompare(b.expert_name))) {
    const rate = Object.prototype.hasOwnProperty.call(config.expertRates, r.expert_id) ? config.expertRates[r.expert_id] : null;
    const payoutP = rate === null ? null : Math.round(r.netP * rate);
    if (payoutP === null) allHavePayout = false; else payoutTotalP += payoutP;
    if (rate === null && r.paid > 0) attention.push(`NO RATE  ${r.expert_name} (${shortId(r.expert_id)}) has ${r.paid} paid session(s) but no share rate in config.json: payout left blank`);
    expertRows.push({
      expert_id: r.expert_id, expert_name: r.expert_name, sessions_paid: r.paid, sessions_earned: r.earned, sessions_active: r.active,
      sessions_refunded: r.refunded, sessions_held: r.held, gross: rupees(r.gross), refunded: rupees(r.refundedP), held_back: rupees(r.heldP),
      net: rupees(r.netP), share_rate: rate === null ? "" : String(rate), payout: payoutP === null ? "" : rupees(payoutP),
    });
    for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
  }
  expertRows.push({
    expert_id: "", expert_name: "TOTAL", sessions_paid: totals.paid, sessions_earned: totals.earned, sessions_active: totals.active,
    sessions_refunded: totals.refunded, sessions_held: totals.held, gross: rupees(totals.gross), refunded: rupees(totals.refundedP),
    held_back: rupees(totals.heldP), net: rupees(totals.netP), share_rate: "", payout: allHavePayout ? rupees(payoutTotalP) : "",
  });

  const header = [];
  header.push(`Expert earnings ${month} (IST) - as of ${asOf}`);
  header.push(noExclusions ? "EXCLUSIONS OFF: your own test accounts ARE included (reconciliation run)." : `Exclusions on: ${excluded.size} user id(s) in config.json are skipped.`);
  header.push("Gross only: Razorpay / Google fees and GST are not subtracted.");
  const notes = [];
  if (ignoredZero) notes.push(`${ignoredZero} Rs 0 session(s) ignored.`);
  if (excludedCount) notes.push(`${excludedCount} session(s) worth Rs ${rupees(excludedPaise)} skipped because the customer is in the exclusion list.`);
  if (!config.found) notes.push("No config.json found in the reports folder: no rates, no exclusions.");

  return { expertRows, sessionRows, attention, header, notes, totals, ignoredZero, excludedCount };
}

// ---------- CSV ----------

function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

const EXPERT_COLUMNS = ["expert_id", "expert_name", "sessions_paid", "sessions_earned", "sessions_active", "sessions_refunded", "sessions_held", "gross", "refunded", "held_back", "net", "share_rate", "payout"];
const SESSION_COLUMNS = ["session_id", "channel", "order_id", "customer", "expert", "paid_at_ist", "ended_at_ist", "status", "ended_reason", "ledger_status", "refund_id", "amount", "counted", "refunded", "held", "flags"];

// ---------- main ----------

function parseArgs(argv) {
  const get = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
  return { month: get("--month"), out: get("--out"), config: get("--config"), noExclusions: argv.includes("--no-exclusions"), help: argv.includes("--help") };
}

async function main(argv, env, fetchImpl, log = console.log) {
  const args = parseArgs(argv);
  if (args.help || !args.month) {
    log("usage: node backend/scripts/expert-earnings-report.js --month 2026-10 [--no-exclusions] [--out DIR] [--config DIR]\n" +
        "needs SUPABASE_SERVICE_ROLE_KEY in the environment (source ~/.nakshatra-realtime-test.env)");
    return null;
  }
  const window = istMonthWindow(args.month);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set (source ~/.nakshatra-realtime-test.env first)");
  const base = (env.SUPABASE_URL || DEFAULT_URL).replace(/\/$/, "");

  const reportsDir = path.resolve(args.out || path.join(os.homedir(), "Documents", "nakshatra-reports"));
  const inRepo = path.relative(REPO_ROOT, reportsDir);
  if (inRepo === "" || (!inRepo.startsWith("..") && !path.isAbsolute(inRepo))) {
    throw new Error("refusing to write reports inside the git repo; use a folder outside it (default ~/Documents/nakshatra-reports)");
  }
  const config = loadConfig(path.resolve(args.config || reportsDir));

  const api = makeApi(base, key, fetchImpl);
  const sessions = await fetchAll(api, "chat_sessions",
    `select=id,user_id,expert_id,status,amount_paise,razorpay_order_id,play_purchase_token,ended_reason,created_at,ended_at` +
    `&created_at=gte.${encodeURIComponent(window.startIso)}&created_at=lt.${encodeURIComponent(window.endIso)}&order=created_at,id`);
  const ids = sessions.map((s) => s.id);
  const orderIds = [...new Set(sessions.map((s) => s.razorpay_order_id).filter(Boolean))];
  const ledgerRows = await fetchIn(api, "expert_session_refunds", "session_id", ids, "session_id,status,amount_paise,refund_id,last_error,attempts");
  const orderRows = await fetchIn(api, "razorpay_orders", "order_id", orderIds, "order_id,status,verified_at");
  const experts = await fetchAll(api, "experts", "select=id,name&order=id");

  const asOf = new Date().toISOString();
  const report = buildReport({
    sessions, orders: new Map(orderRows.map((o) => [o.order_id, o])), ledger: new Map(ledgerRows.map((l) => [l.session_id, l])),
    experts, config, noExclusions: args.noExclusions, asOf, month: args.month,
  });
  for (const id of Object.keys(config.expertRates)) {
    if (!experts.some((e) => e.id === id)) report.attention.push(`CONFIG   a rate is set for expert id ${shortId(id)}, which is not in the experts table`);
  }

  const folder = path.join(reportsDir, args.month + (args.noExclusions ? "-no-exclusions" : ""));
  fs.mkdirSync(folder, { recursive: true });
  const files = {
    experts: path.join(folder, `expert-earnings-${args.month}.csv`),
    sessions: path.join(folder, `sessions-${args.month}.csv`),
    attention: path.join(folder, `needs-attention-${args.month}.txt`),
  };
  fs.writeFileSync(files.experts, toCsv(EXPERT_COLUMNS, report.expertRows));
  fs.writeFileSync(files.sessions, toCsv(SESSION_COLUMNS, report.sessionRows));
  const body = report.attention.length ? report.attention : ["Nothing needs attention."];
  fs.writeFileSync(files.attention, [...report.header, ...report.notes, "", ...body].join("\n") + "\n");

  log(`${report.sessionRows.length} paid session(s) in ${args.month}; ${report.attention.length} item(s) need attention.`);
  for (const f of Object.values(files)) log("wrote " + f);
  return { report, files };
}

module.exports = { readOnlyFetch, makeApi, fetchAll, fetchIn, istMonthWindow, fmtIst, validateConfig, loadConfig, buildReport, csvCell, toCsv, main, REPO_ROOT };

if (require.main === module) {
  main(process.argv.slice(2), process.env, fetch).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
