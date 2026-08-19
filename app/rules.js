// Deterministic content-rule engines: sun-sign trait library, weekly horoscope
// assembler, palmistry Q&A interpretation, and daily love-energy scorer.
// No generative AI text anywhere in this file — every output is assembled from
// a fixed template + a real astronomical input (sign, element, moon phase).

const SIGN_INFO = [
  { name: "Aries", element: "Fire", ruler: "Mars", traits: "bold, quick-moving, and drawn to a challenge", growth: "pausing before you leap" },
  { name: "Taurus", element: "Earth", ruler: "Venus", traits: "steady, sensory, and loyal to what you love", growth: "loosening your grip when plans shift" },
  { name: "Gemini", element: "Air", ruler: "Mercury", traits: "curious, quick-witted, and always mid-conversation", growth: "following one thread all the way through" },
  { name: "Cancer", element: "Water", ruler: "Moon", traits: "protective, intuitive, and deeply tied to home", growth: "letting people see you before you've fully decided to trust them" },
  { name: "Leo", element: "Fire", ruler: "Sun", traits: "warm, expressive, and happiest when creating something", growth: "sharing the spotlight without it costing you anything" },
  { name: "Virgo", element: "Earth", ruler: "Mercury", traits: "precise, useful, and quietly high-standard", growth: "letting 'good enough' actually be good enough" },
  { name: "Libra", element: "Air", ruler: "Venus", traits: "diplomatic, aesthetic, and tuned to fairness", growth: "deciding without polling the room first" },
  { name: "Scorpio", element: "Water", ruler: "Pluto/Mars", traits: "intense, private, and drawn to what's real underneath", growth: "staying open after you've been right to be guarded" },
  { name: "Sagittarius", element: "Fire", ruler: "Jupiter", traits: "expansive, blunt, and always eyeing the horizon", growth: "finishing what's already in front of you" },
  { name: "Capricorn", element: "Earth", ruler: "Saturn", traits: "disciplined, patient, and building for the long run", growth: "letting rest count as progress too" },
  { name: "Aquarius", element: "Air", ruler: "Saturn/Uranus", traits: "independent, idea-driven, and a little ahead of the room", growth: "letting one person in past the concept of you" },
  { name: "Pisces", element: "Water", ruler: "Jupiter/Neptune", traits: "empathetic, imaginative, and porous to other people's moods", growth: "keeping one foot on the ground while you dream" },
];

const ELEMENT_PAIR = { // classical element compatibility, used only to color tone, not to make hard claims
  "Fire-Fire": "energizing", "Fire-Air": "easy", "Fire-Earth": "grounding but effortful", "Fire-Water": "steamy but a little combustible",
  "Earth-Earth": "steady", "Earth-Air": "a bit restless", "Earth-Water": "nourishing", "Earth-Fire": "grounding but effortful",
  "Air-Air": "quick and mental", "Air-Fire": "easy", "Air-Earth": "a bit restless", "Air-Water": "foggy but tender",
  "Water-Water": "deep", "Water-Fire": "steamy but a little combustible", "Water-Earth": "nourishing", "Water-Air": "foggy but tender",
};

function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86400000);
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}

