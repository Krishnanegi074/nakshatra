(function () {
"use strict";

// ================= STATE =================
const state = {
  user: null,
  authMode: "signup",
  birth: { year: null, month: null, day: null, hour: 12, minute: 0, unknownTime: false, city: null },
  computed: { sunIdx: null, moonIdx: null, ascIdx: null, moonPhase: null },
  palmAnswers: {},
  palmReport: null,
  unlocked: false,
  selectedTier: "onetime",
  payMethod: "upi",
  history: ["screen-landing"],
  compatResult: null,
  notifPermission: (typeof Notification !== "undefined" && Notification.permission) || "unsupported",
  // Gifting: giftCodes is deliberately NOT reset on logout (see initDashNav) so a
  // "recipient" who signs up fresh in the same browser tab can still redeem a code
  // a previous "sender" generated. There is no backend, so codes only ever exist in
  // this page's memory — real cross-device delivery is out of scope, and the UI says
  // so explicitly (see #screen-gift-send's demo note).
  giftCodes: {},
  giftInProgress: null,
  lastGiftCode: null,
  giftTier: "bundle",
  // Language: detect once from the browser as a nice default, but this is NOT
  // persisted (no localStorage — see the top-of-file note on why artifacts must
  // avoid browser storage) so it resets to the detected default each fresh load.
  lang: (typeof navigator !== "undefined" && /^hi/i.test(navigator.language || "")) ? "hi" : "en",
  // Astrologer chat (Phase 4, demo): a personal conversation belongs to the signed-in
  // user, so — unlike giftCodes/communityFeed below — this DOES reset on logout.
  chats: {}, // { [astrologerId]: { messages: [{from:"user"|"astro", text}] } }
  activeChatId: null,
  // Community feed (Phase 4, demo): deliberately NOT reset on logout, same reasoning
  // as giftCodes — it simulates a feed other people would still see, so a fresh
  // "second user" signing up in the same tab should still see posts from before.
  // There is no backend, so this only ever exists in this page's memory.
  communityFeed: [], // user-added posts only; seed posts live in COMMUNITY_SEED (rules.js)
  communityLikes: {}, // { [postId]: true } — also not reset on logout, same reasoning
  _postSeq: 0,
};

const TIER_INFO = {
  onetime: { name: "One-Time Report", price: 399, label: "₹399" },
  bundle: { name: "Premium Bundle", price: 599, label: "₹599" },
  subscription: { name: "Monthly Subscription", price: 299, label: "₹299/mo" },
};

// ================= BACKEND (Supabase) =================
// Everything below talks to NakshatraDB.db (see supabase-client.js), which
// wraps a real Supabase project — see that file's header for setup steps.
// If SUPABASE_URL/SUPABASE_ANON_KEY are still placeholders, or supabase-js
// didn't load (e.g. testing this file fully offline), NakshatraDB.db is
// null and backendDb() returns null — every call site below already checks
// for that and falls back to the old in-memory-only behavior, so this file
// still works standalone; it just won't persist anything anywhere.
function backendDb() {
  return (typeof NakshatraDB !== "undefined" && NakshatraDB.db) || null;
}

// Wraps a supabase-js call so a network/DB failure never throws past this
// point uncaught — every call site gets back {data, error} and decides for
// itself whether that failure should block the user or just show a toast.
async function backendCall(promise, label) {
  try {
    const { data, error } = await promise;
    if (error) console.error("[backend] " + label + " failed:", error.message || error);
    return { data, error };
  } catch (err) {
    console.error("[backend] " + label + " threw:", err);
    return { data: null, error: err };
  }
}

// Pulls this user's profile/birth chart/palm report/unlock status down from
// the real backend and hydrates `state` with it — used right after login
// and on page-load session restore, so a returning user sees their own data
// instead of a blank slate.
async function loadUserDataFromBackend() {
  const dbInstance = backendDb();
  if (!dbInstance) return;

  const [profileRes, birthRes, palmRes, unlockRes] = await Promise.all([
    backendCall(dbInstance.loadProfile(), "loadProfile"),
    backendCall(dbInstance.loadBirthData(), "loadBirthData"),
    backendCall(dbInstance.loadPalmReport(), "loadPalmReport"),
    backendCall(dbInstance.loadUnlockStatus(), "loadUnlockStatus"),
  ]);

  if (profileRes.data) {
    state.user = { name: profileRes.data.name, email: profileRes.data.email };
  }

  if (birthRes.data) {
    const b = birthRes.data;
    state.birth = {
      year: b.year, month: b.month, day: b.day, hour: b.hour, minute: b.minute,
      unknownTime: b.unknown_time,
      city: b.city_name ? { name: b.city_name, country: b.city_country, lat: b.city_lat, lon: b.city_lon, utc: b.city_utc } : null,
    };
    state.computed.sunIdx = b.sun_idx;
    state.computed.moonIdx = b.moon_idx;
    state.computed.ascIdx = b.asc_idx;
    state.computed.moonPhase = getMoonPhase(new Date()); // always "now" — never persisted
    if (state.birth.city) {
      state.computed.birthUtc = toUtcDate({ year: b.year, month: b.month, day: b.day, hour: b.hour, minute: b.minute }, state.birth.city.utc);
    }
  }

  if (palmRes.data) {
    state.palmAnswers = palmRes.data.answers || {};
    state.palmReport = palmRes.data.report || null;
  }

  if (unlockRes.data) {
    state.unlocked = !!unlockRes.data.unlocked;
  }
}

// Silently resumes an already-signed-in user on page load (real Supabase
// sessions persist across reloads) instead of always starting at the
// landing screen.
async function bootstrapSession() {
  const dbInstance = backendDb();
  if (!dbInstance) return;
  const { data } = await backendCall(dbInstance.getSession(), "getSession");
  const session = data && data.session;
  if (!session) return;
  state.user = {
    name: (session.user.user_metadata && session.user.user_metadata.name) || session.user.email.split("@")[0],
    email: session.user.email,
  };
  await loadUserDataFromBackend();
  if (state.birth.year) {
    showScreen("screen-dashboard");
    renderDashboard();
  } else {
    resetOnboarding();
    showScreen("screen-onboarding");
  }
}

// Turns a Supabase auth error into a message a non-technical user can act on.
function authErrorMessage(error) {
  const msg = (error && error.message) || "";
  if (/already registered|already exists/i.test(msg)) return "That email is already registered — try logging in instead.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/password/i.test(msg) && /short|least|character/i.test(msg)) return "Password must be at least 6 characters.";
  return msg || "Something went wrong — please try again.";
}

// "3h ago" / "2d ago" style label for a community_posts.created_at timestamp
// coming back from the database, matching COMMUNITY_SEED's hand-written style.
function timeAgoFrom(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
}

// ================= UTIL =================
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

// ================= i18n =================
// Named `tr` (not `t`) — `t` is already used as a common local variable name
// elsewhere in this file (toast element, forEach params) and shadowing it would
// be an easy source of bugs.
function tr(key, vars) {
  const dict = I18N[state.lang] || I18N.en;
  let str = dict && dict[key] !== undefined ? dict[key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
  if (vars) Object.keys(vars).forEach((k) => { str = str.split("{" + k + "}").join(vars[k]); });
  return str;
}

function signName(idx) {
  if (idx == null) return null;
  return state.lang === "hi" ? SIGNS_HI[idx] : SIGNS[idx];
}

function tierDisplayName(key) {
  const map = { onetime: "tier.onetime.title", bundle: "tier.bundle.title", subscription: "tier.sub.title" };
  return (map[key] && tr(map[key])) || (TIER_INFO[key] && TIER_INFO[key].name) || key;
}

function applyLanguage(lang) {
  state.lang = lang;
  document.documentElement.lang = lang;
  $all("[data-i18n]").forEach((el) => { el.textContent = tr(el.getAttribute("data-i18n")); });
  $all("[data-i18n-html]").forEach((el) => { el.innerHTML = tr(el.getAttribute("data-i18n-html")); });
  $all("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", tr(el.getAttribute("data-i18n-ph"))); });

  // The innerHTML swaps above destroy and recreate any nested elements they contain —
  // including two spans with their own click listeners (attached once at init time).
  // Re-bind them onto whatever node currently holds that id, every time.
  const methodToggle = $("#horo-methodology-toggle");
  if (methodToggle) methodToggle.addEventListener("click", () => $("#sheet-method-backdrop").classList.add("visible"));
  const redeemOpener = $("#open-redeem-sheet");
  if (redeemOpener) redeemOpener.addEventListener("click", () => { $("#input-gift-code").value = ""; $("#sheet-redeem-backdrop").classList.add("visible"); });

  $all(".lang-option").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  const langNote = $("#dash-lang-note");
  if (langNote) {
    const note = tr("content.hi-note");
    langNote.style.display = lang !== "en" && note ? "block" : "none";
    langNote.textContent = note;
  }

  // Auth submit button + onboarding "Continue"/"Calculate" button text are set by
  // JS conditionally (not static data-i18n targets) — refresh them here too.
  const authBtn = $("#btn-auth-submit");
  if (authBtn) authBtn.textContent = tr(state.authMode === "signup" ? "auth.submit.signup" : "auth.submit.login");

  // Whether accounts are real (backend connected) or demo-only (offline
  // build) changes which privacy note is true — override the static
  // data-i18n text above with the accurate one for however this file was
  // actually deployed.
  const authNote = $("#auth-demo-note");
  if (authNote) authNote.textContent = tr(backendDb() ? "auth.demo-note.live" : "auth.demo-note");

  // Re-sync whichever screen is currently active so dynamic content (sign names,
  // the dashboard blurb, tier names, etc.) picks up the new language immediately
  // instead of waiting for the next navigation.
  const activeEl = document.querySelector(".screen.active");
  const activeId = activeEl && activeEl.id;
  if (activeId === "screen-onboarding") renderOnbStep();
  if (activeId === "screen-dashboard" && state.computed.sunIdx != null) renderDashboard();
  if (activeId === "screen-yearahead" && state.computed.sunIdx != null) renderYearAheadScreen();
  if (activeId === "screen-fullreport") renderFullReport();
  if (activeId === "screen-report") renderTierSelection();
  if (activeId === "screen-checkout") renderCheckout();
  if (activeId === "screen-gift-send") renderGiftSend();
  if (activeId === "screen-gift-sent") renderGiftSent();
  if (activeId === "screen-community") renderCommunityFeed();
}

function initLangSwitch() {
  function open() { $("#sheet-lang-backdrop").classList.add("visible"); }
  function close() { $("#sheet-lang-backdrop").classList.remove("visible"); }
  const toggle1 = $("#btn-lang-toggle");
  const toggle2 = $("#btn-lang-toggle-dash");
  if (toggle1) toggle1.addEventListener("click", open);
  if (toggle2) toggle2.addEventListener("click", open);
  $("#btn-close-lang").addEventListener("click", close);
  $("#sheet-lang-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-lang-backdrop") close(); });
  $all(".lang-option").forEach((b) => b.addEventListener("click", () => { applyLanguage(b.dataset.lang); close(); }));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function showScreen(id, opts) {
  opts = opts || {};
  $all(".screen").forEach(s => s.classList.remove("active"));
  const target = document.getElementById(id);
  if (target) target.classList.add("active");
  window.scrollTo(0, 0);
  const navScreens = ["screen-dashboard", "screen-horoscope", "screen-palm", "screen-love", "screen-fullreport", "screen-compat", "screen-yearahead"];
  $("#bottom-nav").classList.toggle("visible", navScreens.includes(id));
  $all(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.nav === id));
  if (!opts.silent) state.history.push(id);

  if (id === "screen-horoscope") renderHoroscope();
  if (id === "screen-palm") renderPalmScreen();
  if (id === "screen-love") renderLoveEnergy();
  if (id === "screen-report") renderTierSelection();
  if (id === "screen-checkout") renderCheckout();
  if (id === "screen-fullreport") renderFullReport();
  if (id === "screen-compat") renderCompatScreen();
  if (id === "screen-yearahead") renderYearAheadScreen();
  if (id === "screen-gift-send") renderGiftSend();
  if (id === "screen-gift-sent") renderGiftSent();
  if (id === "screen-chat-picker") renderChatPicker();
  if (id === "screen-chat") renderChatScreen();
  if (id === "screen-community") refreshCommunityFeed();
  if (id === "screen-settings") resetSettingsDeleteUI();
}

