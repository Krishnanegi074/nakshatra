#!/usr/bin/env node
// Nakshatra — seeds (and later removes) a throwaway customer + an active
// chat_sessions row for MANUAL browser testing of the expert chat, skipping
// the Razorpay payment. Real project, service_role — same env as
// realtime-test.js.
//
//   node manual-chat-session.js setup     # creates customer + session, prints credentials
//   node manual-chat-session.js cleanup   # deletes them (reads ids from the state file)
//
// Env: SUPABASE_SERVICE_ROLE_KEY, EXPERT_PASSWORD not needed here, only
// SUPABASE_URL (defaults to the public project URL) and the service key.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { requireProductionConfirmation } = require("./production-gate");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xinelwrxgveztrtokwbt.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPERT_EMAIL = process.env.EXPERT_EMAIL;   // kept out of the repo: it lives in ~/.nakshatra-realtime-test.env
const STATE_FILE = path.join(os.tmpdir(), "nakshatra-manual-chat-state.json");

requireProductionConfirmation({ script: "manual-chat-session.js", url: SUPABASE_URL, willDo: "create (setup) or delete (cleanup) a throwaway customer account and an active chat session." });
if (!SERVICE_ROLE_KEY) { console.error("Set SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
if (!EXPERT_EMAIL) { console.error("Set EXPERT_EMAIL (the expert account's login email). It is in ~/.nakshatra-realtime-test.env: `source` that file first."); process.exit(1); }
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const rand = () => Math.random().toString(36).slice(2, 8);

async function setup() {
  if (fs.existsSync(STATE_FILE)) throw new Error(`State file exists (${STATE_FILE}) — run cleanup first.`);

  let expert = null;
  for (let page = 1; page <= 20 && !expert; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    expert = data.users.find(u => u.email === EXPERT_EMAIL);
    if (data.users.length < 200) break;
  }
  if (!expert) throw new Error("Expert auth user not found: " + EXPERT_EMAIL);

  const email = `manual-test-customer-${rand()}@example.com`;
  const password = "Test" + rand() + "!9Aa";
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name: "Manual Test Customer" },
  });
  if (cErr) throw cErr;

  const { data: session, error: sErr } = await admin.from("chat_sessions")
    .insert({ user_id: created.user.id, expert_id: expert.id, amount_paise: 100 }).select().single();
  if (sErr) { await admin.auth.admin.deleteUser(created.user.id); throw sErr; }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ userId: created.user.id, sessionId: session.id }));
  console.log("Customer email:   ", email);
  console.log("Customer password:", password);
  console.log("Session id:       ", session.id);
  console.log("Expert:           ", EXPERT_EMAIL);
}

async function cleanup() {
  if (!fs.existsSync(STATE_FILE)) { console.log("Nothing to clean up (no state file)."); return; }
  const { userId, sessionId } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  await admin.from("chat_messages").delete().eq("session_id", sessionId);
  await admin.from("chat_sessions").delete().eq("id", sessionId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  console.log(error ? "Failed to delete customer: " + error.message : "Deleted customer, session and messages.");
  fs.unlinkSync(STATE_FILE);
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup() : Promise.reject(new Error("Usage: setup | cleanup")))
  .catch(e => { console.error("FATAL:", e.message); process.exit(1); });
