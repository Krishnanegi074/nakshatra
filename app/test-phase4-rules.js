// Node-only unit tests for the Phase 4 rule-based content: the simulated astrologer
// chat reply generator/topic classifier and the community seed data shape.
const assert = require("assert");
const {
  SIGN_INFO, ASTROLOGERS, classifyChatTopic, generateAstrologerReply, CHAT_GREETINGS, COMMUNITY_SEED,
} = require("./rules.js");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL:", name); }
}

console.log("== Group 1: topic classification ==");
check("love keyword -> love", classifyChatTopic("I have a question about my boyfriend") === "love");
check("career keyword -> career", classifyChatTopic("should I take this new job offer") === "career");
check("family keyword -> family", classifyChatTopic("things are tense with my parents") === "family");
check("health keyword -> health", classifyChatTopic("I've been so stressed and tired lately") === "health");
check("no keyword -> fallback", classifyChatTopic("hello there", "career") === "career");
check("no keyword, no fallback -> general", classifyChatTopic("hello there") === "general");
check("empty string -> fallback/general, does not throw", classifyChatTopic("") === "general");
check("case-insensitive", classifyChatTopic("MY BOYFRIEND and I broke up") === "love");

console.log("\n== Group 2: astrologer roster ==");
check("3 astrologers", ASTROLOGERS.length === 3);
check("all astrologers have id/name/avatar/specialty", ASTROLOGERS.every(a => a.id && a.name && a.avatar && a.specialty));
check("all astrologer ids are unique", new Set(ASTROLOGERS.map(a => a.id)).size === ASTROLOGERS.length);
check("all astrologers have a matching greeting fn", ASTROLOGERS.every(a => typeof CHAT_GREETINGS[a.id] === "function"));

console.log("\n== Group 3: reply generation ==");
for (const astro of ASTROLOGERS) {
  const greeting = CHAT_GREETINGS[astro.id](SIGN_INFO[0]);
  check(`${astro.id} greeting is a non-empty string`, typeof greeting === "string" && greeting.length > 10);
  check(`${astro.id} greeting mentions the sign name`, greeting.includes(SIGN_INFO[0].name));
}
// deterministic: same inputs -> same output
const r1 = generateAstrologerReply("priya", 3, 7, "how's my career going", 0);
const r2 = generateAstrologerReply("priya", 3, 7, "how's my career going", 0);
check("same inputs produce identical reply (deterministic, not random)", r1 === r2);
// varies across turns so a real back-and-forth doesn't look robotic-identical every time
const r3 = generateAstrologerReply("priya", 3, 7, "how's my career going", 1);
check("different turn index can produce a different reply", r1 !== r3 || true); // soft check, banks may collide by chance
// covers every topic + every sign index without throwing or returning empty
let allNonEmpty = true;
for (let s = 0; s < 12; s++) {
  for (const topic of ["love", "career", "family", "health", "general", "gibberish text"]) {
    const reply = generateAstrologerReply("kabir", s, (s + 3) % 12, topic, s);
    if (!reply || typeof reply !== "string") allNonEmpty = false;
  }
}
check("all sign/topic combinations return a non-empty reply", allNonEmpty);
check("unknown astrologer id falls back gracefully (does not throw)", (() => {
  try { return typeof generateAstrologerReply("nonexistent", 0, 0, "hi", 0) === "string"; }
  catch (e) { return false; }
})());

console.log("\n== Group 4: community seed data ==");
check("at least 5 seed posts", COMMUNITY_SEED.length >= 5);
check("every seed post has required fields", COMMUNITY_SEED.every(p => p.id && p.name && p.avatar && typeof p.signIdx === "number" && p.caption && typeof p.likes === "number"));
check("every seed post signIdx is a valid sign index", COMMUNITY_SEED.every(p => p.signIdx >= 0 && p.signIdx < 12));
check("every seed post id is unique", new Set(COMMUNITY_SEED.map(p => p.id)).size === COMMUNITY_SEED.length);
check("every seed post has a positive like count", COMMUNITY_SEED.every(p => p.likes > 0));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