// ================= STARFIELD =================
function initStars() {
  const wrap = $("#stars-bg");
  const n = 90;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "star";
    const size = (Math.random() * 2 + 1).toFixed(1);
    s.style.width = size + "px";
    s.style.height = size + "px";
    s.style.top = (Math.random() * 100).toFixed(2) + "%";
    s.style.left = (Math.random() * 100).toFixed(2) + "%";
    s.style.animationDelay = (Math.random() * 3).toFixed(2) + "s";
    wrap.appendChild(s);
  }
}

// ================= NAV DELEGATION =================
document.addEventListener("click", (e) => {
  const navEl = e.target.closest("[data-nav]");
  if (navEl) { showScreen(navEl.dataset.nav); return; }
  const backEl = e.target.closest("[data-back]");
  if (backEl) { showScreen(backEl.dataset.back); return; }
});

// ================= AUTH =================
function initAuth() {
  $("#btn-landing-start").addEventListener("click", () => { state.authMode = "signup"; syncAuthTabs(); showScreen("screen-auth"); });
  $("#btn-landing-login").addEventListener("click", () => { state.authMode = "login"; syncAuthTabs(); showScreen("screen-auth"); });
  $("#tab-signup").addEventListener("click", () => { state.authMode = "signup"; syncAuthTabs(); });
  $("#tab-login").addEventListener("click", () => { state.authMode = "login"; syncAuthTabs(); });

  function syncAuthTabs() {
    $("#tab-signup").classList.toggle("active", state.authMode === "signup");
    $("#tab-login").classList.toggle("active", state.authMode === "login");
    $("#field-name").style.display = state.authMode === "signup" ? "block" : "none";
    $("#btn-auth-submit").textContent = tr(state.authMode === "signup" ? "auth.submit.signup" : "auth.submit.login");
  }

  $("#btn-auth-submit").addEventListener("click", async () => {
    const email = $("#input-email").value.trim();
    const pw = $("#input-password").value;
    const name = $("#input-name").value.trim();
    if (!email || !email.includes("@")) return toast("Enter a valid email");
    if (!pw || pw.length < 6) return toast("Password must be at least 6 characters");
    if (state.authMode === "signup" && !name) return toast("Enter your name");

    const dbInstance = backendDb();
    if (!dbInstance) {
      // No backend configured (e.g. testing this file fully offline) — fall
      // back to the old in-memory-only behavior so the file still works.
      state.user = { name: name || email.split("@")[0], email };
      toast(`Welcome${state.user.name ? ", " + state.user.name : ""}!`);
      if (state.birth.year) { showScreen("screen-dashboard"); } else { resetOnboarding(); showScreen("screen-onboarding"); }
      return;
    }

    const submitBtn = $("#btn-auth-submit");
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = tr("auth.submitting");
    try {
      if (state.authMode === "signup") {
        const { data, error } = await dbInstance.signUp(email, pw, name);
        if (error) return toast(authErrorMessage(error));
        if (!data || !data.session) {
          // The project has email confirmation turned on — no session yet.
          toast("Check your email to confirm your account, then log in.");
          state.authMode = "login";
          syncAuthTabs();
          return;
        }
        state.user = { name, email };
        toast(`Welcome, ${name}!`);
        resetOnboarding();
        showScreen("screen-onboarding");
      } else {
        const { data, error } = await dbInstance.signIn(email, pw);
        if (error) return toast(authErrorMessage(error));
        state.user = {
          name: (data.user.user_metadata && data.user.user_metadata.name) || email.split("@")[0],
          email,
        };
        await loadUserDataFromBackend();
        toast(`Welcome back${state.user.name ? ", " + state.user.name : ""}!`);
        if (state.birth.year) {
          showScreen("screen-dashboard");
          renderDashboard();
        } else {
          resetOnboarding();
          showScreen("screen-onboarding");
        }
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

// ================= ONBOARDING =================
let onbStep = 0;
function resetOnboarding() {
  onbStep = 0;
  // Clear raw form fields too — otherwise a second signup in the same browser
  // session (after logout) silently inherits the previous user's typed values.
  $("#input-dob").value = "";
  $("#input-tob").value = "";
  $("#input-tob").disabled = false;
  $("#input-tob").style.opacity = 1;
  $("#input-city").value = "";
  $("#check-unknown-time").classList.remove("checked");
  $("#check-unknown-time").textContent = "";
  renderOnbStep();
}

function resetPalmUI() {
  const fileInput = $("#palm-file-input");
  if (fileInput) fileInput.value = "";
  $("#palm-upload-box").style.display = "block";
  $("#palm-crop-wrap").style.display = "none";
  $("#palm-preview").src = "";
  $("#palm-crop-hint").style.display = "none";
  $("#btn-palm-analyze").style.display = "none";
  $("#btn-palm-change-photo").style.display = "none";
  $("#palm-cv-status").style.display = "none";
  $("#palm-cv-status").textContent = "";
  $("#palm-quality-warning").style.display = "none";
  cropRect = null;
  cropDrag = null;
  $("#palm-finger-labels").innerHTML = "";
  $all(".cv-tag").forEach(t => { t.style.display = "none"; t.textContent = ""; t.classList.remove("low"); });
  $all(".option-btn.selected").forEach(b => b.classList.remove("selected"));
  $("#btn-palm-generate").disabled = true;
  $("#palm-intro").style.display = "block";
  $("#palm-result").style.display = "none";
}

function renderOnbStep() {
  for (let i = 0; i < 4; i++) $("#onb-step-" + i).style.display = i === onbStep ? "block" : "none";
  $all("#onb-progress span").forEach((el, i) => el.classList.toggle("done", i <= onbStep));
  $("#btn-onb-next").textContent = onbStep === 3 ? tr("onb.calculate") : tr("onb.next");
  if (onbStep === 3) buildOnbSummary();
}

function buildOnbSummary() {
  const b = state.birth;
  const dateStr = b.year ? `${b.day}/${b.month}/${b.year}` : "—";
  const timeStr = b.unknownTime ? tr("onb.summary.tob-unknown") : `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`;
  const cityStr = b.city ? `${b.city.name}, ${b.city.country}` : "—";
  $("#onb-summary").innerHTML = `
    <div class="row between"><span class="muted">${tr("onb.summary.dob")}</span><strong>${dateStr}</strong></div>
    <div class="row between"><span class="muted">${tr("onb.summary.tob")}</span><strong>${timeStr}</strong></div>
    <div class="row between"><span class="muted">${tr("onb.summary.city")}</span><strong>${cityStr}</strong></div>
  `;
}

function initOnboarding() {
  const todayStr = new Date().toISOString().slice(0, 10);
  $("#input-dob").setAttribute("max", todayStr);
  $("#input-dob").setAttribute("min", "1900-01-01");

  $("#btn-onb-back").addEventListener("click", () => {
    if (onbStep === 0) { showScreen("screen-auth"); return; }
    onbStep--; renderOnbStep();
  });

  $("#btn-onb-next").addEventListener("click", () => {
    if (onbStep === 0) {
      const v = $("#input-dob").value;
      if (!v) return toast("Please enter your date of birth");
      const [y, m, d] = v.split("-").map(Number);
      const chosen = new Date(Date.UTC(y, m - 1, d));
      const today = new Date();
      const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
      if (chosen > todayUTC) return toast("Birth date can't be in the future");
      if (y < 1900) return toast("Please enter a valid birth year");
      state.birth.year = y; state.birth.month = m; state.birth.day = d;
    }
    if (onbStep === 1) {
      if (!state.birth.unknownTime) {
        const v = $("#input-tob").value;
        if (!v) return toast("Enter your birth time, or check “I don't know”");
        const [h, mi] = v.split(":").map(Number);
        state.birth.hour = h; state.birth.minute = mi;
      } else {
        state.birth.hour = 12; state.birth.minute = 0;
      }
    }
    if (onbStep === 2) {
      if (!state.birth.city) return toast("Please select your birth city");
    }
    if (onbStep === 3) {
      runChartCalculation();
      return;
    }
    onbStep++; renderOnbStep();
  });

  $("#toggle-unknown-time").addEventListener("click", () => {
    state.birth.unknownTime = !state.birth.unknownTime;
    $("#check-unknown-time").classList.toggle("checked", state.birth.unknownTime);
    $("#check-unknown-time").textContent = state.birth.unknownTime ? "✓" : "";
    $("#input-tob").disabled = state.birth.unknownTime;
    $("#input-tob").style.opacity = state.birth.unknownTime ? 0.4 : 1;
  });

  $("#input-city").addEventListener("click", openCitySheet);
  $("#city-search").addEventListener("input", renderCityList);
  $("#sheet-city-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-city-backdrop") closeCitySheet(); });
}

function openCitySheet() { $("#sheet-city-backdrop").classList.add("visible"); renderCityList(); $("#city-search").focus(); }
function closeCitySheet() { $("#sheet-city-backdrop").classList.remove("visible"); }

function renderCityList() {
  const q = $("#city-search").value.trim().toLowerCase();
  const list = CITIES.filter(c => c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q)).slice(0, 40);
  $("#city-list").innerHTML = list.map((c, i) =>
    `<div class="city-item" data-city="${CITIES.indexOf(c)}"><span>${c.name}</span><span class="muted">${c.country}</span></div>`
  ).join("") || `<p class="muted center" style="padding:20px 0">No cities found — try a nearby major city.</p>`;
  $all(".city-item").forEach(el => el.addEventListener("click", () => {
    const c = CITIES[Number(el.dataset.city)];
    state.birth.city = c;
    $("#input-city").value = `${c.name}, ${c.country}`;
    closeCitySheet();
  }));
}

// ================= CHART CALCULATION =================
function runChartCalculation() {
  showScreen("screen-calculating", { silent: true });
  const statuses = [tr("calc.status.0"), tr("calc.status.1"), tr("calc.status.2"), state.birth.unknownTime ? tr("calc.status.3unknown") : tr("calc.status.3known"), tr("calc.status.4")];
  let i = 0;
  const statusEl = $("#calc-status");
  statusEl.textContent = statuses[0];
  i = 1;
  const iv = setInterval(() => { statusEl.textContent = statuses[i % statuses.length]; i++; }, 480);

  setTimeout(async () => {
    clearInterval(iv);
    const b = state.birth;
    const utc = toUtcDate({ year: b.year, month: b.month, day: b.day, hour: b.hour, minute: b.minute }, b.city.utc);
    state.computed.sunIdx = getSunSign(utc);
    state.computed.moonIdx = getMoonSign(utc);
    state.computed.ascIdx = b.unknownTime ? null : getAscendantSign(utc, b.city.lat, b.city.lon);
    state.computed.moonPhase = getMoonPhase(new Date());
    state.computed.birthUtc = utc;

    const dbInstance = backendDb();
    if (dbInstance) {
      const { error } = await backendCall(dbInstance.saveBirthData({
        year: b.year, month: b.month, day: b.day, hour: b.hour, minute: b.minute,
        unknown_time: b.unknownTime,
        city_name: b.city.name, city_country: b.city.country, city_lat: b.city.lat, city_lon: b.city.lon, city_utc: b.city.utc,
        sun_idx: state.computed.sunIdx, moon_idx: state.computed.moonIdx, asc_idx: state.computed.ascIdx,
        moon_phase: state.computed.moonPhase.name,
      }), "saveBirthData");
      if (error) toast("Your chart is ready, but saving it failed — it won't be there next time you log in.");
    }

    showScreen("screen-dashboard");
    renderDashboard();
  }, 480 * statuses.length + 200);
}

// ================= DASHBOARD =================
function renderDashboard() {
  const c = state.computed;
  $("#dash-greeting").textContent = state.user ? `${tr("dash.hi")} ${state.user.name.split(" ")[0]} ✨` : tr("dash.default-greeting");
  $("#badge-sun").textContent = SIGN_SYMBOLS[c.sunIdx];
  $("#label-sun").textContent = signName(c.sunIdx);
  $("#badge-moon").textContent = SIGN_SYMBOLS[c.moonIdx];
  $("#label-moon").textContent = signName(c.moonIdx);
  if (c.ascIdx != null) {
    $("#badge-asc").textContent = SIGN_SYMBOLS[c.ascIdx];
    $("#label-asc").textContent = signName(c.ascIdx);
  } else {
    $("#badge-asc").textContent = "?";
    $("#label-asc").textContent = tr("common.unknown");
  }
  const sunInfo = state.lang === "hi" ? SIGN_INFO_HI[c.sunIdx] : SIGN_INFO[c.sunIdx];
  $("#dash-blurb").textContent = state.lang === "hi"
    ? `आपकी सूर्य राशि ${signName(c.sunIdx)} और चंद्र राशि ${signName(c.moonIdx)} है — आप सामान्यतः ${sunInfo.traits} होते हैं। इस सप्ताह की विकास दिशा: ${sunInfo.growth}।`
    : `With your Sun in ${signName(c.sunIdx)} and Moon in ${signName(c.moonIdx)}, you tend to be ${sunInfo.traits}. This week's growth edge: ${sunInfo.growth}.`;
}

// Clears everything tied to the signed-in person from local `state` — shared
// by logout (which deliberately keeps giftCodes/communityFeed/communityLikes,
// see the state comment above) and account deletion (which additionally
// clears those too, since there's no account left for them to belong to).
function resetLocalSessionState() {
  Object.assign(state, {
    user: null, birth: { year: null, month: null, day: null, hour: 12, minute: 0, unknownTime: false, city: null },
    computed: { sunIdx: null, moonIdx: null, ascIdx: null, moonPhase: null }, palmAnswers: {}, palmReport: null, unlocked: false,
    selectedTier: "onetime", payMethod: "upi", compatResult: null,
    giftInProgress: null, lastGiftCode: null, giftTier: "bundle",
    chats: {}, activeChatId: null,
  });
  resetPalmUI();
  $("#compat-name").value = ""; $("#compat-dob").value = ""; $("#compat-tob").value = "";
  $("#btn-compat-generate").disabled = true;
}

function initDashNav() {
  $("#btn-dash-logout").addEventListener("click", async () => {
    const dbInstance = backendDb();
    if (dbInstance) await backendCall(dbInstance.signOut(), "signOut");
    resetLocalSessionState();
    toast(dbInstance ? "Signed out." : "Signed out — this is a demo session, no data was stored.");
    showScreen("screen-landing");
  });
};

// ================= HOROSCOPE =================
function renderHoroscope() {
  const c = state.computed;
  const h = generateWeeklyHoroscope(c.sunIdx, c.moonIdx, c.ascIdx, new Date(), c.moonPhase.name);
  $("#horo-headline").textContent = h.headline;
  $("#horo-p0").textContent = h.paragraphs[0];
  $("#horo-p1").textContent = h.paragraphs[1];
  $("#horo-p2").textContent = h.paragraphs[2];
  $("#horo-p3").textContent = h.paragraphs[3];
  $("#horo-lock-wrap").classList.toggle("locked-wrap", true);
  $all("#horo-lock-wrap .locked-content").forEach(el => el.classList.toggle("locked-content", !state.unlocked));
  $("#horo-lock-wrap .lock-overlay").style.display = state.unlocked ? "none" : "flex";
  state._lastHoroscope = h;
}

// ================= PALM READING =================
function renderPalmScreen() {
  $("#palm-intro").style.display = state.palmReport ? "none" : "block";
  $("#palm-result").style.display = state.palmReport ? "block" : "none";
  if (state.palmReport) { renderPalmResult(); return; }

  const box = $("#palm-questions");
  if (!box.dataset.built) {
    box.innerHTML = PALM_QUESTIONS.map(q => `
      <div class="card">
        <p style="margin:0 0 10px;font-weight:600;color:var(--text)">${q.label}<span class="cv-tag" id="cv-tag-${q.id}" style="display:none"></span></p>
        <div class="option-grid" data-qid="${q.id}">
          ${q.options.map(o => `<button type="button" class="option-btn" data-v="${o.v}">${o.t}</button>`).join("")}
        </div>
      </div>
    `).join("");
    box.dataset.built = "1";
    box.addEventListener("click", (e) => {
      const btn = e.target.closest(".option-btn");
      if (!btn) return;
      const group = btn.closest(".option-grid");
      Array.from(group.children).forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.palmAnswers[group.dataset.qid] = btn.dataset.v;
      // Manually overriding a scanned answer means the user is correcting the scan —
      // drop its "Scanned" tag so the UI doesn't keep claiming a match it no longer is.
      const tag = $("#cv-tag-" + group.dataset.qid);
      if (tag) tag.style.display = "none";
      const allAnswered = PALM_QUESTIONS.every(q => state.palmAnswers[q.id]);
      $("#btn-palm-generate").disabled = !allAnswered;
    });
  }
}

// ---- Offline photo scan (crop-align + pixel-math CV, see cv-engine.js) ----
let cropRect = null; // {x,y,w,h} in CSS px relative to #palm-crop-wrap
let cropDrag = null;

function setupCropUI() {
  const wrap = $("#palm-crop-wrap");
  const img = $("#palm-preview");
  const w = wrap.clientWidth, h = img.clientHeight;
  if (!w || !h) return; // not laid out yet (shouldn't happen post-onload, but don't crash)
  cropRect = { x: w * 0.12, y: h * 0.08, w: Math.max(40, w * 0.76), h: Math.max(40, h * 0.84) };
  positionCropRect();
}

function positionCropRect() {
  const el = $("#palm-crop-rect");
  el.style.display = "block";
  el.style.left = cropRect.x + "px";
  el.style.top = cropRect.y + "px";
  el.style.width = cropRect.w + "px";
  el.style.height = cropRect.h + "px";
}

function initCropDrag() {
  const wrap = $("#palm-crop-wrap");
  const rectEl = $("#palm-crop-rect");
  const MIN = 40;

  function pointOf(e) {
    const b = wrap.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  function onMove(e) {
    if (!cropDrag) return;
    const p = pointOf(e);
    const dx = p.x - cropDrag.startPX, dy = p.y - cropDrag.startPY;
    const s = cropDrag.start;
    const maxW = wrap.clientWidth, maxH = $("#palm-preview").clientHeight;
    if (cropDrag.mode === "move") {
      cropRect = {
        x: Math.max(0, Math.min(s.x + dx, maxW - s.w)),
        y: Math.max(0, Math.min(s.y + dy, maxH - s.h)),
        w: s.w, h: s.h,
      };
    } else {
      let x = s.x, y = s.y, w = s.w, h = s.h;
      if (cropDrag.mode.includes("l")) { const nx = Math.min(s.x + dx, s.x + s.w - MIN); w = s.x + s.w - nx; x = nx; }
      if (cropDrag.mode.includes("r")) { w = Math.max(MIN, s.w + dx); }
      if (cropDrag.mode.includes("t")) { const ny = Math.min(s.y + dy, s.y + s.h - MIN); h = s.y + s.h - ny; y = ny; }
      if (cropDrag.mode.includes("b")) { h = Math.max(MIN, s.h + dy); }
      x = Math.max(0, x); y = Math.max(0, y);
      w = Math.min(w, maxW - x); h = Math.min(h, maxH - y);
      cropRect = { x, y, w, h };
    }
    positionCropRect();
  }

  function onUp() {
    cropDrag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  function onDown(e, mode) {
    if (!cropRect) return;
    e.preventDefault(); e.stopPropagation();
    const p = pointOf(e);
    cropDrag = { mode, startPX: p.x, startPY: p.y, start: { ...cropRect } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  rectEl.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("crop-handle")) return;
    onDown(e, "move");
  });
  $all(".crop-handle").forEach(h => h.addEventListener("pointerdown", (e) => onDown(e, h.dataset.h)));
}

// Draws small labels ("Index", "Middle", ...) directly on the uploaded photo
// at each finger column detectFingerColumns() found, mapped from the CV
// engine's crop-pixel coordinate space back to on-screen wrap coordinates
// using the same scale/offset math runPalmAnalysis uses to build that crop in
// the first place. This is what lets the "mount" question — the one thing the
// pixel-math engine can't safely auto-answer (see cv-engine.js) — be a quick
// look-and-tap instead of something the user has to know palmistry terms for.
const FINGER_LABEL_TEXT = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky" };
function renderFingerLabels(fingerColumns, mapPt) {
  const box = $("#palm-finger-labels");
  box.innerHTML = "";
  if (!fingerColumns || !fingerColumns.columns || !fingerColumns.columns.length) return;
  for (const col of fingerColumns.columns) {
    const cx = (col.x0 + col.x1) / 2;
    const p = mapPt(cx, 0.1);
    const el = document.createElement("span");
    el.className = "finger-label";
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
    el.textContent = FINGER_LABEL_TEXT[col.name] || col.name;
    box.appendChild(el);
  }
  // The thumb isn't one of the four detected columns (it sits outside the
  // finger-valley scan band) — approximate its mount position near the
  // frame's left edge, per the app's thumb-left photo convention.
  const thumbPt = mapPt(0, 0.42);
  const thumbEl = document.createElement("span");
  thumbEl.className = "finger-label thumb";
  thumbEl.style.left = thumbPt.x + "px";
  thumbEl.style.top = thumbPt.y + "px";
  thumbEl.textContent = "Thumb";
  box.appendChild(thumbEl);
}

function applyPalmSuggestions(result) {
  ANALYZABLE_QUESTIONS.forEach((qid) => {
    const val = result.suggestions[qid];
    const conf = result.confidence[qid];
    if (val === undefined) return;
    state.palmAnswers[qid] = val;
    const group = document.querySelector(`.option-grid[data-qid="${qid}"]`);
    if (group) Array.from(group.children).forEach(b => b.classList.toggle("selected", b.dataset.v === val));
    const tag = $("#cv-tag-" + qid);
    if (tag) {
      const pct = Math.round(Math.max(0, Math.min(1, conf)) * 100);
      tag.style.display = "inline-block";
      tag.textContent = "Scanned " + pct + "%";
      tag.classList.toggle("low", conf < 0.55);
    }
  });
  const allAnswered = PALM_QUESTIONS.every(q => state.palmAnswers[q.id]);
  $("#btn-palm-generate").disabled = !allAnswered;
}

function runPalmAnalysis() {
  const img = $("#palm-preview");
  const wrap = $("#palm-crop-wrap");
  const statusEl = $("#palm-cv-status");
  statusEl.style.display = "block";
  if (!img.naturalWidth || !cropRect) { statusEl.textContent = "Upload a photo first."; return; }
  statusEl.textContent = "Scanning the framed area…";

  // Map the on-screen crop rectangle (CSS px within the wrap) to natural image
  // pixels. The preview uses object-fit:contain, so the rendered image can be
  // letterboxed inside the wrap — account for that offset before scaling.
  const boxW = wrap.clientWidth, boxH = img.clientHeight;
  const natW = img.naturalWidth, natH = img.naturalHeight;
  const scale = Math.min(boxW / natW, boxH / natH) || 1;
  const dispW = natW * scale, dispH = natH * scale;
  const offX = (boxW - dispW) / 2, offY = (boxH - dispH) / 2;

  const rx = Math.max(0, cropRect.x - offX);
  const ry = Math.max(0, cropRect.y - offY);
  const rw = Math.max(0, Math.min(cropRect.w, dispW - rx));
  const rh = Math.max(0, Math.min(cropRect.h, dispH - ry));

  const sx = Math.round(rx / scale), sy = Math.round(ry / scale);
  const sw = Math.round(rw / scale), sh = Math.round(rh / scale);

  $("#palm-quality-warning").style.display = "none";

  if (sw < 20 || sh < 20) {
    statusEl.textContent = "That frame is too small to scan — drag the corner handles to make it bigger, over your palm.";
    return;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const imageData = ctx.getImageData(0, 0, sw, sh);
    const result = analyzePalmRegion({ data: imageData.data, width: sw, height: sh });
    applyPalmSuggestions(result);
    // Map a point in crop-pixel space (cvX in [0,sw), cvYFrac as a 0..1 fraction
    // of sh) back to CSS px within #palm-crop-wrap, for positioning the finger labels.
    const mapPt = (cvX, cvYFrac) => ({
      x: offX + (sx + cvX) * scale,
      y: offY + (sy + cvYFrac * sh) * scale,
    });
    renderFingerLabels(result.fingerColumns, mapPt);
    if (result.quality && result.quality.lowQuality) {
      // Don't just report a low score and stop — tell the user what to do
      // about it (upload a clearer photo) and how to get a better one, since
      // "the scan found nothing" on its own isn't an actionable message.
      statusEl.textContent = "Scan finished, but the suggestions below are low-confidence guesses (see tip below). You can still answer manually, or try a clearer photo.";
      $("#palm-quality-warning").style.display = "block";
    } else {
      statusEl.textContent = "Scan complete — suggestions filled in below (marked \"Scanned\"). Tap any answer to correct it.";
    }
  } catch (err) {
    statusEl.textContent = "Couldn't scan that photo — please answer the questions below by hand instead.";
  }
}

function initPalmUpload() {
  $("#palm-upload-box").addEventListener("click", () => $("#palm-file-input").click());
  $("#palm-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = $("#palm-preview");
      img.onload = () => setupCropUI();
      img.src = ev.target.result;
      $("#palm-upload-box").style.display = "none";
      $("#palm-crop-wrap").style.display = "block";
      $("#palm-crop-hint").style.display = "block";
      $("#btn-palm-analyze").style.display = "block";
      $("#btn-palm-change-photo").style.display = "block";
      $("#palm-cv-status").style.display = "none";
      $("#palm-cv-status").textContent = "";
      $("#palm-quality-warning").style.display = "none";
    };
    reader.readAsDataURL(file);
  });
  initCropDrag();
  $("#btn-palm-analyze").addEventListener("click", runPalmAnalysis);
  $("#btn-palm-change-photo").addEventListener("click", () => {
    $("#palm-upload-box").style.display = "block";
    $("#palm-crop-wrap").style.display = "none";
    $("#palm-crop-hint").style.display = "none";
    $("#btn-palm-analyze").style.display = "none";
    $("#btn-palm-change-photo").style.display = "none";
    $("#palm-cv-status").style.display = "none";
    $("#palm-quality-warning").style.display = "none";
    $("#palm-file-input").value = "";
    cropRect = null;
  });
  $("#btn-palm-generate").addEventListener("click", async () => {
    state.palmReport = generatePalmReport(state.palmAnswers);
    renderPalmScreen();
    const dbInstance = backendDb();
    if (dbInstance) {
      const { error } = await backendCall(dbInstance.savePalmReport(state.palmAnswers, state.palmReport), "savePalmReport");
      if (error) toast("Palm reading saved for now, but couldn't sync — it may not be there next time you log in.");
    }
  });
}

function renderPalmResult() {
  const lines = state.palmReport.lines;
  $("#palm-line-0").textContent = lines[0];
  $("#palm-locked-lines").innerHTML = lines.slice(1).map(l => `<div class="card"><p style="margin:0">${l}</p></div>`).join("");
  const lockWrap = $("#palm-result .locked-wrap");
  $all("#palm-result .locked-content").forEach(el => el.classList.toggle("locked-content", !state.unlocked));
  lockWrap.querySelector(".lock-overlay").style.display = state.unlocked ? "none" : "flex";
}

// ================= LOVE ENERGY =================
function renderLoveEnergy() {
  const c = state.computed;
  const res = generateLoveEnergy(c.sunIdx, new Date(), c.moonPhase.angle);
  $("#love-score").textContent = res.score;
  $("#love-bucket").textContent = res.bucket;
  $("#love-blurb").textContent = res.blurb;
  $("#love-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const circumference = 2 * Math.PI * 72;
  const offset = circumference * (1 - res.score / 100);
  const arc = $("#love-meter-arc");
  arc.style.transition = "none";
  arc.setAttribute("stroke-dashoffset", circumference);
  requestAnimationFrame(() => {
    arc.style.transition = "stroke-dashoffset 1s ease";
    arc.setAttribute("stroke-dashoffset", offset);
  });
}

// ================= COMPATIBILITY / SYNASTRY =================
function getUserAge() {
  if (!state.birth.year) return null;
  const today = new Date();
  return today.getFullYear() - state.birth.year - ((today.getMonth() + 1 < state.birth.month || (today.getMonth() + 1 === state.birth.month && today.getDate() < state.birth.day)) ? 1 : 0);
}

function renderCompatScreen() {
  $("#compat-form").style.display = state.compatResult ? "none" : "block";
  $("#compat-result").style.display = state.compatResult ? "block" : "none";
  if (state.compatResult) renderCompatResult();
}

function initCompat() {
  function checkFormValid() {
    const valid = $("#compat-name").value.trim() && $("#compat-dob").value;
    $("#btn-compat-generate").disabled = !valid;
  }
  $("#compat-name").addEventListener("input", checkFormValid);
  $("#compat-dob").addEventListener("input", checkFormValid);
  const todayStr = new Date().toISOString().slice(0, 10);
  $("#compat-dob").setAttribute("max", todayStr);
  $("#compat-dob").setAttribute("min", "1900-01-01");

  $("#btn-compat-generate").addEventListener("click", () => {
    const name = $("#compat-name").value.trim();
    const dobStr = $("#compat-dob").value;
    if (!name || !dobStr) return toast("Enter their name and date of birth");
    const [y, m, d] = dobStr.split("-").map(Number);
    const chosen = new Date(Date.UTC(y, m - 1, d));
    const todayUTC = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
    if (chosen > todayUTC) return toast("That date of birth is in the future");
    const tobStr = $("#compat-tob").value;
    let hour = 12, minute = 0;
    if (tobStr) { const [h, mi] = tobStr.split(":").map(Number); hour = h; minute = mi; }
    const utcOffset = state.birth.city ? state.birth.city.utc : 5.5;
    const utc = toUtcDate({ year: y, month: m, day: d, hour, minute }, utcOffset);
    const partnerSun = getSunSign(utc);
    const partnerMoon = getMoonSign(utc);
    const c = state.computed;
    state.compatResult = {
      name,
      sunIdx: partnerSun,
      moonIdx: partnerMoon,
      synastry: generateSynastry(state.user ? state.user.name.split(" ")[0] : "You", c.sunIdx, c.moonIdx, name, partnerSun, partnerMoon),
    };
    renderCompatScreen();
  });

  $("#btn-compat-reset").addEventListener("click", () => {
    state.compatResult = null;
    $("#compat-name").value = ""; $("#compat-dob").value = ""; $("#compat-tob").value = "";
    $("#btn-compat-generate").disabled = true;
    renderCompatScreen();
  });
}

function renderCompatResult() {
  const r = state.compatResult;
  const you = state.user ? state.user.name.split(" ")[0] : "You";
  $("#compat-headline").textContent = `${you} & ${r.name}`;
  $("#compat-score").textContent = r.synastry.score + "%";
  $("#compat-verdict").textContent = r.synastry.verdict;
  $("#compat-p0").textContent = r.synastry.paragraphs[0];
  $("#compat-locked-lines").innerHTML = r.synastry.paragraphs.slice(1).map(p => `<div class="card"><p style="margin:0">${p}</p></div>`).join("");
  const wrap = $("#compat-result .locked-wrap");
  $all("#compat-result .locked-content").forEach(el => el.classList.toggle("locked-content", !state.unlocked));
  wrap.querySelector(".lock-overlay").style.display = state.unlocked ? "none" : "flex";
}

// ================= YEAR AHEAD =================
function renderYearAheadScreen() {
  const c = state.computed;
  const now = new Date();
  const jupSign = getTransitingSign(Astronomy.Body.Jupiter, now);
  const satSign = getTransitingSign(Astronomy.Body.Saturn, now);
  const ya = generateYearAhead(c.sunIdx, jupSign, satSign, getUserAge());
  state._lastYearAhead = ya;
  $("#ya-jupiter-sign").textContent = signName(jupSign);
  $("#ya-saturn-sign").textContent = signName(satSign);
  $("#ya-p0").textContent = ya.paragraphs[0];
  $("#ya-locked-lines").innerHTML = ya.paragraphs.slice(1).map(p => `<div class="card"><p style="margin:0">${p}</p></div>`).join("");
  const wrap = $("#screen-yearahead .locked-wrap");
  $all("#screen-yearahead .locked-content").forEach(el => el.classList.toggle("locked-content", !state.unlocked));
  wrap.querySelector(".lock-overlay").style.display = state.unlocked ? "none" : "flex";
}

// ================= NOTIFICATIONS =================
function initNotifications() {
  const supported = typeof Notification !== "undefined";
  function refreshStatus() {
    const statusEl = $("#notif-status-text");
    const enableBtn = $("#btn-notif-enable");
    const testBtn = $("#btn-notif-test");
    if (!supported) {
      statusEl.textContent = tr("notif.status.unsupported");
      enableBtn.disabled = true; testBtn.disabled = true;
      return;
    }
    const perm = Notification.permission;
    if (perm === "granted") {
      statusEl.textContent = tr("notif.status.granted");
      enableBtn.style.display = "none"; testBtn.disabled = false;
    } else if (perm === "denied") {
      statusEl.textContent = tr("notif.status.denied");
      enableBtn.disabled = true; testBtn.disabled = true;
    } else {
      statusEl.textContent = tr("notif.status.default");
      enableBtn.style.display = "inline-flex"; enableBtn.disabled = false; testBtn.disabled = true;
    }
  }

  $("#btn-open-notif").addEventListener("click", () => { $("#sheet-notif-backdrop").classList.add("visible"); refreshStatus(); });
  $("#btn-close-notif").addEventListener("click", () => $("#sheet-notif-backdrop").classList.remove("visible"));
  $("#sheet-notif-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-notif-backdrop") $("#sheet-notif-backdrop").classList.remove("visible"); });

  $("#btn-notif-enable").addEventListener("click", async () => {
    if (!supported) return;
    try {
      const perm = await Notification.requestPermission();
      refreshStatus();
      if (perm === "granted") toast("Notifications enabled ✨");
      else if (perm === "denied") toast("Notifications were blocked");
    } catch (e) {
      $("#notif-status-text").textContent = tr("notif.status.enable-failed");
    }
  });

  $("#btn-notif-test").addEventListener("click", () => {
    if (!supported || Notification.permission !== "granted") return;
    try {
      const c = state.computed;
      let body = "Open Nakshatra for your reading today.";
      if (c.sunIdx != null) {
        const love = generateLoveEnergy(c.sunIdx, new Date(), c.moonPhase.angle);
        body = `${SIGNS[c.sunIdx]} energy today: ${love.score}/100 (${love.bucket}). ${love.blurb}`;
      }
      new Notification("🌙 Your Daily Guidance — Nakshatra", { body });
      toast("Notification sent — check your browser/system notifications.");
    } catch (e) {
      toast("Couldn't send a notification in this environment.");
    }
  });
}

