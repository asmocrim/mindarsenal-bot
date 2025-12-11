// bot.js
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

// ---------- ENV DEBUG ----------
console.log("[ENV] OPENAI_API_KEY present:", !!process.env.OPENAI_API_KEY);
console.log("[ENV] BOT_TOKEN present:", !!process.env.BOT_TOKEN);

// ---------- Telegram & OpenAI ----------
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("❌ BOT_TOKEN missing in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const OPENAI_MODEL = "gpt-4o-mini";

// ---------- Master Asmo System Prompt ----------
const SYSTEM_PROMPT = `
You are the MindArsenal AI Coach, modeled after Master Asmo.
Tone: ruthless, stoic, commanding. No emojis. No softness.
You enforce discipline, remove excuses, and sharpen the user's habits.
Use short, precise language. Maximum 5 short paragraphs per reply.
Acknowledge wins briefly. Call out failures directly with clear correction steps.
Never comfort. Never ramble. Always end with a concrete execution step or next action.
`;

// ---------- Reusable Text Snippets ----------
const BETA_WELCOME_MESSAGE =
  "Welcome to the MindArsenal Beta.\n" +
  "This system will hold you to a warrior standard.\n\n" +
  "Expect morning commands, nightly accountability, and a weekly war report.\n" +
  "Your job: reply honestly and execute daily.\n\n" +
  "Failure is noted. Progress is forged.\n" +
  "Stay sharp.";

const AM_PROMPT =
  "Dawn Report.\n\n" +
  "State your 3 critical objectives for today.\n\n" +
  "Concrete actions only. No wishes. No fluff.";

const PM_PROMPT =
  "Nightly Debrief.\n\n" +
  "Report:\n" +
  "- What did you execute?\n" +
  "- What did you skip?\n" +
  "- Why?\n\n" +
  "No excuses. Only truth.";

const STARTUP_PING =
  "MindArsenal core updated.\n\n" +
  "Onboarding, AM/PM check-ins, data logging and Master Asmo protocol are now active.";

// ---------- JSON DB ----------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "users.json");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    return {};
  }
}

