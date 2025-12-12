// bot.js
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

const logger = require("./logger");

// ---------- Telegram & OpenAI ----------
const token = process.env.BOT_TOKEN;

logger.info({
  event: "env",
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  BOT_TOKEN: !!process.env.BOT_TOKEN,
});

if (!token) {
  logger.fatal({ event: "fatal", msg: "BOT_TOKEN missing in .env" });
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
const RUNTIME_FILE = path.join(DATA_DIR, "runtime.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    logger.info({ event: "users_load", count: Object.keys(data).length });
    return data;
  } catch (err) {
    logger.warn({ event: "users_load_fail", err: err?.message || String(err) });
    return {};
  }
}

function saveUsers(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  logger.info({ event: "users_save", count: Object.keys(data).length });
}

function loadRuntime() {
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
    return rt;
  } catch {
    return {
      started_at: new Date().toISOString(),
      jobs: {},
      counters: { send_ok: 0, send_err: 0 },
    };
  }
}

function saveRuntime(rt) {
  ensureDataDir();
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(rt, null, 2), "utf8");
}

const runtime = loadRuntime();

function markJob(jobName, status, extra = {}) {
  runtime.jobs[jobName] = {
    ...runtime.jobs[jobName],
    last_status: status,
    last_at: new Date().toISOString(),
    ...extra,
  };
  saveRuntime(runtime);
}

let users = loadUsers();

// ---------- Safe Send Wrapper ----------
async function safeSend(chatId, text, extra = {}) {
  try {
    const res = await bot.sendMessage(chatId, text, extra);

    runtime.counters.send_ok++;
    saveRuntime(runtime);

    logger.info({
      event: "msg_out",
      chat_id: String(chatId),
      message_id: res?.message_id,
      text_len: (text || "").length,
    });

    return res;
  } catch (err) {
    runtime.counters.send_err++;
    saveRuntime(runtime);

    logger.error({
      event: "send_error",
      chat_id: String(chatId),
      err: err?.message || String(err),
    });

    throw err;
  }
}

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
        streakBest: 0,
      },
      weeklyStats: {},
    };

    logger.info({ event: "user_new", user_id: id });
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
    user.stats.streakBest = Math.max(user.stats.streakBest, user.stats.streakCurrent);
  } else {
    user.stats.streakCurrent = 0;
  }

  day._counted = true;
}

