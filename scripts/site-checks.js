// Safety checks on a folder that is about to be published as the public website. Exits 1 on any violation.
//   node scripts/site-checks.js --dir <staging folder>
//
//   1. beta markers: no published HTML may contain window.NAKSHATRA_BETA=true or "PRIVATE BETA", and the two app files may not
//      contain "noindex" (the beta build did; the real app must stay indexable)
//   2. secret scan: none of the owner's real secret values (read from ~/.nakshatra-realtime-test.env, never printed) and no
//      secret-shaped strings (sb_secret_ keys, JWTs with role service_role, private keys, Razorpay key secrets, cloud tokens)
//   3. email allow-list: the only email-shaped strings allowed are support@nakshatra.ind.in, anything @example.(com|org|net),
//      the placeholders listed below, and the licence notice of a bundled third-party library (a "Copyright ... <address>" line)
//
// Findings are printed as file, line and type with the value masked. Nothing here changes any file.

const fs = require("fs");
const path = require("path");
const os = require("os");

const dirIdx = process.argv.indexOf("--dir");
if (dirIdx < 0 || !process.argv[dirIdx + 1]) { console.error("usage: node scripts/site-checks.js --dir <folder>"); process.exit(2); }
const ROOT = path.resolve(process.argv[dirIdx + 1]);

const ALLOWED_EMAILS = new Set(["support@nakshatra.ind.in"]);
const PLACEHOLDER_EMAILS = new Set(["you@email.com"]);                 // an input placeholder on the Kundli page
const ALLOWED_EMAIL_RE = /@example\.(com|org|net|co\.in)$/i;
const TEXT_EXT = /\.(html?|js|css|json|xml|txt|md|svg|webmanifest)$/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT).filter((f) => TEXT_EXT.test(f));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// real secret values held locally (never printed)
const exact = {};
const envFile = path.join(os.homedir(), ".nakshatra-realtime-test.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && ["SUPABASE_SERVICE_ROLE_KEY", "SWEEP_SECRET", "EXPERT_PASSWORD"].includes(m[1])) {
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v.length >= 12) exact[m[1]] = v;
    }
  }
}

const findings = [];
const add = (type, file, line, note) => findings.push({ type, file, line, note });
const maskEmail = (e) => e.replace(/^([A-Za-z0-9._%+-]{3})[A-Za-z0-9._%+-]*@/, "$1***@");

for (const f of files) {
  const r = rel(f);
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n");

  // 1. beta markers
  const isHtml = /\.html?$/i.test(f);
  if (isHtml) {
    lines.forEach((l, i) => {
      if (/window\.NAKSHATRA_BETA\s*=\s*true/.test(l)) add("beta marker (NAKSHATRA_BETA=true)", r, i + 1);
      if (/PRIVATE BETA/.test(l)) add("beta marker (PRIVATE BETA banner)", r, i + 1);
    });
    if ((r === "index.html" || r === "app/index.html") && /noindex/i.test(text)) add("beta marker (noindex in the app)", r, 0);
  }

  // 2. secrets
  for (const [name, v] of Object.entries(exact)) if (text.includes(v)) add(`REAL SECRET VALUE (your ${name})`, r, 0);
  lines.forEach((l, i) => {
    if (/sb_secret_[A-Za-z0-9_\-]{8,}/.test(l)) add("sb_secret_ key", r, i + 1);
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/.test(l) && !/\.replace\(/.test(l)) add("private key block", r, i + 1);
    if (/(?:razorpay_key_secret|key_secret|rzp_secret)["']?\s*[:=]\s*["'][A-Za-z0-9]{20,}["']/i.test(l)) add("Razorpay key secret assignment", r, i + 1);
    if (/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/.test(l) || /\bAKIA[0-9A-Z]{16}\b/.test(l) || /\bsk_live_[A-Za-z0-9]{16,}/.test(l)) add("cloud / token secret", r, i + 1);
    if (/"type"\s*:\s*"service_account"/.test(l)) add("service-account json", r, i + 1);
    for (const m of l.matchAll(/eyJ[A-Za-z0-9_\-]{8,}\.(eyJ[A-Za-z0-9_\-]{8,})\.[A-Za-z0-9_\-]{8,}/g)) {
      let role = "undecodable";
      try { role = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).role || "none"; } catch (_) {}
      add(`JWT (role=${role})${role === "service_role" ? "  <-- CRITICAL" : ""}`, r, i + 1);
    }
  });

  // 3. emails
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      const e = m[0].toLowerCase();
      if (ALLOWED_EMAILS.has(e) || PLACEHOLDER_EMAILS.has(e) || ALLOWED_EMAIL_RE.test(e)) continue;
      if (/copyright/i.test(l) && /<[^>]+@[^>]+>/.test(l)) continue;           // a bundled library's licence notice
      add("email address not on the allow-list: " + maskEmail(m[0]), r, i + 1);
    }
  });
}

console.log(`site-checks: ${files.length} text file(s) scanned in ${ROOT}`);
console.log(`  exact secrets compared: ${Object.keys(exact).join(", ") || "none available"} (values never printed)`);
if (!findings.length) {
  console.log("  beta markers: none | secrets: none | emails: only allow-listed ones");
  process.exit(0);
}
console.log(`  ${findings.length} VIOLATION(S):`);
for (const f of findings) console.log(`   - ${f.type}  [${f.file}${f.line ? ":" + f.line : ""}]`);
process.exit(1);
