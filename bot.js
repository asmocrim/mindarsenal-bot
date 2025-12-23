// bot.js
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const logger = require("./logger");

// ---------- ENV ----------
const disableTelegram = process.env.DISABLE_TELEGRAM_POLLING === "true";
const disableCron = process.env.DISABLE_CRON === "true";

const token = process.env.BOT_TOKEN;

// Log env presence (not values)
logger.info({
  event: "env",
  DISABLE_TELEGRAM_POLLING: disableTelegram,
  DISABLE_CRON: disableCron,
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  BOT_TOKEN: !!process.env.BOT_TOKEN,
  TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM: !!process.env.TWILIO_WHATSAPP_FROM,
});

// Only require BOT_TOKEN if Telegram polling is enabled
if (!token && !disableTelegram) {
  logger.fatal({ event: "fatal", msg: "BOT_TOKEN missing but Telegram polling enabled" });
  process.exit(1);
}

// ---------- Telegram ----------
const bot = disableTelegram ? null : new TelegramBot(token, { polling: true });

// ---------- OpenAI ----------
const hasOpenAI = !!process.env.OPENAI_API_KEY;
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const OPENAI_MODEL = "gpt-4o-mini";

// ---------- Twilio WhatsApp ----------
const hasTwilio =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_WHATSAPP_FROM;

const twilioClient = hasTwilio
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ""; // "whatsapp:+14155238886"

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

function normalizeWhatsAppFrom(from) {
  // "whatsapp:+4179..." -> "+4179..."
  if (!from) return "";
  return String(from).replace("whatsapp:", "").trim();
}

// ---------- User Model (supports Telegram + WhatsApp) ----------
function ensureUserByKey(userKey, defaults = {}) {
  if (!users[userKey]) {
    users[userKey] = {
      userKey,

      // channels
      telegramChatId: defaults.telegramChatId || null,
      whatsappFrom: defaults.whatsappFrom || null,

      firstName: defaults.firstName || "",
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

    logger.info({ event: "user_new", user_key: userKey });
    saveUsers(users);
  }

  // keep channel ids updated if provided
  if (defaults.telegramChatId && !users[userKey].telegramChatId) {
    users[userKey].telegramChatId = defaults.telegramChatId;
  }
  if (defaults.whatsappFrom && !users[userKey].whatsappFrom) {
    users[userKey].whatsappFrom = defaults.whatsappFrom;
  }

  saveUsers(users);
  return users[userKey];
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

// ---------- Sending (Telegram + WhatsApp) ----------
async function safeSendTelegram(chatId, text, extra = {}) {
  if (!bot) {
    logger.warn({ event: "send_skip", channel: "telegram", reason: "telegram_disabled" });
    return null;
  }

  try {
    const res = await bot.sendMessage(chatId, text, extra);

    runtime.counters.send_ok++;
    saveRuntime(runtime);

    logger.info({
      event: "msg_out",
      channel: "telegram",
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
      channel: "telegram",
      chat_id: String(chatId),
      err: err?.message || String(err),
    });

    throw err;
  }
}

async function safeSendWhatsApp(whatsappTo, text) {
  if (!hasTwilio) {
    logger.warn({ event: "twilio_missing", msg: "Twilio env vars missing." });
    throw new Error("Twilio missing");
  }

  try {
    const toFormatted = `whatsapp:${whatsappTo.startsWith("+") ? whatsappTo : "+" + whatsappTo}`;
    const res = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: toFormatted,
      body: text,
    });

    runtime.counters.send_ok++;
    saveRuntime(runtime);

    logger.info({
      event: "msg_out",
      channel: "whatsapp",
      to: whatsappTo,
      sid: res?.sid,
      text_len: (text || "").length,
    });

    return res;
  } catch (err) {
    runtime.counters.send_err++;
    saveRuntime(runtime);

    logger.error({
      event: "send_error",
      channel: "whatsapp",
      to: whatsappTo,
      err: err?.message || String(err),
    });

    throw err;
  }
}

