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

fs.writeFileSync(path + "/nakshatra-app.html", html);
console.log("Built nakshatra-app.html —", (html.length / 1024).toFixed(1), "KB");