function saveUsers(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

let users = loadUsers();

// ---------- Utils ----------
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatTimeString(text) {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ensureUser(msg) {
  const id = String(msg.chat.id);

  if (!users[id]) {
    users[id] = {
      chatId: id,
      firstName: msg.chat.first_name || "",
      name: "",
      timezone: "",
      amTime: "07:00",
      pmTime: "21:00",
      goalsText: "",
      habitsText: "",
      pending: null,
      onboardingStep: null,
      onboarded: false,
      logs: {},
      stats: {
        totalDays: 0,
        daysWithBoth: 0,
        streakCurrent: 0,
        streakBest: 0
      },
      weeklyStats: {}
    };
  }

  saveUsers(users);
  return users[id];
}

function updateDailyStats(user, dateStr) {
  const day = user.logs[dateStr];
  if (!day || day._counted) return;

  user.stats.totalDays++;

  if (day.am && day.pm) {
    user.stats.daysWithBoth++;
    user.stats.streakCurrent++;
    user.stats.streakBest = Math.max(
      user.stats.streakBest,
      user.stats.streakCurrent
    );
  } else {
    user.stats.streakCurrent = 0;
  }

  day._counted = true;
}

// ---------- AI Reply ----------
async function coachReply(user, text) {
  const name = user.name || user.firstName || "warrior";
  const goals = user.goalsText || user.habitsText || "No mission defined.";

  if (!hasOpenAI)
    return `${name}, system offline.\nYour mission:\n${goals}`;

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Trainee: ${name}\nMission:\n${goals}\n\nUser message:\n${text}`
        }
      ]
    });

    return res.choices[0].message.content.trim();
  } catch (err) {
    return `${name}, OpenAI failed.\nMessage:\n"${text}"\nExecute one step now.`;
  }
}

// ---------- COMMANDS ----------

// /gpt test
bot.onText(/\/gpt/, async (msg) => {
  if (!hasOpenAI)
    return bot.sendMessage(msg.chat.id, "OpenAI missing.");

  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "Short. Ruthless." },
      { role: "user", content: "Say System online." }
    ]
  });

  bot.sendMessage(msg.chat.id, res.choices[0].message.content.trim());
});

// /start
bot.onText(/\/start/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  // Already onboarded → show summary
  if (user.onboarded) {
    const s = user.stats;
    const summary =
      "MindArsenal Coach online.\nYou are enlisted.\n\n" +
      `Name: ${user.name || user.firstName}\n` +
      `Zone: ${user.timezone}\n` +
      `AM: ${user.amTime}\nPM: ${user.pmTime}\n\n` +
      `Mission:\n${user.goalsText}\n\n` +
      "Discipline:\n" +
      `• Full execution days: ${s.daysWithBoth}/${s.totalDays}\n` +
      `• Current streak: ${s.streakCurrent}\n` +
      `• Best streak: ${s.streakBest}`;
    bot.sendMessage(chatId, summary);
    return;
  }

  // NEW USER FLOW
  user.onboardingStep = "name";
  saveUsers(users);

  bot.sendMessage(chatId, BETA_WELCOME_MESSAGE).then(() => {
    bot.sendMessage(
      chatId,
      "MindArsenal Coach online.\n" +
        "Step 1/5 — Name.\nHow do I address you?"
    );
  });
});

// /onboard
bot.onText(/\/onboard/, (msg) => {
  const user = ensureUser(msg);
  user.onboardingStep = "name";
  user.onboarded = false;
  saveUsers(users);

  bot.sendMessage(
    user.chatId,
    "Onboarding reset.\nStep 1/5 — Name.\nHow do I call you?"
  );
});

// /setgoals
bot.onText(/\/setgoals/, (msg) => {
  const user = ensureUser(msg);
  user.pending = "setgoals";
  saveUsers(users);

  bot.sendMessage(
    user.chatId,
    "Update mission.\nSend your TOP 3 habits/goals."
  );
});

// /status
bot.onText(/\/status/, (msg) => {
  const user = ensureUser(msg);
  const d = todayDate();
  const day = user.logs[d] || {};

  const s = user.stats;

  const txt =
    `Status for ${d}:\n` +
    `AM: ${day.am ? "DONE" : "MISSING"}\n` +
    `PM: ${day.pm ? "DONE" : "MISSING"}\n\n` +
    `All-time:\n` +
    `• Full days: ${s.daysWithBoth}/${s.totalDays}\n` +
    `• Streak: ${s.streakCurrent}\n` +
    `• Best: ${s.streakBest}`;

  bot.sendMessage(user.chatId, txt);
});

// /test_am
bot.onText(/\/test_am/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded)
    return bot.sendMessage(user.chatId, "Complete onboarding first.");

  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  bot.sendMessage(user.chatId, AM_PROMPT);
  user.pending = "am";
  user.logs[d].amPromptSent = true;
  saveUsers(users);
});

// /test_pm
bot.onText(/\/test_pm/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded)
    return bot.sendMessage(user.chatId, "Complete onboarding first.");

  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  bot.sendMessage(user.chatId, PM_PROMPT);
  user.pending = "pm";
  user.logs[d].pmPromptSent = true;
  saveUsers(users);
});

// /test_weekly
bot.onText(/\/test_weekly/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded)
    return bot.sendMessage(user.chatId, "No data yet.");

  const today = new Date();
  const todayStr = todayDate();
  const logs = user.logs;

  let total = 0;
  let full = 0;

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);

    if (logs[key]) {
      total++;
      if (logs[key].am && logs[key].pm) full++;
    }
  }

  const rate = total ? Math.round((full / total) * 100) : 0;

  bot.sendMessage(
    user.chatId,
    "Weekly War Report.\n\n" +
      `Last 7 days (to ${todayStr}):\n` +
      `• Execution rate: ${rate}%\n` +
      `• Full days: ${full}/${total}\n\n` +
      "This week is dead.\nThe next one is unbuilt.\nDominate it."
  );
});

// ---------- MESSAGE ROUTER ----------
bot.on("message", async (msg) => {
  const text = msg.text || "";
  if (text.startsWith("/")) return;

  const user = ensureUser(msg);
  const d = todayDate();

  if (!user.logs[d]) user.logs[d] = {};

  // ONBOARDING FLOW
  if (user.onboardingStep) {
    const step = user.onboardingStep;
    const value = text.trim();

    if (step === "name") {
      user.name = value;
      user.onboardingStep = "timezone";
      saveUsers(users);
      return bot.sendMessage(
        user.chatId,
        "Step 2/5 — Timezone.\nExample: Europe/Zurich"
      );
    }

    if (step === "timezone") {
      user.timezone = value;
      user.onboardingStep = "habits";
      saveUsers(users);
      return bot.sendMessage(
        user.chatId,
        "Step 3/5 — Mission.\nSend your TOP 3 habits/goals."
      );
    }

    if (step === "habits") {
      user.goalsText = value;
      user.habitsText = value;
      user.onboardingStep = "amTime";
      saveUsers(users);
      return bot.sendMessage(
        user.chatId,
        "Step 4/5 — AM time.\nExample: 07:00"
      );
    }

    if (step === "amTime") {
      const t = formatTimeString(value);
      if (!t)
        return bot.sendMessage(
          user.chatId,
          "Invalid format. Use HH:MM (24h)."
        );

      user.amTime = t;
      user.onboardingStep = "pmTime";
      saveUsers(users);
      return bot.sendMessage(
        user.chatId,
        "Step 5/5 — PM time.\nExample: 21:00"
      );
    }

    if (step === "pmTime") {
      const t = formatTimeString(value);
      if (!t)
        return bot.sendMessage(
          user.chatId,
          "Invalid format. Use HH:MM (24h)."
        );

      user.pmTime = t;
      user.onboardingStep = null;
      user.onboarded = true;
      saveUsers(users);

      const summary =
        "Onboarding complete.\nProtocol armed.\n\n" +
        `Name: ${user.name}\n` +
        `Zone: ${user.timezone}\n` +
        `AM: ${user.amTime}\nPM: ${user.pmTime}\n\n` +
        `Mission:\n${user.goalsText}\n\n` +
        "Reports will hit at your times.\nRespond. No excuses.";

      return bot.sendMessage(user.chatId, summary);
    }
  }

  // SETGOALS flow
  if (user.pending === "setgoals") {
    user.goalsText = text.trim();
    user.habitsText = text.trim();
    user.pending = null;
    saveUsers(users);
    return bot.sendMessage(
      user.chatId,
      "Mission updated:\n" + user.goalsText
    );
  }

  // AM
  if (user.pending === "am") {
    user.logs[d].am = { text, timestamp: new Date().toISOString() };
    user.pending = null;
    saveUsers(users);
    return bot.sendMessage(
      user.chatId,
      "Dawn Report logged.\nExecute."
    );
  }

  // PM
  if (user.pending === "pm") {
    user.logs[d].pm = { text, timestamp: new Date().toISOString() };
    user.pending = null;

    updateDailyStats(user, d);
    saveUsers(users);

    return bot.sendMessage(
      user.chatId,
      "Nightly Debrief logged.\nTomorrow the standard rises."
    );
  }

  // AI fallback
  const reply = await coachReply(user, text);
  bot.sendMessage(user.chatId, reply);
});
// ---------- CRON: AM/PM per user ----------
cron.schedule("* * * * *", () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const current = `${hh}:${mm}`;
  const d = todayDate();

  let changed = false;

  Object.values(users).forEach((user) => {
    if (!user.onboarded) return;
    if (!user.logs[d]) user.logs[d] = {};

    const day = user.logs[d];

    if (current === user.amTime && !day.amPromptSent) {
      bot.sendMessage(user.chatId, AM_PROMPT);
      user.pending = "am";
      day.amPromptSent = true;
      changed = true;
    }

    if (current === user.pmTime && !day.pmPromptSent) {
      bot.sendMessage(user.chatId, PM_PROMPT);
      user.pending = "pm";
      day.pmPromptSent = true;
      changed = true;
    }
  });

  if (changed) saveUsers(users);
});

// ---------- CRON: Weekly Report ----------
cron.schedule("0 18 * * 0", () => {
  const today = new Date();
  const todayStr = todayDate();

  Object.values(users).forEach((user) => {
    if (!user.onboarded) return;

    const logs = user.logs;
    let total = 0;
    let full = 0;

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);

      if (logs[key]) {
        total++;
        if (logs[key].am && logs[key].pm) full++;
      }
    }

    const rate = total ? Math.round((full / total) * 100) : 0;

    bot.sendMessage(
      user.chatId,
      "Weekly War Report.\n\n" +
        `Last 7 days (to ${todayStr}):\n` +
        `• Execution rate: ${rate}%\n` +
        `• Full days: ${full}/${total}\n\n` +
        "This week is dead.\nThe next one is unbuilt.\nDominate it."
    );
  });
});

// ---------- Startup Ping ----------
Object.values(users).forEach((user) => {
  bot.sendMessage(user.chatId, STARTUP_PING);
});

console.log("MindArsenal bot running. Polling started.");