// ================= PAYWALL / TIERS =================
function initTierSelection() {
  $("#tier-list").addEventListener("click", (e) => {
    const card = e.target.closest(".tier-card");
    if (!card) return;
    $all(".tier-card").forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
    state.selectedTier = card.dataset.tier;
  });
  $("#btn-report-checkout").addEventListener("click", () => {
    if (state.unlocked) { showScreen("screen-fullreport"); return; }
    state.giftInProgress = null; // this is a self-purchase entry point, not the gift flow
    showScreen("screen-checkout");
  });
}
function renderTierSelection() {
  $all(".tier-card").forEach(c => c.classList.toggle("selected", c.dataset.tier === state.selectedTier));
  const btn = $("#btn-report-checkout");
  const tierPicker = $("#tier-list");
  if (state.unlocked) {
    btn.textContent = tr("report.already-unlocked");
    tierPicker.style.display = "none";
  } else {
    btn.textContent = tr("report.btn.continue");
    tierPicker.style.display = "";
  }
}

// ================= CHECKOUT =================
function renderCheckout() {
  const gifting = !!state.giftInProgress;
  const tierKey = gifting ? state.giftInProgress.tier : state.selectedTier;
  const tier = TIER_INFO[tierKey];
  $("#checkout-tier-name").textContent = tierDisplayName(tierKey);
  $("#checkout-tier-price").textContent = tier.label;
  $("#btn-pay-amount").textContent = tier.label.split("/")[0];
  $("#checkout-summary-label").textContent = gifting ? tr("checkout.summary.gift", { name: state.giftInProgress.recipientName }) : tr("checkout.summary.order");
  $("#btn-checkout-back").setAttribute("data-back", gifting ? "screen-gift-send" : "screen-report");
}