// ---------------- Weekly horoscope ----------------
function generateWeeklyHoroscope(sunIdx, moonIdx, ascIdx, now, moonPhaseName) {
  const sun = SIGN_INFO[sunIdx];
  const moon = SIGN_INFO[moonIdx];
  const week = isoWeek(now);
  const pairKey = `${sun.element}-${moon.element}`;
  const pairTone = ELEMENT_PAIR[pairKey] || "shifting";

  const openers = [
    `As the Moon moves through its ${moonPhaseName} phase this week, your ${sun.element.toLowerCase()} nature — ${sun.traits} — is running close to the surface.`,
    `This week's ${moonPhaseName} finds your ${sun.name} energy in a fairly assertive mood: ${sun.traits}.`,
    `With the Moon in its ${moonPhaseName} stretch, expect your ${sun.name} instincts to lead: ${sun.traits}.`,
  ];
  const loveLines = [
    `In relationships, the pull between your Sun in ${sun.name} and Moon in ${moon.name} feels ${pairTone} right now — good energy to notice before you act on it.`,
    `Your inner world (Moon in ${moon.name}) and outer style (Sun in ${sun.name}) are working in a ${pairTone} rhythm this week — that shows up most in close conversations.`,
  ];
  const careerLines = [
    `On the work front, week ${week}'s steadier pace favors ${sun.name === "Virgo" || sun.element === "Earth" ? "finishing the detail work you've been circling" : "picking one priority and actually closing it out"}.`,
    `Professionally, this is a reasonable week to ${sun.element === "Fire" ? "pitch the idea you've been sitting on" : sun.element === "Water" ? "trust a hunch you've been second-guessing" : sun.element === "Air" ? "have the conversation you've been mentally drafting" : "put in the unglamorous work that compounds"}.`,
  ];
  const focusLines = [
    `Focus for the week: ${sun.growth}.`,
    `One thing worth practicing: ${sun.growth}.`,
  ];

  const pick = (arr, salt) => arr[(week + salt) % arr.length];
  return {
    week,
    headline: `Week ${week} — Sun in ${sun.name}, Moon in ${moon.name}`,
    paragraphs: [
      pick(openers, sunIdx),
      pick(loveLines, moonIdx),
      pick(careerLines, week),
      pick(focusLines, sunIdx + moonIdx),
    ],
  };
}

// ---------------- Love energy (daily quick-check) ----------------
function generateLoveEnergy(sunIdx, now, moonPhaseAngle) {
  const doy = dayOfYear(now);
  const raw = 50 + 35 * Math.sin((doy + sunIdx * 17 + moonPhaseAngle / 10) * 0.11);
  const score = Math.max(5, Math.min(98, Math.round(raw)));
  let bucket, blurb;
  if (score >= 75) { bucket = "Peak"; blurb = "Communication flows easily today — a good day to say the honest thing out loud."; }
  else if (score >= 50) { bucket = "Strong"; blurb = "Steady, warm energy — good for deepening something that's already working."; }
  else if (score >= 25) { bucket = "Building"; blurb = "Nothing urgent — a quieter day, better for listening than for big declarations."; }
  else { bucket = "Low"; blurb = "Energy is a little inward today. Good day to recharge before a big conversation, not during one."; }
  return { score, bucket, blurb };
}

// ---------------- Palmistry — assisted / guided rule engine ----------------
const PALM_QUESTIONS = [
  {
    id: "lifeLength",
    label: "Life line — how far does it sweep around the base of your thumb?",
    options: [
      { v: "short", t: "Short, stays close to the thumb" },
      { v: "medium", t: "Medium curve, about halfway down the palm" },
      { v: "long", t: "Long, sweeping arc toward the wrist" },
    ],
  },
  {
    id: "lifeDepth",
    label: "Life line — how clearly is it etched?",
    options: [
      { v: "deep", t: "Deep and clearly visible" },
      { v: "faint", t: "Faint or thin" },
      { v: "broken", t: "Broken, or made of overlapping segments" },
    ],
  },
  {
    id: "heartStart",
    label: "Heart line — where does it start, closest to which finger?",
    options: [
      { v: "index", t: "Below the index finger" },
      { v: "middle", t: "Below the middle finger" },
      { v: "flat", t: "Runs fairly straight across, no clear start point" },
    ],
  },
  {
    id: "heartShape",
    label: "Heart line — shape?",
    options: [
      { v: "curved", t: "Curved and smooth" },
      { v: "straight", t: "Long and straight" },
      { v: "branched", t: "Short, with small branch lines" },
    ],
  },
  {
    id: "headShape",
    label: "Head line — does it curve or stay straight?",
    options: [
      { v: "curve", t: "Curves gently downward" },
      { v: "straight", t: "Stays straight and horizontal" },
      { v: "steep", t: "Slopes steeply toward the wrist" },
    ],
  },
  {
    id: "fate",
    label: "Fate line — the vertical line up the palm's center. Is it there?",
    options: [
      { v: "strong", t: "Yes, strong and continuous" },
      { v: "faint", t: "Faint, broken, or partial" },
      { v: "absent", t: "Not clearly visible" },
    ],
  },
  {
    id: "mount",
    label: "Which pad (mount) at the base of your fingers looks fullest / most raised?",
    options: [
      { v: "jupiter", t: "Below the index finger (Jupiter)" },
      { v: "saturn", t: "Below the middle finger (Saturn)" },
      { v: "apollo", t: "Below the ring finger (Apollo/Sun)" },
      { v: "mercury", t: "Below the little finger (Mercury)" },
      { v: "venus", t: "Base of the thumb (Venus)" },
    ],
  },
];