// Send to user's available channel(s).
// For scheduled prompts we send to BOTH if user has both.
async function sendToUser(user, text) {
  const tasks = [];

  if (user.telegramChatId) tasks.push(safeSendTelegram(user.telegramChatId, text));
  if (user.whatsappFrom) tasks.push(safeSendWhatsApp(user.whatsappFrom, text));

  if (tasks.length === 0) {
    logger.warn({ event: "send_skip", user_key: user.userKey, reason: "no_channels" });
    return;
  }

  await Promise.allSettled(tasks);
}

// ---------- AI Reply ----------
async function coachReply(user, text) {
  const name = user.name || user.firstName || "warrior";
  const goals = user.goalsText || user.habitsText || "No mission defined.";

  if (!hasOpenAI) {
    logger.warn({ event: "openai_missing", user_key: user.userKey });
    return `${name}, system offline.\nYour mission:\n${goals}`;
  }

  try {
    logger.info({
      event: "openai_call",
      user_key: user.userKey,
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
      user_key: user.userKey,
      err: err?.message || String(err),
    });

    return `${name}, OpenAI failed.\nMessage:\n"${text}"\nExecute one step now.`;
  }
}

// ---------- Core message handler (shared by Telegram + WhatsApp) ----------
async function handleIncoming({ channel, user, text }) {
  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  const clean = (text || "").trim();
  const lowered = clean.toLowerCase();

  // START equivalent for WhatsApp (and optional for Telegram non-slash)
  const isStartWord = ["start", "help", "menu"].includes(lowered);
  const isSlashStart = lowered === "/start";

  // ---------- Start flow ----------
  if (
    (channel === "whatsapp" && (isStartWord || isSlashStart)) ||
    (channel === "telegram" && lowered === "/start")
  ) {
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

      await sendToUser(user, summary);
      return;
    }

    user.onboardingStep = "name";
    saveUsers(users);

    await sendToUser(user, BETA_WELCOME_MESSAGE);
    await sendToUser(user, "MindArsenal Coach online.\nStep 1/5 — Name.\nHow do I address you?");
    return;
  }

  // Telegram-only slash commands (keep your behavior)
  if (channel === "telegram" && clean.startsWith("/")) return;

  // ---------- ONBOARDING FLOW ----------
  if (user.onboardingStep) {
    const step = user.onboardingStep;
    const value = clean;

    if (step === "name") {
      user.name = value;
      user.onboardingStep = "timezone";
      saveUsers(users);
      await sendToUser(user, "Step 2/5 — Timezone.\nExample: Europe/Zurich");
      return;
    }

    if (step === "timezone") {
      user.timezone = value;
      user.onboardingStep = "habits";
      saveUsers(users);
      await sendToUser(user, "Step 3/5 — Mission.\nSend your TOP 3 habits/goals.");
      return;
    }

    if (step === "habits") {
      user.goalsText = value;
      user.habitsText = value;

      logger.info({ event: "habit_save", user_key: user.userKey, changed: ["goalsText", "habitsText"] });

      user.onboardingStep = "amTime";
      saveUsers(users);
      await sendToUser(user, "Step 4/5 — AM time.\nExample: 07:00");
      return;
    }

    if (step === "amTime") {
      const t = formatTimeString(value);
      if (!t) {
        await sendToUser(user, "Invalid format. Use HH:MM (24h).");
        return;
      }

      user.amTime = t;
      user.onboardingStep = "pmTime";
      saveUsers(users);
      await sendToUser(user, "Step 5/5 — PM time.\nExample: 21:00");
      return;
    }

    if (step === "pmTime") {
      const t = formatTimeString(value);
      if (!t) {
        await sendToUser(user, "Invalid format. Use HH:MM (24h).");
        return;
      }

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

      await sendToUser(user, summary);
      return;
    }
  }

  // ---------- SETGOALS flow ----------
  if (user.pending === "setgoals") {
    user.goalsText = clean;
    user.habitsText = clean;
    user.pending = null;

    logger.info({ event: "habit_save", user_key: user.userKey, changed: ["goalsText", "habitsText"] });

    saveUsers(users);
    await sendToUser(user, "Mission updated:\n" + user.goalsText);
    return;
  }

  // AM
  if (user.pending === "am") {
    user.logs[d].am = { text: clean, timestamp: new Date().toISOString() };
    user.pending = null;
    saveUsers(users);

    logger.info({ event: "am_reply", user_key: user.userKey, date: d });

    await sendToUser(user, "Dawn Report logged.\nExecute.");
    return;
  }

  // PM
  if (user.pending === "pm") {
    user.logs[d].pm = { text: clean, timestamp: new Date().toISOString() };
    user.pending = null;

    updateDailyStats(user, d);
    saveUsers(users);

    logger.info({ event: "pm_reply", user_key: user.userKey, date: d });

    await sendToUser(user, "Nightly Debrief logged.\nTomorrow the standard rises.");
    return;
  }

  // ---------- AI fallback ----------
  const reply = await coachReply(user, clean);
  await sendToUser(user, reply);
}