function initCheckout() {
  $all(".paytab[data-pay]").forEach(tab => tab.addEventListener("click", () => {
    $all(".paytab[data-pay]").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    state.payMethod = tab.dataset.pay;
    ["upi", "card", "netbanking"].forEach(m => $("#pay-" + m).style.display = m === state.payMethod ? "block" : "none");
  }));

  $("#input-card").addEventListener("input", (e) => {
    let v = e.target.value.replace(/\D/g, "").slice(0, 16);
    e.target.value = v.replace(/(.{4})/g, "$1 ").trim();
  });
  $("#input-expiry").addEventListener("input", (e) => {
    let v = e.target.value.replace(/\D/g, "").slice(0, 4);
    if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2);
    e.target.value = v;
  });
  $("#input-cvv").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3); });

  $("#btn-pay-submit").addEventListener("click", () => {
    if (state.payMethod === "upi" && !$("#input-upi").value.includes("@")) return toast("Enter a valid UPI ID (e.g. name@upi)");
    if (state.payMethod === "card" && $("#input-card").value.replace(/\s/g, "").length < 12) return toast("Enter a valid card number");
    showScreen("screen-processing", { silent: true });
    setTimeout(async () => {
      const dbInstance = backendDb();
      if (state.giftInProgress) {
        const g = state.giftInProgress;
        const code = generateGiftCode();
        const giftRow = {
          code, tier: g.tier, recipientName: g.recipientName, message: g.message,
          senderName: (state.user && state.user.name) || "A friend", redeemed: false, redeemedBy: null,
        };
        if (dbInstance) {
          const { error } = await backendCall(dbInstance.sendGift(code, g.tier, g.recipientName, g.message), "sendGift");
          if (error) {
            toast("Couldn't create the gift code — please try again.");
            showScreen("screen-gift-send", { silent: true });
            return;
          }
        }
        state.giftCodes[code] = giftRow;
        state.lastGiftCode = code;
        state.giftInProgress = null;
        showScreen("screen-gift-sent", { silent: true });
      } else {
        if (dbInstance) {
          const amountPaise = TIER_INFO[state.selectedTier].price * 100;
          const { error } = await backendCall(dbInstance.recordTestPurchase(state.selectedTier, amountPaise, state.payMethod), "recordTestPurchase");
          if (error) {
            toast("Payment could not be recorded — please try again.");
            showScreen("screen-checkout", { silent: true });
            return;
          }
        }
        state.unlocked = true;
        $("#success-sub").textContent = tr("success.sub-template", { tier: tierDisplayName(state.selectedTier) });
        showScreen("screen-success", { silent: true });
      }
    }, 1700);
  });

  $("#btn-success-continue").addEventListener("click", () => showScreen("screen-fullreport"));
}