const PALM_RULES = {
  lifeLength: {
    short: "A shorter life line isn't about lifespan in modern palmistry readings — it points to someone who focuses their energy in intense bursts rather than spreading it thin.",
    medium: "A medium, well-proportioned life line suggests balanced vitality — steady energy you can call on without constantly running on empty.",
    long: "A long, sweeping life line points to strong physical vitality and a tendency to stay engaged with life at a fairly ambitious pace.",
  },
  lifeDepth: {
    deep: "Its clear, deep etching suggests robust constitution and a tendency to commit fully once you decide something matters.",
    faint: "A fainter line suggests sensitivity — you likely feel things (and other people's moods) more than you let on.",
    broken: "Breaks or segments often point to major life chapters — periods of real change rather than one continuous line of the same routine.",
  },
  heartStart: {
    index: "Starting below the index finger is classically read as idealistic in love — you want a partner you can genuinely admire, not just get along with.",
    middle: "Starting below the middle finger suggests a more grounded, practical approach to relationships — you love with your feet on the floor.",
    flat: "A flatter, straighter starting point suggests you keep a level head in relationships, even when things get emotionally loud.",
  },
  heartShape: {
    curved: "The smooth curve points to someone who expresses affection openly and reads other people's feelings easily.",
    straight: "A long, straight heart line suggests someone who loves deeply but shows it through actions more than words.",
    branched: "Small branch lines are traditionally read as multiple significant connections — people who left a real mark, not necessarily many relationships.",
  },
  headShape: {
    curve: "A downward curve points to imaginative, associative thinking — you connect ideas other people miss.",
    straight: "A straight, horizontal head line suggests clear, practical, linear thinking — you like a plan you can actually execute.",
    steep: "A steep slope is read as highly creative, sometimes restless thinking — great for ideation, harder for sitting still with routine.",
  },
  fate: {
    strong: "A strong fate line suggests a clear sense of direction — you tend to know, even vaguely, where you're headed.",
    faint: "A faint or broken fate line suggests a path that's still being written — less about fixed destiny, more about a life shaped by your own choices as you go.",
    absent: "No clear fate line is common and simply suggests a self-directed life — your path is shaped more by decisions than by a single fixed trajectory.",
  },
  mount: {
    jupiter: "A full Jupiter mount points to leadership instinct and a natural pull toward ambition and influence.",
    saturn: "A full Saturn mount suggests discipline, patience, and a serious, responsible streak that others rely on.",
    apollo: "A full Apollo (Sun) mount points to a creative, expressive streak — you likely want your work to be seen, not just done.",
    mercury: "A full Mercury mount suggests sharp communication skills and a quick, business-minded way of thinking.",
    venus: "A full Venus mount points to warmth, sensuality, and a strong pull toward beauty, comfort, and close relationships.",
  },
};