// ---------- AI Reply ----------
async function coachReply(user, text) {
  const name = user.name || user.firstName || "warrior";
  const goals = user.goalsText || user.habitsText || "No mission defined.";

  if (!hasOpenAI) {
    logger.warn({ event: "openai_missing", user_id: user.chatId });
    return `${name}, system offline.\nYour mission:\n${goals}`;
  }

  try {
    logger.info({
      event: "openai_call",
      user_id: user.chatId,
      model: OPENAI_MODEL,
      text_len: (text || "").length,
    });

    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Trainee: ${name}\nMission:\n${goals}\n\nUser message:\n${text}`,
        },
      ],
    });

    return res.choices[0].message.content.trim();
  } catch (err) {
    logger.error({
      event: "openai_error",
      user_id: user.chatId,
      err: err?.message || String(err),
    });

    return `${name}, OpenAI failed.\nMessage:\n"${text}"\nExecute one step now.`;
  }
}

// ---------- COMMANDS ----------

// /gpt test
bot.onText(/\/gpt/, async (msg) => {
  if (!hasOpenAI) return safeSend(msg.chat.id, "OpenAI missing.");

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Short. Ruthless." },
        { role: "user", content: "Say System online." },
      ],
    });

    safeSend(msg.chat.id, res.choices[0].message.content.trim());
  } catch (err) {
    logger.error({ event: "openai_error", user_id: String(msg.chat.id), err: err?.message || String(err) });
    safeSend(msg.chat.id, "OpenAI failed.");
  }
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

    safeSend(chatId, summary);
    return;
  }

  // NEW USER FLOW
  user.onboardingStep = "name";
  saveUsers(users);

  safeSend(chatId, BETA_WELCOME_MESSAGE).then(() => {
    safeSend(
      chatId,
      "MindArsenal Coach online.\n" + "Step 1/5 — Name.\nHow do I address you?"
    );
  });
});

// /onboard
bot.onText(/\/onboard/, (msg) => {
  const user = ensureUser(msg);
  user.onboardingStep = "name";
  user.onboarded = false;
  saveUsers(users);

  safeSend(user.chatId, "Onboarding reset.\nStep 1/5 — Name.\nHow do I call you?");
});

// /setgoals
bot.onText(/\/setgoals/, (msg) => {
  const user = ensureUser(msg);
  user.pending = "setgoals";
  saveUsers(users);

  safeSend(user.chatId, "Update mission.\nSend your TOP 3 habits/goals.");
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

  safeSend(user.chatId, txt);
});

// /test_am
bot.onText(/\/test_am/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded) return safeSend(user.chatId, "Complete onboarding first.");

  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  safeSend(user.chatId, AM_PROMPT);
  user.pending = "am";
  user.logs[d].amPromptSent = true;
  saveUsers(users);

  logger.info({ event: "job_fire", job: "am_prompt_manual", user_id: user.chatId });
});

// /test_pm
bot.onText(/\/test_pm/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded) return safeSend(user.chatId, "Complete onboarding first.");

  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  safeSend(user.chatId, PM_PROMPT);
  user.pending = "pm";
  user.logs[d].pmPromptSent = true;
  saveUsers(users);

  logger.info({ event: "job_fire", job: "pm_prompt_manual", user_id: user.chatId });
});

// /test_weekly
bot.onText(/\/test_weekly/, (msg) => {
  const user = ensureUser(msg);
  if (!user.onboarded) return safeSend(user.chatId, "No data yet.");

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

  safeSend(
    user.chatId,
    "Weekly War Report.\n\n" +
      `Last 7 days (to ${todayStr}):\n` +
      `• Execution rate: ${rate}%\n` +
      `• Full days: ${full}/${total}\n\n` +
      "This week is dead.\nThe next one is unbuilt.\nDominate it."
  );

  logger.info({ event: "job_fire", job: "weekly_manual", user_id: user.chatId, rate, full, total });
});

// ---------- MESSAGE ROUTER ----------
bot.on("message", async (msg) => {
  const text = msg.text || "";

  logger.info({
    event: "msg_in",
    user_id: String(msg?.from?.id || ""),
    chat_id: String(msg?.chat?.id || ""),
    has_text: !!msg.text,
    text_len: (text || "").length,
  });

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
      return safeSend(user.chatId, "Step 2/5 — Timezone.\nExample: Europe/Zurich");
    }

    if (step === "timezone") {
      user.timezone = value;
      user.onboardingStep = "habits";
      saveUsers(users);
      return safeSend(user.chatId, "Step 3/5 — Mission.\nSend your TOP 3 habits/goals.");
    }

    if (step === "habits") {
      user.goalsText = value;
      user.habitsText = value;

      logger.info({ event: "habit_save", user_id: user.chatId, changed: ["goalsText", "habitsText"] });

      user.onboardingStep = "amTime";
      saveUsers(users);
      return safeSend(user.chatId, "Step 4/5 — AM time.\nExample: 07:00");
    }

    if (step === "amTime") {
      const t = formatTimeString(value);
      if (!t) return safeSend(user.chatId, "Invalid format. Use HH:MM (24h).");

      user.amTime = t;
      user.onboardingStep = "pmTime";
      saveUsers(users);
      return safeSend(user.chatId, "Step 5/5 — PM time.\nExample: 21:00");
    }

    if (step === "pmTime") {
      const t = formatTimeString(value);
      if (!t) return safeSend(user.chatId, "Invalid format. Use HH:MM (24h).");

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

      return safeSend(user.chatId, summary);
    }
  }

  // SETGOALS flow
  if (user.pending === "setgoals") {
    user.goalsText = text.trim();
    user.habitsText = text.trim();
    user.pending = null;

    logger.info({ event: "habit_save", user_id: user.chatId, changed: ["goalsText", "habitsText"] });

    saveUsers(users);
    return safeSend(user.chatId, "Mission updated:\n" + user.goalsText);
  }

  // AM
  if (user.pending === "am") {
    user.logs[d].am = { text, timestamp: new Date().toISOString() };
    user.pending = null;
    saveUsers(users);

    logger.info({ event: "am_reply", user_id: user.chatId, date: d });

    return safeSend(user.chatId, "Dawn Report logged.\nExecute.");
  }

  // PM
  if (user.pending === "pm") {
    user.logs[d].pm = { text, timestamp: new Date().toISOString() };
    user.pending = null;

    updateDailyStats(user, d);
    saveUsers(users);

    logger.info({ event: "pm_reply", user_id: user.chatId, date: d });

    return safeSend(user.chatId, "Nightly Debrief logged.\nTomorrow the standard rises.");
  }

  // AI fallback
  const reply = await coachReply(user, text);
  safeSend(user.chatId, reply);
});

// ---------- CRON: AM/PM per user ----------
cron.schedule("* * * * *", () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const current = `${hh}:${mm}`;
  const d = todayDate();

  // mark tick so watchdog can detect if cron is dead
  markJob("cron_tick_am_pm", "ok", { current });

  let changed = false;

  Object.values(users).forEach((user) => {
    if (!user.onboarded) return;
    if (!user.logs[d]) user.logs[d] = {};

    const day = user.logs[d];

    if (current === user.amTime && !day.amPromptSent) {
      safeSend(user.chatId, AM_PROMPT);
      user.pending = "am";
      day.amPromptSent = true;

      logger.info({ event: "job_fire", job: "am_prompt", user_id: user.chatId, at: current });

      changed = true;
    }

    if (current === user.pmTime && !day.pmPromptSent) {
      safeSend(user.chatId, PM_PROMPT);
      user.pending = "pm";
      day.pmPromptSent = true;

      logger.info({ event: "job_fire", job: "pm_prompt", user_id: user.chatId, at: current });

      changed = true;
    }
  });

  if (changed) saveUsers(users);
});

// ---------- Watchdog: detect cron stop ----------
cron.schedule("*/5 * * * *", () => {
  const last = runtime.jobs["cron_tick_am_pm"]?.last_at;
  if (!last) return;

  const diffMs = Date.now() - new Date(last).getTime();
  if (diffMs > 6 * 60 * 1000) {
    logger.error({
      event: "watchdog_missed",
      job: "cron_tick_am_pm",
      last_at: last,
      diff_minutes: Math.round(diffMs / 60000),
    });
  }
});

// ---------- CRON: Weekly Report ----------
cron.schedule("0 18 * * 0", () => {
  const today = new Date();
  const todayStr = todayDate();

  markJob("weekly_report", "fired", { when: todayStr });
  logger.info({ event: "job_fire", job: "weekly_report", date: todayStr });

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

    safeSend(
      user.chatId,
      "Weekly War Report.\n\n" +
        `Last 7 days (to ${todayStr}):\n` +
        `• Execution rate: ${rate}%\n` +
        `• Full days: ${full}/${total}\n\n` +
        "This week is dead.\nThe next one is unbuilt.\nDominate it."
    );

    logger.info({ event: "weekly_sent", user_id: user.chatId, rate, full, total });
  });
});

// ---------- Startup Ping ----------
Object.values(users).forEach((user) => {
  safeSend(user.chatId, STARTUP_PING);
});

logger.info({ event: "boot", msg: "MindArsenal bot running. Polling started." });

// ---------- Crash visibility ----------
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "unhandledRejection", reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaughtException", err: err?.stack || err?.message || String(err) });
  process.exit(1);
});