// ================= GIFTING =================
function generateGiftCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  function group() { let s = ""; for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }
  let code;
  do { code = "NKSH-" + group() + "-" + group(); } while (state.giftCodes[code]);
  return code;
}

function renderGiftSend() {
  $all("#gift-tier-list .tier-card").forEach(c => c.classList.toggle("selected", c.dataset.tier === state.giftTier));
  $("#btn-gift-continue").disabled = !$("#gift-recipient-name").value.trim();
}

function renderGiftSent() {
  const code = state.lastGiftCode;
  const g = state.giftCodes[code];
  if (!g) return;
  $("#gift-code-display").textContent = code;
  $("#gift-sent-sub").textContent = tr("gift.sent.sub", { name: g.recipientName });
}

function drawGiftCard() {
  const canvas = $("#giftCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const code = state.lastGiftCode;
  const g = state.giftCodes[code];
  if (!g) return;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1b1032"); grad.addColorStop(0.55, "#2c1a4d"); grad.addColorStop(1, "#100a24");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * W, y = Math.random() * H, r = Math.random() * 2.2;
    ctx.globalAlpha = Math.random() * 0.8 + 0.15;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = "center";
  ctx.fillStyle = "#e8c687";
  ctx.font = "600 30px Poppins, sans-serif";
  ctx.fillText("✦ NAKSHATRA ✦", W / 2, 140);

  ctx.fillStyle = "#f3eefb";
  ctx.font = "600 56px 'Cinzel', serif";
  ctx.fillText("A Gift Reading", W / 2, 250);
  ctx.font = "600 40px 'Cinzel', serif";
  ctx.fillText("for " + g.recipientName, W / 2, 320);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, 90, 420, W - 180, 260, 28); ctx.fill();
  ctx.strokeStyle = "rgba(232,198,135,0.25)"; ctx.lineWidth = 2;
  roundRect(ctx, 90, 420, W - 180, 260, 28); ctx.stroke();
  ctx.fillStyle = "#e8c687"; ctx.font = "600 26px Poppins, sans-serif"; ctx.textAlign = "left";
  ctx.fillText("A MESSAGE FROM " + (g.senderName || "A FRIEND").toUpperCase(), 130, 480);
  ctx.fillStyle = "#f3eefb"; ctx.font = "30px Poppins, sans-serif";
  wrapText(ctx, g.message || "Wishing you clarity and good energy. Enjoy your reading!", 130, 540, W - 260, 42);

  ctx.textAlign = "center";
  ctx.fillStyle = "#9b7ec0"; ctx.font = "600 26px Poppins, sans-serif";
  ctx.fillText(TIER_INFO[g.tier].name.toUpperCase() + " · GIFT CODE", W / 2, 830);
  ctx.fillStyle = "#e8c687"; ctx.font = "700 56px 'Cinzel', serif";
  ctx.fillText(code, W / 2, 900);

  ctx.fillStyle = "#8478a0"; ctx.font = "24px Poppins, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Entertainment purposes only · Redeem at nakshatra.app", W / 2, 1280);
}