function generatePalmReport(answers) {
  const lines = PALM_QUESTIONS.map(q => PALM_RULES[q.id][answers[q.id]]).filter(Boolean);
  return { lines };
}

// ================= Synastry (compatibility) — classical aspect logic =================
// Aspect = angular distance between two signs, measured in whole signs (0-6, symmetric).
// This is real classical astrology, not invented content: conjunction/sextile/square/
// trine/opposition are the standard aspect set, just computed sign-to-sign rather than
// exact-degree-to-exact-degree (a defensible simplification for a sign-level MVP).
const ASPECT_INFO = [
  { name: "Conjunction", score: 82, desc: "your energies blend rather than balance — you'll see a lot of yourself in each other, for better and worse" },
  { name: "Semisextile", score: 55, desc: "a quiet, easy-to-miss difference in pace — rarely a problem, but worth naming out loud occasionally" },
  { name: "Sextile", score: 88, desc: "a naturally friendly, opportunity-building connection — you tend to bring out each other's better instincts" },
  { name: "Square", score: 58, desc: "real friction that generates real growth — this pairing rarely stays comfortable, but it rarely stays boring either" },
  { name: "Trine", score: 94, desc: "an easy, same-wavelength flow — the risk here is coasting rather than actively building something" },
  { name: "Quincunx", score: 50, desc: "you run on genuinely different logic — compatibility here is a skill you build, not something you start with" },
  { name: "Opposition", score: 72, desc: "a classic magnetic pull between two different approaches to the same thing — attraction and friction from the same source" },
];
function signDistance(a, b) { const d = Math.abs(a - b) % 12; return d > 6 ? 12 - d : d; }
function aspectBetween(a, b) { return ASPECT_INFO[signDistance(a, b)]; }
function withArticle(word) { return (/^[aeiou]/i.test(word) ? "an " : "a ") + word; }

function generateSynastry(nameA, sunA, moonA, nameB, sunB, moonB) {
  const ss = aspectBetween(sunA, sunB);
  const mm = aspectBetween(moonA, moonB);
  const smA = aspectBetween(sunA, moonB); // A's identity meets B's emotional world
  const smB = aspectBetween(sunB, moonA); // B's identity meets A's emotional world
  const score = Math.round(ss.score * 0.35 + mm.score * 0.35 + smA.score * 0.15 + smB.score * 0.15);

  const paragraphs = [
    `${nameA}'s Sun in ${SIGN_INFO[sunA].name} meets ${nameB}'s Sun in ${SIGN_INFO[sunB].name} at ${withArticle(ss.name.toLowerCase())} — ${ss.desc}.`,
    `Emotionally, ${nameA}'s Moon in ${SIGN_INFO[moonA].name} and ${nameB}'s Moon in ${SIGN_INFO[moonB].name} form ${withArticle(mm.name.toLowerCase())}: ${mm.desc}.`,
    `${nameA}'s core identity lands on ${nameB}'s inner world as ${withArticle(smA.name.toLowerCase())} — ${smA.desc}.`,
    `And in reverse, ${nameB}'s core identity meets ${nameA}'s inner world as ${withArticle(smB.name.toLowerCase())} — ${smB.desc}.`,
  ];
  let verdict;
  if (score >= 85) verdict = "This is an easy-flowing pairing on paper — the real work is not taking that ease for granted.";
  else if (score >= 68) verdict = "A workable, promising mix — good foundations, with a couple of edges worth being deliberate about.";
  else verdict = "A genuinely effortful pairing — not a red flag by itself, but one where consistent communication matters more than usual.";

  return { score, ss, mm, paragraphs, verdict };
}

