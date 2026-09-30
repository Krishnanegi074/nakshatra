const fs = require("fs");
const path = __dirname;

function read(f) { return fs.readFileSync(path + "/" + f, "utf8"); }

let html = read("index.template.html");
const astronomyLib = read("astronomy.browser.min.js");
const engineJs = read("engine.browser.js");
const cityData = read("city-data.js");
const rulesJs = read("rules.js");
const cvEngineJs = read("cv-engine.js");
const i18nJs = read("i18n.js");
const appCss = read("app.css");
const appJs = read("app.js");
const supabaseClientJs = read("supabase-client.js");

html = html.replace("/*__APP_CSS__*/", appCss);
html = html.replace("/*__ASTRONOMY_LIB__*/", astronomyLib);
html = html.replace("/*__ENGINE_JS__*/", engineJs);
html = html.replace("/*__CITY_DATA__*/", cityData);
html = html.replace("/*__RULES_JS__*/", rulesJs);
html = html.replace("/*__CV_ENGINE_JS__*/", cvEngineJs);
html = html.replace("/*__I18N_JS__*/", i18nJs);
html = html.replace("/*__SUPABASE_CLIENT_JS__*/", supabaseClientJs);
html = html.replace("/*__APP_JS__*/", appJs);

// --beta <outfile>: private-beta build. Adds noindex, a visible badge, and
// window.NAKSHATRA_BETA, which turns OFF the report/gift checkout (those use
// LIVE Razorpay keys) — see supabase-client.js. Expert chat stays on test keys.
const betaIdx = process.argv.indexOf("--beta");
if (betaIdx !== -1) {
  const out = process.argv[betaIdx + 1];
  if (!out) { console.error("usage: node build.js --beta <outfile>"); process.exit(1); }
  const betaHead = '<meta name="robots" content="noindex,nofollow"><script>window.NAKSHATRA_BETA=true;</script>';
  const betaBadge = '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#7c3aed;color:#fff;font:600 11px/1 Poppins,sans-serif;text-align:center;padding:4px;pointer-events:none">PRIVATE BETA — test payments only, nothing is charged</div>';
  html = html.replace("<head>", "<head>" + betaHead).replace(/<body([^>]*)>/, "<body$1>" + betaBadge);
  fs.mkdirSync(require("path").dirname(require("path").resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  console.log("Built BETA", out, "—", (html.length / 1024).toFixed(1), "KB");
} else {
  fs.writeFileSync(path + "/nakshatra-app.html", html);
  console.log("Built nakshatra-app.html —", (html.length / 1024).toFixed(1), "KB");
}