// ---------- TELEGRAM (ONLY if bot exists) ----------
if (bot) {
  // /gpt test
  bot.onText(/\/gpt/, async (msg) => {
    if (!hasOpenAI) return safeSendTelegram(msg.chat.id, "OpenAI missing.");

    try {
      const res = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: "Short. Ruthless." },
          { role: "user", content: "Say System online." },
        ],
      });

      safeSendTelegram(msg.chat.id, res.choices[0].message.content.trim());
    } catch (err) {
      logger.error({ event: "openai_error", user_key: `tg:${String(msg.chat.id)}`, err: err?.message || String(err) });
      safeSendTelegram(msg.chat.id, "OpenAI failed.");
    }
  });

  // /start -> shared handler
  bot.onText(/\/start/, async (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    await handleIncoming({ channel: "telegram", user, text: "/start" });
  });

  // /onboard
  bot.onText(/\/onboard/, async (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    user.onboardingStep = "name";
    user.onboarded = false;
    saveUsers(users);

    safeSendTelegram(user.telegramChatId, "Onboarding reset.\nStep 1/5 — Name.\nHow do I call you?");
  });

  // /setgoals
  bot.onText(/\/setgoals/, async (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    user.pending = "setgoals";
    saveUsers(users);

    safeSendTelegram(user.telegramChatId, "Update mission.\nSend your TOP 3 habits/goals.");
  });

  // /status
  bot.onText(/\/status/, (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

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

    safeSendTelegram(user.telegramChatId, txt);
  });

  // /test_am
  bot.onText(/\/test_am/, (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    if (!user.onboarded) return safeSendTelegram(user.telegramChatId, "Complete onboarding first.");

    const d = todayDate();
    if (!user.logs[d]) user.logs[d] = {};

    sendToUser(user, AM_PROMPT);
    user.pending = "am";
    user.logs[d].amPromptSent = true;
    saveUsers(users);

    logger.info({ event: "job_fire", job: "am_prompt_manual", user_key: user.userKey });
  });

  // /test_pm
  bot.onText(/\/test_pm/, (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    if (!user.onboarded) return safeSendTelegram(user.telegramChatId, "Complete onboarding first.");

    const d = todayDate();
    if (!user.logs[d]) user.logs[d] = {};

    sendToUser(user, PM_PROMPT);
    user.pending = "pm";
    user.logs[d].pmPromptSent = true;
    saveUsers(users);

    logger.info({ event: "job_fire", job: "pm_prompt_manual", user_key: user.userKey });
  });

  // /test_weekly
  bot.onText(/\/test_weekly/, (msg) => {
    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    if (!user.onboarded) return safeSendTelegram(user.telegramChatId, "No data yet.");

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

    sendToUser(
      user,
      "Weekly War Report.\n\n" +
        `Last 7 days (to ${todayStr}):\n` +
        `• Execution rate: ${rate}%\n` +
        `• Full days: ${full}/${total}\n\n` +
        "This week is dead.\nThe next one is unbuilt.\nDominate it."
    );

    logger.info({ event: "job_fire", job: "weekly_manual", user_key: user.userKey, rate, full, total });
  });

  // Telegram message router -> shared handler
  bot.on("message", async (msg) => {
    const text = msg.text || "";

    logger.info({
      event: "msg_in",
      channel: "telegram",
      user_id: String(msg?.from?.id || ""),
      chat_id: String(msg?.chat?.id || ""),
      has_text: !!msg.text,
      text_len: (text || "").length,
    });

    const userKey = `tg:${String(msg.chat.id)}`;
    const user = ensureUserByKey(userKey, {
      telegramChatId: String(msg.chat.id),
      firstName: msg.chat.first_name || "",
    });

    await handleIncoming({ channel: "telegram", user, text });
  });

  bot.on("polling_error", (err) => {
    logger.error({ event: "polling_error", err: err?.message || String(err) });
  });
}