// ================= Year Ahead — real Jupiter & Saturn transits =================
const JUPITER_THEMES = [
  { tag: "saying yes more often", full: "a natural year to say yes to more — Jupiter tends to reward visibility over caution right now" },
  { tag: "expanding your circle", full: "growth through expansion — bigger conversations, bigger opportunities, and a wider circle" },
  { tag: "formalizing what's informal", full: "a good year to formalize something you've been informally building" },
  { tag: "broadening your frame of reference", full: "a stretch that favors learning, travel, or anything that broadens your frame of reference" },
];
const SATURN_THEMES = [
  { tag: "consistent, unglamorous work", full: "a year that rewards structure — the boring, consistent work compounds more than usual right now" },
  { tag: "tightening your commitments", full: "a period of tightening up commitments — fewer things, held more seriously" },
  { tag: "taking on real responsibility", full: "a stretch where responsibility increases, and so does what it earns you long-term" },
  { tag: "finishing what's unfinished", full: "a good year to finish what's unfinished before starting anything new" },
];
function generateYearAhead(sunIdx, jupiterSignIdx, saturnSignIdx, userAge) {
  const sun = SIGN_INFO[sunIdx];
  const jupAspect = aspectBetween(sunIdx, jupiterSignIdx);
  const satAspect = aspectBetween(sunIdx, saturnSignIdx);
  const jupTheme = JUPITER_THEMES[(sunIdx + jupiterSignIdx) % JUPITER_THEMES.length];
  const satTheme = SATURN_THEMES[(sunIdx + saturnSignIdx) % SATURN_THEMES.length];

  const isSaturnReturn = userAge != null && ((userAge >= 27 && userAge <= 31) || (userAge >= 56 && userAge <= 60));

  const paragraphs = [
    `Jupiter is currently transiting ${SIGN_INFO[jupiterSignIdx].name}, forming ${withArticle(jupAspect.name.toLowerCase())} to your ${sun.name} Sun — ${jupAspect.desc}. Practically: ${jupTheme.full}.`,
    `Saturn is currently transiting ${SIGN_INFO[saturnSignIdx].name}, forming ${withArticle(satAspect.name.toLowerCase())} to your ${sun.name} Sun — ${satAspect.desc}. Practically: ${satTheme.full}.`,
  ];
  if (isSaturnReturn) {
    paragraphs.push(`Worth flagging: at your age, you're in (or close to) an actual Saturn Return — the ~29.5-year point where Saturn comes back around to roughly where it was when you were born. Astrologically this is read as a real threshold year, one where the structures you built earlier get tested, kept, or rebuilt more deliberately.`);
  }
  paragraphs.push(`Overall focus for the year ahead: let Jupiter push you toward ${jupTheme.tag}, while Saturn keeps you anchored to ${satTheme.tag}.`);

  return { paragraphs, isSaturnReturn, jupiterSign: jupiterSignIdx, saturnSign: saturnSignIdx };
}

// ---------------- Simulated "chat with an astrologer" (Phase 4, demo) ----------------
// IMPORTANT — this is NOT a real person and NOT a generative AI model. Every reply is
// picked deterministically from a fixed template bank keyed by (topic, sign, turn
// number) — same inputs always produce the same reply. This keeps it consistent with
// the rest of the app's "no freeform AI text" design choice, and the on-screen
// disclaimer (rendered by app.js on every chat screen) says so explicitly so nobody
// mistakes it for a live human or an AI chatbot.
const ASTROLOGERS = [
  { id: "priya", name: "Priya", avatar: "🪷", specialty: "career", specialtyLabel: "Career & Vedic Astrology", tagline: "Grounded, practical reads on work and timing." },
  { id: "kabir", name: "Kabir", avatar: "💫", specialty: "love", specialtyLabel: "Love & Relationships", tagline: "Warm, direct takes on matters of the heart." },
  { id: "meera", name: "Meera", avatar: "🌙", specialty: "family", specialtyLabel: "Family & Life Path", tagline: "Reflective guidance on home, family, and big decisions." },
];