function initGiftSend() {
  $("#gift-tier-list").addEventListener("click", (e) => {
    const card = e.target.closest(".tier-card");
    if (!card) return;
    $all("#gift-tier-list .tier-card").forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
    state.giftTier = card.dataset.tier;
  });
  $("#gift-recipient-name").addEventListener("input", () => {
    $("#btn-gift-continue").disabled = !$("#gift-recipient-name").value.trim();
  });
  $("#btn-gift-continue").addEventListener("click", () => {
    const name = $("#gift-recipient-name").value.trim();
    if (!name) return toast("Enter who this gift is for");
    state.giftInProgress = { recipientName: name, message: $("#gift-message").value.trim(), tier: state.giftTier };
    showScreen("screen-checkout");
  });
  $("#btn-gift-done").addEventListener("click", () => {
    state.lastGiftCode = null;
    $("#gift-recipient-name").value = ""; $("#gift-message").value = "";
    showScreen("screen-dashboard");
  });
  $("#btn-gift-copy-code").addEventListener("click", () => {
    const code = state.lastGiftCode || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => toast("Code copied!")).catch(() => toast("Copy this code: " + code));
    } else {
      toast("Copy this code: " + code);
    }
  });
  $("#btn-gift-download-card").addEventListener("click", () => {
    drawGiftCard();
    const canvas = $("#giftCanvas");
    const link = document.createElement("a");
    link.download = "nakshatra-gift-card.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast("Gift card downloaded 🎁");
  });
}

function initGiftRedeem() {
  function openRedeem() { $("#input-gift-code").value = ""; $("#sheet-redeem-backdrop").classList.add("visible"); }
  function closeRedeem() { $("#sheet-redeem-backdrop").classList.remove("visible"); }
  $("#open-redeem-sheet").addEventListener("click", openRedeem);
  $("#btn-close-redeem").addEventListener("click", closeRedeem);
  $("#sheet-redeem-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-redeem-backdrop") closeRedeem(); });
  $("#btn-redeem-submit").addEventListener("click", async () => {
    const raw = $("#input-gift-code").value.trim().toUpperCase();
    if (!raw) return toast("Enter a gift code");
    if (state.unlocked) { closeRedeem(); toast("You've already unlocked your full report."); showScreen("screen-fullreport"); return; }

    const dbInstance = backendDb();
    if (!dbInstance) {
      // No backend configured — old same-browser-tab-only behavior.
      const g = state.giftCodes[raw];
      if (!g) return toast("That code wasn't found in this session — gift codes only work within the same demo browser tab in this prototype.");
      if (g.redeemed) return toast("This code has already been redeemed.");
      g.redeemed = true;
      g.redeemedBy = (state.user && state.user.name) || "you";
      state.unlocked = true;
      closeRedeem();
      toast(`🎁 Unlocked! Gifted by ${g.senderName}.`);
      showScreen("screen-fullreport");
      return;
    }

    const submitBtn = $("#btn-redeem-submit");
    submitBtn.disabled = true;
    try {
      const { data, error } = await dbInstance.redeemGiftCode(raw);
      if (error) {
        const msg = error.message || "";
        toast(
          /NOT_FOUND/.test(msg) ? "That gift code wasn't found."
          : /ALREADY_REDEEMED/.test(msg) ? "This code has already been redeemed."
          : /SELF_REDEEM/.test(msg) ? "You can't redeem a code you sent yourself."
          : "Couldn't redeem that code — please try again."
        );
        return;
      }
      state.unlocked = true;
      closeRedeem();
      toast(data && data.tier ? `🎁 Unlocked your ${tierDisplayName(data.tier)}!` : "🎁 Unlocked!");
      showScreen("screen-fullreport");
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ================= ASTROLOGER CHAT (Phase 4, demo) =================
// Every reply here comes from generateAstrologerReply() in rules.js — a fixed
// template bank keyed by topic/sign/turn, not a real person and not a generative
// AI model. The picker and chat screens both keep an on-screen disclaimer visible
// at all times so this is never mistaken for either of those.
function renderChatPicker() {
  const box = $("#chat-astrologer-list");
  box.innerHTML = ASTROLOGERS.map(a => `
    <div class="card astro-card" data-astro="${a.id}" style="cursor:pointer">
      <div class="zodiac-badge">${a.avatar}</div>
      <div style="flex:1">
        <strong>${a.name}</strong>
        <div class="muted" style="margin-top:2px">${a.specialtyLabel}</div>
        <div class="muted" style="font-size:0.78rem;margin-top:2px">${a.tagline}</div>
      </div>
      <span>›</span>
    </div>
  `).join("");
}

async function openChat(astrologerId) {
  state.activeChatId = astrologerId;
  const isNew = !state.chats[astrologerId];
  if (isNew) state.chats[astrologerId] = { messages: [], pending: false };
  showScreen("screen-chat"); // show right away; backfill history below if this is a fresh conversation

  if (!isNew) return; // already have this conversation cached locally — nothing more to load

  const dbInstance = backendDb();
  if (dbInstance) {
    const { data } = await backendCall(dbInstance.loadChatMessages(astrologerId), "loadChatMessages");
    if (data && data.length) {
      state.chats[astrologerId].messages = data.map(m => ({ from: m.sender, text: m.text }));
    }
  }

  if (!state.chats[astrologerId].messages.length) {
    const sun = SIGN_INFO[state.computed.sunIdx] || SIGN_INFO[0];
    const greetFn = CHAT_GREETINGS[astrologerId] || CHAT_GREETINGS[ASTROLOGERS[0].id];
    const greeting = greetFn(sun);
    state.chats[astrologerId].messages = [{ from: "astro", text: greeting }];
    if (dbInstance) backendCall(dbInstance.sendChatMessage(astrologerId, "astro", greeting), "sendChatMessage(greeting)");
  }

  // The screen already rendered once above with an empty list — re-render now
  // that history (or the greeting) has actually arrived, but only if the user
  // is still looking at this exact conversation.
  if (state.activeChatId === astrologerId && document.getElementById("screen-chat").classList.contains("active")) {
    renderChatMessages();
  }
}

function renderChatScreen() {
  const astro = ASTROLOGERS.find(a => a.id === state.activeChatId) || ASTROLOGERS[0];
  $("#chat-astrologer-avatar").textContent = astro.avatar;
  $("#chat-astrologer-name").textContent = astro.name;
  $("#chat-astrologer-specialty").textContent = astro.specialtyLabel;
  renderChatMessages();
  const chat = state.chats[astro.id];
  const pending = !!(chat && chat.pending);
  setChatInputEnabled(!pending);
  // If a reply is still pending for this conversation (e.g. the user navigated away
  // and came back before the simulated typing delay finished), restore the typing
  // indicator — renderChatMessages() just wiped it since it's not part of chat.messages.
  if (pending) showTypingIndicator();
}

function renderChatMessages() {
  const chat = state.chats[state.activeChatId];
  const box = $("#chat-messages");
  if (!chat) { box.innerHTML = ""; return; }
  box.innerHTML = chat.messages.map(m =>
    `<div class="chat-bubble ${m.from === "user" ? "user" : "astro"}">${escapeHtml(m.text)}</div>`
  ).join("");
  box.scrollTop = box.scrollHeight;
}

function setChatInputEnabled(enabled) {
  $("#chat-input").disabled = !enabled;
  $("#btn-chat-send").disabled = !enabled;
}

function showTypingIndicator() {
  const box = $("#chat-messages");
  if (box.querySelector(".chat-bubble.typing")) return;
  const typingEl = document.createElement("div");
  typingEl.className = "chat-bubble astro typing";
  typingEl.innerHTML = "<span></span><span></span><span></span>";
  box.appendChild(typingEl);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sendChatMessage() {
  const input = $("#chat-input");
  // A reply is already pending for this conversation (input is disabled while
  // waiting) — ignore Enter/Send instead of firing a second overlapping reply.
  if (input.disabled) return;
  const text = input.value.trim();
  if (!text) return;
  const astro = ASTROLOGERS.find(a => a.id === state.activeChatId) || ASTROLOGERS[0];
  const chat = state.chats[state.activeChatId];
  chat.messages.push({ from: "user", text });
  chat.pending = true;
  input.value = "";
  renderChatMessages();
  showTypingIndicator();
  setChatInputEnabled(false);

  const dbInstance = backendDb();
  if (dbInstance) backendCall(dbInstance.sendChatMessage(astro.id, "user", text), "sendChatMessage(user)");

  const turnIndex = chat.messages.filter(m => m.from === "user").length;
  const c = state.computed;
  const sunIdx = c.sunIdx != null ? c.sunIdx : 0;
  const moonIdx = c.moonIdx != null ? c.moonIdx : 0;
  setTimeout(() => {
    // Only skip entirely if logout reset state.chats out from under us — the reply
    // still belongs to THIS astrologer's conversation and must be recorded even if
    // the user has since switched to a different astrologer's chat (or navigated
    // away) during the delay, so it's there when they come back. Only the re-render
    // (and re-enabling input) is conditional on that exact conversation being the
    // one currently on screen — dropping the reply itself here would lose it forever.
    if (!state.chats[astro.id]) return;
    const reply = generateAstrologerReply(astro.id, sunIdx, moonIdx, text, turnIndex);
    state.chats[astro.id].messages.push({ from: "astro", text: reply });
    state.chats[astro.id].pending = false;
    if (dbInstance) backendCall(dbInstance.sendChatMessage(astro.id, "astro", reply), "sendChatMessage(astro)");
    const chatScreenActive = document.getElementById("screen-chat").classList.contains("active");
    if (chatScreenActive && state.activeChatId === astro.id) {
      renderChatMessages();
      setChatInputEnabled(true);
    }
  }, 700);
}

function initChat() {
  $("#chat-astrologer-list").addEventListener("click", (e) => {
    const card = e.target.closest("[data-astro]");
    if (!card) return;
    openChat(card.dataset.astro);
  });
  $("#btn-chat-send").addEventListener("click", sendChatMessage);
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatMessage(); });
}

// ================= COMMUNITY FEED (Phase 4) =================
// Seed posts (COMMUNITY_SEED, in rules.js) are fixed, hand-written example
// content from fictional accounts, kept purely for flavor so the feed is
// never empty — they aren't real database rows (their ids all start with
// "seed-") so liking one only ever toggles locally, never hits the backend.
// Real posts (from state.communityFeed) come from the community_feed view
// in the database once a backend is configured — see refreshCommunityFeed().
function allCommunityPosts() {
  return state.communityFeed.concat(COMMUNITY_SEED);
}

function renderCommunityFeed() {
  const box = $("#community-feed-list");
  const posts = allCommunityPosts();
  box.innerHTML = posts.map(p => {
    const liked = !!state.communityLikes[p.id];
    const likeCount = p.likes + (liked ? 1 : 0);
    return `
    <div class="card community-post" data-post="${p.id}">
      <div class="post-head">
        <div class="zodiac-badge sm">${p.avatar}</div>
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          <div class="muted" style="font-size:0.76rem">${escapeHtml(signName(p.signIdx) || SIGN_INFO[p.signIdx].name)} · ${escapeHtml(p.timeAgo || "")}</div>
        </div>
      </div>
      ${p.image ? `<img src="${p.image}" style="width:100%;border-radius:var(--radius-sm);border:1px solid var(--border)">` : ""}
      <p class="post-caption">${escapeHtml(p.caption)}</p>
      <button type="button" class="post-like-btn${liked ? " liked" : ""}" data-like="${p.id}">
        <span class="heart">${liked ? "♥" : "♡"}</span> <span class="like-count">${likeCount}</span>
      </button>
    </div>`;
  }).join("");
}

// Renders whatever's already cached in state.communityFeed immediately (so
// the screen never sits blank), then — if a backend is configured — fetches
// the real, shared feed and re-renders with everyone's actual posts/likes.
async function refreshCommunityFeed() {
  renderCommunityFeed();
  const dbInstance = backendDb();
  if (!dbInstance) return;
  const { data } = await backendCall(dbInstance.loadCommunityFeed(), "loadCommunityFeed");
  if (!data) return;
  state.communityFeed = data.map(p => {
    if (p.liked_by_me) state.communityLikes[p.id] = true;
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      signIdx: p.sign_idx,
      caption: p.caption,
      image: p.image_url,
      // Subtract the viewer's own like so renderCommunityFeed()'s existing
      // "base count + (liked ? 1 : 0)" logic reconstructs the true total —
      // that logic gives instant optimistic UI on click without a round-trip.
      likes: p.like_count - (p.liked_by_me ? 1 : 0),
      timeAgo: timeAgoFrom(p.created_at),
    };
  });
  renderCommunityFeed();
}

function initCommunity() {
  $("#community-feed-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-like]");
    if (!btn) return;
    const id = btn.dataset.like;
    const wasLiked = !!state.communityLikes[id];
    state.communityLikes[id] = !wasLiked;
    renderCommunityFeed(); // optimistic — instant, no round-trip

    const dbInstance = backendDb();
    if (!dbInstance || id.startsWith("seed-") || id.startsWith("own-")) return; // seed posts / offline-mode posts: local-only

    const action = wasLiked ? dbInstance.unlikePost(id) : dbInstance.likePost(id);
    backendCall(action, wasLiked ? "unlikePost" : "likePost").then(({ error }) => {
      if (error) {
        state.communityLikes[id] = wasLiked; // revert the optimistic toggle
        renderCommunityFeed();
        toast("Couldn't save your like — please try again.");
      }
    });
  });
}