// ---------- WhatsApp Webhook Server ----------
const app = express();

// Twilio posts application/x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));

// Health check (useful on Render)
app.get("/health", (req, res) => res.status(200).send("OK"));

// Twilio inbound webhook
app.post("/webhooks/whatsapp", async (req, res) => {
  try {
    const fromRaw = req.body.From || ""; // "whatsapp:+41..."
    const body = (req.body.Body || "").trim();

    const fromPhone = normalizeWhatsAppFrom(fromRaw);
    const userKey = `wa:${fromPhone}`;

    logger.info({
      event: "msg_in",
      channel: "whatsapp",
      from: fromPhone,
      text_len: (body || "").length,
    });

    const user = ensureUserByKey(userKey, {
      whatsappFrom: fromPhone,
      firstName: "",
    });

    const replyText = await handleIncomingWhatsAppReturnText(user, body);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(replyText || "Stand by. Retry.");
    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    logger.error({ event: "whatsapp_webhook_error", err: e?.message || String(e) });
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("System fault. Retry. Stay sharp.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Return ONE reply for webhook response (avoid double-sends)
async function handleIncomingWhatsAppReturnText(user, text) {
  const d = todayDate();
  if (!user.logs[d]) user.logs[d] = {};

  const clean = (text || "").trim();
  const lowered = clean.toLowerCase();

  const isStart = ["start", "/start", "help", "menu"].includes(lowered);

  if (isStart) {
    if (user.onboarded) {
      const s = user.stats;
      return (
        "MindArsenal Coach online.\nYou are enlisted.\n\n" +
        `Name: ${user.name || user.firstName || "warrior"}\n` +
        `Zone: ${user.timezone}\n` +
        `AM: ${user.amTime}\nPM: ${user.pmTime}\n\n` +
        `Mission:\n${user.goalsText}\n\n` +
        "Discipline:\n" +
        `• Full execution days: ${s.daysWithBoth}/${s.totalDays}\n` +
        `• Current streak: ${s.streakCurrent}\n` +
        `• Best streak: ${s.streakBest}`
      );
    }

    user.onboardingStep = "name";
    saveUsers(users);
    return BETA_WELCOME_MESSAGE + "\n\nStep 1/5 — Name.\nHow do I address you?";
  }

  // ONBOARDING
  if (user.onboardingStep) {
    const step = user.onboardingStep;
    const value = clean;

    if (step === "name") {
      user.name = value;
      user.onboardingStep = "timezone";
      saveUsers(users);
      return "Step 2/5 — Timezone.\nExample: Europe/Zurich";
    }

    if (step === "timezone") {
      user.timezone = value;
      user.onboardingStep = "habits";
      saveUsers(users);
      return "Step 3/5 — Mission.\nSend your TOP 3 habits/goals.";
    }

    if (step === "habits") {
      user.goalsText = value;
      user.habitsText = value;
      user.onboardingStep = "amTime";
      saveUsers(users);
      return "Step 4/5 — AM time.\nExample: 07:00";
    }

    if (step === "amTime") {
      const t = formatTimeString(value);
      if (!t) return "Invalid format. Use HH:MM (24h).";
      user.amTime = t;
      user.onboardingStep = "pmTime";
      saveUsers(users);
      return "Step 5/5 — PM time.\nExample: 21:00";
    }

    if (step === "pmTime") {
      const t = formatTimeString(value);
      if (!t) return "Invalid format. Use HH:MM (24h).";
      user.pmTime = t;
      user.onboardingStep = null;
      user.onboarded = true;
      saveUsers(users);

      return (
        "Onboarding complete.\nProtocol armed.\n\n" +
        `Name: ${user.name}\n` +
        `Zone: ${user.timezone}\n` +
        `AM: ${user.amTime}\nPM: ${user.pmTime}\n\n` +
        `Mission:\n${user.goalsText}\n\n` +
        "Reports will hit at your times.\nRespond. No excuses."
      );
    }
  }

  // Pending flows
  if (user.pending === "setgoals") {
    user.goalsText = clean;
    user.habitsText = clean;
    user.pending = null;
    saveUsers(users);
    return "Mission updated:\n" + user.goalsText;
  }

  if (user.pending === "am") {
    user.logs[d].am = { text: clean, timestamp: new Date().toISOString() };
    user.pending = null;
    saveUsers(users);
    return "Dawn Report logged.\nExecute.";
  }

  if (user.pending === "pm") {
    user.logs[d].pm = { text: clean, timestamp: new Date().toISOString() };
    user.pending = null;
    updateDailyStats(user, d);
    saveUsers(users);
    return "Nightly Debrief logged.\nTomorrow the standard rises.";
  }

  // AI
  const reply = await coachReply(user, clean);
  return reply;
}

// Start Express server (Render needs this for Web Service)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ event: "http_listen", port: PORT });
});

// ---------- CRON (ONLY if not disabled) ----------
if (!disableCron) {
  // ---------- CRON: AM/PM per user ----------
  cron.schedule("* * * * *", () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const current = `${hh}:${mm}`;
    const d = todayDate();

    markJob("cron_tick_am_pm", "ok", { current });

    let changed = false;

    Object.values(users).forEach((user) => {
      if (!user.onboarded) return;
      if (!user.logs[d]) user.logs[d] = {};

      const day = user.logs[d];

      if (current === user.amTime && !day.amPromptSent) {
        sendToUser(user, AM_PROMPT);
        user.pending = "am";
        day.amPromptSent = true;
        logger.info({ event: "job_fire", job: "am_prompt", user_key: user.userKey, at: current });
        changed = true;
      }

      if (current === user.pmTime && !day.pmPromptSent) {
        sendToUser(user, PM_PROMPT);
        user.pending = "pm";
        day.pmPromptSent = true;
        logger.info({ event: "job_fire", job: "pm_prompt", user_key: user.userKey, at: current });
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

      sendToUser(
        user,
        "Weekly War Report.\n\n" +
          `Last 7 days (to ${todayStr}):\n` +
          `• Execution rate: ${rate}%\n` +
          `• Full days: ${full}/${total}\n\n` +
          "This week is dead.\nThe next one is unbuilt.\nDominate it."
      );

      logger.info({ event: "weekly_sent", user_key: user.userKey, rate, full, total });
    });
  });
} else {
  logger.info({ event: "cron_disabled" });
}

// ---------- Startup Ping (Telegram only) ----------
if (bot) {
  Object.values(users).forEach((user) => {
    if (user.telegramChatId) safeSendTelegram(user.telegramChatId, STARTUP_PING);
  });
}

logger.info({
  event: "boot",
  msg: `MindArsenal running. http=${PORT} telegram_polling=${!!bot} cron=${!disableCron}`,
});

// ---------- Crash visibility ----------
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "unhandledRejection", reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaughtException", err: err?.stack || err?.message || String(err) });
  process.exit(1);
});