const CHAT_TOPIC_KEYWORDS = {
  love: ["love", "relationship", "partner", "marriage", "breakup", "break up", "crush", "dating", "boyfriend", "girlfriend", "husband", "wife", "romance", "heart"],
  career: ["career", "job", "work", "money", "finance", "business", "promotion", "salary", "interview", "boss", "office"],
  family: ["family", "parents", "mother", "father", "home", "children", "kids", "sibling", "marriage plans", "move"],
  health: ["health", "stress", "sleep", "energy", "anxious", "anxiety", "tired", "burnout", "rest"],
};
function classifyChatTopic(text, fallbackTopic) {
  const lower = (text || "").toLowerCase();
  for (const topic of Object.keys(CHAT_TOPIC_KEYWORDS)) {
    if (CHAT_TOPIC_KEYWORDS[topic].some(k => lower.includes(k))) return topic;
  }
  return fallbackTopic || "general";
}

const CHAT_REPLY_BANK = {
  love: [
    (sun, moon) => `With your Sun in ${sun.name}, you tend to be ${sun.traits} in how you show up for people — in love that usually means the growth edge is ${sun.growth}. What's the situation, in one line?`,
    (sun, moon) => `Your Moon in ${moon.name} shapes how you actually feel underneath the surface. If this is about a relationship, notice whether you're reacting from that Moon place or from the ${sun.name} face you show the world — they're not always the same.`,
    (sun, moon) => `Classic ${sun.name} pattern here: ${sun.traits}. That's usually an asset in love, but it can also be exactly what you need to soften when things get tense. Tell me more about what's actually happening.`,
    (sun, moon) => `I'd want to know the other person's Sun sign to say more, but from your side alone: your Moon in ${moon.name} needs to feel emotionally safe before anything else moves forward. Is that the missing piece here?`,
  ],
  career: [
    (sun, moon) => `Sun in ${sun.name} usually works best when you lean into being ${sun.traits} — don't fight that instinct at work, use it deliberately. What's the decision in front of you?`,
    (sun, moon) => `For a ${sun.name} Sun, the growth edge professionally is often ${sun.growth}. If you're stuck on something work-related, that's usually where to look first.`,
    (sun, moon) => `Your Moon in ${moon.name} affects how secure you feel about money and stability, separate from how ambitious your Sun in ${sun.name} makes you look on paper. Which one is actually driving this question?`,
    (sun, moon) => `Practical read: ${sun.name} energy does well when it commits to one lane instead of hedging across three. What are you weighing right now?`,
  ],
  family: [
    (sun, moon) => `Moon in ${moon.name} is really the family-and-home placement — it says a lot about what "home" needs to feel like for you to be at ease. Is that lining up with your situation right now?`,
    (sun, moon) => `Your Sun in ${sun.name} — ${sun.traits} — often plays out differently at home than it does everywhere else. Tell me a bit more about what's going on.`,
    (sun, moon) => `With Moon in ${moon.name}, the growth work is usually about setting a boundary with family without it turning into a whole event. What's the specific thing?`,
    (sun, moon) => `Family stuff tends to bring out the ${sun.name} in you most strongly — for better and worse: ${sun.traits}. What's the actual question underneath this?`,
  ],
  health: [
    (sun, moon) => `Moon in ${moon.name} governs your emotional reserves — when that's running low, it shows up as tiredness before it shows up as anything else. How long has this been going on?`,
    (sun, moon) => `A ${sun.name} Sun tends to push through instead of resting, which catches up eventually. The growth edge here is ${sun.growth} — sound familiar?`,
    (sun, moon) => `I'll say the plain thing: I can offer a reflective astrological angle, but ongoing stress, sleep, or health concerns are worth bringing to an actual doctor too, not just a reading. What's been going on day to day?`,
  ],
  general: [
    (sun, moon) => `Tell me a bit more about what's on your mind — with Sun in ${sun.name} and Moon in ${moon.name}, I can usually give you a more specific read once I know the actual situation.`,
    (sun, moon) => `Sun in ${sun.name}, Moon in ${moon.name} — that combination is ${sun.traits} on the outside, but underneath it's shaped by what your Moon needs. What would you like to talk through?`,
    (sun, moon) => `Happy to dig into love, career, or family — or just tell me what's actually going on and I'll work from there.`,
  ],
};