async function postToCommunity() {
  const c = state.computed;
  if (c.sunIdx == null) return toast("Calculate your chart first.");
  const canvas = $("#shareCanvas");
  const caption = state._lastHoroscope
    ? state._lastHoroscope.paragraphs[0]
    : tr("community.default-caption", { sign: signName(c.sunIdx) });
  const imageDataUrl = canvas.toDataURL("image/png");
  const name = (state.user && state.user.name) || "You";

  const dbInstance = backendDb();
  if (dbInstance) {
    const { data, error } = await backendCall(dbInstance.postToCommunity({
      name, avatar: "✦", sign_idx: c.sunIdx, caption, image_url: imageDataUrl,
    }), "postToCommunity");
    if (error) { toast("Couldn't post to the community feed — please try again."); return; }
    state.communityFeed.unshift({
      id: data.id, name: data.name, avatar: data.avatar, signIdx: data.sign_idx,
      caption: data.caption, image: data.image_url, likes: 0, timeAgo: tr("community.just-now"),
    });
    toast("Posted to the community feed 🌌");
  } else {
    state._postSeq++;
    state.communityFeed.unshift({
      id: "own-" + state._postSeq, name, avatar: "✦", signIdx: c.sunIdx, caption,
      image: imageDataUrl, likes: 1, timeAgo: tr("community.just-now"),
    });
    toast("Posted to the community feed (demo) 🌌");
  }
  showScreen("screen-community");
}

// ================= FULL REPORT =================
function computeFuturePartner() {
  const c = state.computed;
  const nameLen = (state.user && state.user.name || "you").length;
  const letterIdx = (c.sunIdx * 3 + c.moonIdx * 7 + (c.ascIdx || 0) * 5 + nameLen) % 26;
  const initial = String.fromCharCode(65 + letterIdx);
  const yearOffset = 2 + ((c.sunIdx + c.moonIdx) % 5);
  const marriageYear = new Date().getFullYear() + yearOffset;
  const ageDelta = ((c.ascIdx != null ? c.ascIdx : c.sunIdx) % 5) - 2;
  const userAge = getUserAge();
  const partnerAge = userAge ? Math.max(18, userAge + ageDelta) : Math.max(21, 25 + ageDelta);
  const compat = 60 + ((c.sunIdx * 7 + c.moonIdx * 11) % 35);
  const themes = ["Intellectual companionship", "Steady, grounded partnership", "Passionate, high-energy connection", "Gentle emotional depth", "Shared ambition and drive", "Playful, easygoing chemistry"];
  const theme = themes[(c.sunIdx + c.moonIdx) % themes.length];
  const sunInfo = SIGN_INFO[c.sunIdx];
  const outlook = `Based on your chart's rhythm, a meaningful connection is most likely to deepen around ${marriageYear} — a period your ${SIGNS[c.sunIdx]} Sun tends to move through changes ${sunInfo.element === "Water" || sunInfo.element === "Earth" ? "carefully and for keeps" : "quickly and with conviction"}. Someone who balances your ${sunInfo.growth.split(" ")[0]}-style edges is the likeliest long-term fit.`;
  return { initial, marriageYear, partnerAge, compat, theme, outlook };
}

function renderFullReport() {
  const c = state.computed;
  $("#fr-badge-sun").textContent = SIGN_SYMBOLS[c.sunIdx];
  $("#fr-sun").textContent = tr("dash.label.sun") + " · " + signName(c.sunIdx);
  $("#fr-badge-moon").textContent = SIGN_SYMBOLS[c.moonIdx];
  $("#fr-moon").textContent = tr("dash.label.moon") + " · " + signName(c.moonIdx);
  $("#fr-badge-asc").textContent = c.ascIdx != null ? SIGN_SYMBOLS[c.ascIdx] : "?";
  $("#fr-asc").textContent = tr("dash.label.asc") + " · " + (c.ascIdx != null ? signName(c.ascIdx) : tr("common.unknown"));
  $("#fr-name-line").textContent = state.user ? tr("fr.prepared-for", { name: state.user.name }) : "";

  const h = state._lastHoroscope || generateWeeklyHoroscope(c.sunIdx, c.moonIdx, c.ascIdx, new Date(), c.moonPhase.name);
  $("#fr-horoscope").innerHTML = `<p style="margin:0 0 8px;font-weight:600;color:var(--text)">${h.headline}</p>` + h.paragraphs.map(p => `<p style="margin:0 0 8px">${p}</p>`).join("");

  if (state.palmReport) {
    $("#fr-palm").innerHTML = state.palmReport.lines.map(l => `<p style="margin:0 0 8px">${l}</p>`).join("");
  } else {
    $("#fr-palm").innerHTML = `<p style="margin:0">${tr("fr.palm-recovery")}</p>`;
  }

  const love = generateLoveEnergy(c.sunIdx, new Date(), c.moonPhase.angle);
  $("#fr-love").innerHTML = `<div class="row between"><strong>${love.score}/100 · ${love.bucket}</strong><span class="muted">${new Date().toLocaleDateString()}</span></div><p style="margin:8px 0 0">${love.blurb}</p>`;

  const now = new Date();
  const jupSign = getTransitingSign(Astronomy.Body.Jupiter, now);
  const satSign = getTransitingSign(Astronomy.Body.Saturn, now);
  const ya = generateYearAhead(c.sunIdx, jupSign, satSign, getUserAge());
  $("#fr-yearahead").innerHTML = `<p style="margin:0 0 6px" class="muted">${tr("fr.yearahead-signs", { jup: signName(jupSign), sat: signName(satSign) })}</p>` + ya.paragraphs.map(p => `<p style="margin:0 0 8px">${p}</p>`).join("");

  if (state.compatResult) {
    const r = state.compatResult;
    const you = state.user ? state.user.name.split(" ")[0] : "You";
    $("#fr-compat").innerHTML = `<p style="margin:0 0 6px;font-weight:600;color:var(--text)">${you} &amp; ${r.name} · ${r.synastry.score}% compatibility</p>` + r.synastry.paragraphs.map(p => `<p style="margin:0 0 8px">${p}</p>`).join("");
  } else {
    $("#fr-compat").innerHTML = `<p style="margin:0">${tr("fr.compat-recovery")}</p>`;
  }

  const fp = computeFuturePartner();
  $("#fr-partner").innerHTML = `
    <div class="row wrap" style="gap:18px;justify-content:space-between">
      <div><div class="muted">${tr("fr.partner.initial")}</div><strong style="font-size:1.3rem">${fp.initial}.</strong></div>
      <div><div class="muted">${tr("fr.partner.year")}</div><strong style="font-size:1.3rem">${fp.marriageYear}</strong></div>
      <div><div class="muted">${tr("fr.partner.age")}</div><strong style="font-size:1.3rem">${fp.partnerAge}</strong></div>
      <div><div class="muted">${tr("fr.partner.compat")}</div><strong style="font-size:1.3rem">${fp.compat}%</strong></div>
    </div>
    <div class="divider"></div>
    <div class="muted">${tr("fr.partner.theme")}</div>
    <p style="margin:2px 0 10px;font-weight:600;color:var(--text)">${fp.theme}</p>
    <div class="muted">${tr("fr.partner.outlook")}</div>
    <p style="margin:2px 0 0">${fp.outlook}</p>
  `;
}

// ================= SHARE CARD =================
function drawShareCard() {
  const canvas = $("#shareCanvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const c = state.computed;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1b1032"); grad.addColorStop(0.55, "#2c1a4d"); grad.addColorStop(1, "#100a24");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * W, y = Math.random() * H, r = Math.random() * 2.4;
    ctx.globalAlpha = Math.random() * 0.8 + 0.15;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = "center";
  ctx.fillStyle = "#e8c687";
  ctx.font = "600 34px Poppins, sans-serif";
  ctx.fillText("✦ NAKSHATRA ✦", W / 2, 160);

  ctx.fillStyle = "#f3eefb";
  ctx.font = "600 64px 'Cinzel', serif";
  ctx.fillText(state.user ? state.user.name.split(" ")[0] + "'s" : "Your", W / 2, 280);
  ctx.fillText("Cosmic Snapshot", W / 2, 360);

  const badges = [
    { label: "SUN", val: c.sunIdx != null ? SIGNS[c.sunIdx] : "—", sym: c.sunIdx != null ? SIGN_SYMBOLS[c.sunIdx] : "" },
    { label: "MOON", val: c.moonIdx != null ? SIGNS[c.moonIdx] : "—", sym: c.moonIdx != null ? SIGN_SYMBOLS[c.moonIdx] : "" },
    { label: "RISING", val: c.ascIdx != null ? SIGNS[c.ascIdx] : "Unknown", sym: c.ascIdx != null ? SIGN_SYMBOLS[c.ascIdx] : "?" },
  ];
  const cy = 620, spacing = W / 3;
  badges.forEach((b, i) => {
    const cx = spacing * i + spacing / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 110, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,198,135,0.14)";
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(232,198,135,0.5)"; ctx.stroke();
    ctx.fillStyle = "#e8c687"; ctx.font = "64px sans-serif"; ctx.fillText(b.sym, cx, cy + 22);
    ctx.fillStyle = "#b6acc9"; ctx.font = "26px Poppins, sans-serif"; ctx.fillText(b.label, cx, cy + 170);
    ctx.fillStyle = "#f3eefb"; ctx.font = "600 32px Poppins, sans-serif"; ctx.fillText(b.val, cx, cy + 210);
  });

  if (state._lastHoroscope) {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, 90, 950, W - 180, 340, 28); ctx.fill();
    ctx.strokeStyle = "rgba(232,198,135,0.25)"; ctx.lineWidth = 2;
    roundRect(ctx, 90, 950, W - 180, 340, 28); ctx.stroke();
    ctx.fillStyle = "#e8c687"; ctx.font = "600 28px Poppins, sans-serif"; ctx.textAlign = "left";
    ctx.fillText("THIS WEEK", 130, 1020);
    ctx.fillStyle = "#f3eefb"; ctx.font = "30px Poppins, sans-serif";
    wrapText(ctx, state._lastHoroscope.paragraphs[0], 130, 1080, W - 260, 42);
  }

  const love = c.sunIdx != null ? generateLoveEnergy(c.sunIdx, new Date(), c.moonPhase.angle) : null;
  if (love) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#9b7ec0"; ctx.font = "600 28px Poppins, sans-serif";
    ctx.fillText("TODAY'S LOVE ENERGY", W / 2, 1420);
    ctx.fillStyle = "#e8c687"; ctx.font = "700 90px 'Cinzel', serif";
    ctx.fillText(love.score + "%", W / 2, 1530);
  }

  ctx.fillStyle = "#8478a0"; ctx.font = "24px Poppins, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Entertainment purposes only · Get your reading at nakshatra.app", W / 2, 1830);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "", curY = y;
  for (const w of words) {
    const test = line + w + " ";
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY); line = w + " "; curY += lineHeight;
      if (curY > y + lineHeight * 5) break;
    } else line = test;
  }
  ctx.fillText(line, x, curY);
}

function initShare() {
  function openShare() { $("#sheet-share-backdrop").classList.add("visible"); drawShareCard(); }
  function closeShare() { $("#sheet-share-backdrop").classList.remove("visible"); }
  $("#btn-open-share").addEventListener("click", openShare);
  $("#btn-fullreport-share").addEventListener("click", openShare);
  $("#btn-close-share").addEventListener("click", closeShare);
  $("#sheet-share-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-share-backdrop") closeShare(); });
  $("#btn-download-card").addEventListener("click", () => {
    const canvas = $("#shareCanvas");
    const link = document.createElement("a");
    link.download = "nakshatra-cosmic-snapshot.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast("Image downloaded ✨");
  });
  $("#btn-post-community").addEventListener("click", () => {
    postToCommunity();
    closeShare();
  });
}

// ================= SETTINGS / LEGAL / ACCOUNT DELETION =================
function resetSettingsDeleteUI() {
  $("#settings-delete-step1").style.display = "block";
  $("#settings-delete-step2").style.display = "none";
}

function initSettings() {
  // Terms/Privacy can be opened from the pre-login landing page or from the
  // signed-in Settings screen — remember which, so the back button on those
  // two screens returns you to wherever you actually came from (same pattern
  // as #btn-checkout-back in initCheckout()).
  $("#link-landing-terms").addEventListener("click", () => {
    $("#btn-terms-back").setAttribute("data-back", "screen-landing");
    showScreen("screen-terms");
  });
  $("#link-landing-privacy").addEventListener("click", () => {
    $("#btn-privacy-back").setAttribute("data-back", "screen-landing");
    showScreen("screen-privacy");
  });
  $("#btn-settings-privacy").addEventListener("click", () => {
    $("#btn-privacy-back").setAttribute("data-back", "screen-settings");
    showScreen("screen-privacy");
  });
  $("#btn-settings-terms").addEventListener("click", () => {
    $("#btn-terms-back").setAttribute("data-back", "screen-settings");
    showScreen("screen-terms");
  });

  $("#btn-settings-delete-start").addEventListener("click", () => {
    if (!backendDb()) { toast(tr("settings.danger.no-backend")); return; }
    $("#settings-delete-step1").style.display = "none";
    $("#settings-delete-step2").style.display = "block";
  });
  $("#btn-settings-delete-cancel").addEventListener("click", resetSettingsDeleteUI);

  $("#btn-settings-delete-confirm").addEventListener("click", async () => {
    const dbInstance = backendDb();
    if (!dbInstance) { toast(tr("settings.danger.no-backend")); return; }
    const btn = $("#btn-settings-delete-confirm");
    btn.disabled = true;
    btn.textContent = tr("settings.danger.deleting");
    const { error } = await backendCall(dbInstance.deleteAccount(), "deleteAccount");
    if (error) {
      btn.disabled = false;
      btn.textContent = tr("settings.danger.confirm-btn");
      toast(tr("settings.danger.error"));
      return;
    }
    // The account and every row it owned are gone on the server now — clear
    // ALL local state, including the demo-only caches logout deliberately
    // keeps (giftCodes/communityFeed/communityLikes), since there's no
    // account left for them to belong to.
    resetLocalSessionState();
    state.giftCodes = {};
    state.communityFeed = [];
    state.communityLikes = {};
    btn.disabled = false;
    btn.textContent = tr("settings.danger.confirm-btn");
    resetSettingsDeleteUI();
    toast(tr("settings.danger.done"));
    showScreen("screen-landing");
  });
}

// ================= METHODOLOGY SHEET =================
function initMethodology() {
  $("#horo-methodology-toggle").addEventListener("click", () => $("#sheet-method-backdrop").classList.add("visible"));
  $("#btn-close-method").addEventListener("click", () => $("#sheet-method-backdrop").classList.remove("visible"));
  $("#sheet-method-backdrop").addEventListener("click", (e) => { if (e.target.id === "sheet-method-backdrop") $("#sheet-method-backdrop").classList.remove("visible"); });
}

// ================= INIT =================
document.addEventListener("DOMContentLoaded", () => {
  // Apply the detected/default language FIRST — it innerHTML-replaces a couple of
  // elements that contain nested interactive children (the methodology "Details"
  // toggle, the gift-code redeem opener). Running this before the init*() calls
  // below means those calls attach their listeners to the final, stable DOM nodes
  // rather than to nodes that are about to be destroyed and rebuilt.
  applyLanguage(state.lang);
  initLangSwitch();
  initStars();
  initAuth();
  initOnboarding();
  initDashNav();
  initPalmUpload();
  initTierSelection();
  initCheckout();
  initShare();
  initMethodology();
  initCompat();
  initNotifications();
  initGiftSend();
  initGiftRedeem();
  initChat();
  initCommunity();
  initSettings();
  renderOnbStep();

  // If a backend is configured and this browser already has a valid,
  // persisted Supabase session, silently resume straight to the dashboard
  // (or onboarding, if they never finished it) instead of the landing screen.
  bootstrapSession();
});

})();