const CHAT_GREETINGS = {
  priya: (sun) => `Namaste! I'm Priya — I mostly work with career timing and Vedic placements. I can see your Sun is in ${sun.name}. What's on your mind — work, money, or a decision you're sitting on?`,
  kabir: (sun) => `Hey, I'm Kabir — relationships and matters of the heart are my focus. Sun in ${sun.name}, got it. What's going on in your love life right now?`,
  meera: (sun) => `Hello, I'm Meera. I like to talk through family, home, and the bigger life-path questions. With your Sun in ${sun.name}, I'm curious what's brought you here today.`,
};

function generateAstrologerReply(astrologerId, sunIdx, moonIdx, userText, turnIndex) {
  const astro = ASTROLOGERS.find(a => a.id === astrologerId) || ASTROLOGERS[0];
  const sun = SIGN_INFO[sunIdx];
  const moon = SIGN_INFO[moonIdx];
  const topic = classifyChatTopic(userText, astro.specialty);
  const bank = CHAT_REPLY_BANK[topic] || CHAT_REPLY_BANK.general;
  const fn = bank[(turnIndex + sunIdx + moonIdx) % bank.length];
  return fn(sun, moon);
}

// ---------------- Simulated community feed (Phase 4, demo) ----------------
// Fixed, hand-written seed posts from fictional demo accounts — there is no real
// backend and no real other users behind these; app.js labels the feed as a local
// demo explicitly. Seed data lives here (alongside the rest of the content library)
// rather than in app.js purely for organization.
const COMMUNITY_SEED = [
  { id: "seed-1", name: "Ananya R.", avatar: "🦁", signIdx: 4, type: "horoscope", caption: "This week's Leo horoscope was scarily accurate about needing to share the spotlight for once 😅", likes: 24, timeAgo: "2h ago" },
  { id: "seed-2", name: "Devika S.", avatar: "🦂", signIdx: 7, type: "palm", caption: "My fate line reading said 'strong' and honestly it tracks — big year for me.", likes: 41, timeAgo: "5h ago" },
  { id: "seed-3", name: "Rohit M.", avatar: "♊", signIdx: 2, type: "love", caption: "Love energy at 82% today and my whole week just got better", likes: 17, timeAgo: "8h ago" },
  { id: "seed-4", name: "Simran K.", avatar: "♑", signIdx: 9, type: "yearahead", caption: "Saturn transit reading nailed the 'finish what's unfinished' theme for my year. Taking it seriously.", likes: 33, timeAgo: "1d ago" },
  { id: "seed-5", name: "Aarav P.", avatar: "♓", signIdx: 11, type: "horoscope", caption: "Sun in Pisces, feeling very seen by the 'porous to other people's moods' line honestly", likes: 29, timeAgo: "1d ago" },
  { id: "seed-6", name: "Tanvi B.", avatar: "♍", signIdx: 5, type: "compat", caption: "Ran a compatibility check with my partner — 78%! Screenshotting this for our anniversary.", likes: 52, timeAgo: "2d ago" },
];

if (typeof module !== "undefined") {
  module.exports = { SIGN_INFO, ELEMENT_PAIR, generateWeeklyHoroscope, generateLoveEnergy, PALM_QUESTIONS, PALM_RULES, generatePalmReport, dayOfYear, isoWeek, ASPECT_INFO, signDistance, aspectBetween, generateSynastry, generateYearAhead, ASTROLOGERS, classifyChatTopic, generateAstrologerReply, CHAT_GREETINGS, COMMUNITY_SEED };
}
