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

// ---------- Simple JSON "DB" ----------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "users.json");

function loadUsers() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveUsers(users) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf8");
}

let users = loadUsers();

// Utility: get YYYY-MM-DD
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// Ensure user exists in DB + migrate new fields
function ensureUser(msg) {
  const chatId = String(msg.chat.id);

  if (!users[chatId]) {
    users[chatId] = {
      chatId,
      firstName: msg.chat.first_name || "",
      name: "",
      timezone: "",
      amTime: "07:00",
      pmTime: "21:00",
      goalsText: "",
      habitsText: "",
      pending: null,          // "setgoals" | "am" | "pm" | null
      onboardingStep: null,   // onboarding flow
      onboarded: false,
      logs: {},               // date -> { am, pm, amPromptSent, pmPromptSent, _counted }
      stats: {
        totalDays: 0,         // days with any check-in
        daysWithBoth: 0,      // days with both AM + PM done
        streakCurrent: 0,     // current consecutive full days
        streakBest: 0         // best full-days streak
      },
      weeklyStats: {}         // weekKey -> summary
    };
  } else {
    const u = users[chatId];
    if (!u.amTime) u.amTime = "07:00";
    if (!u.pmTime) u.pmTime = "21:00";
    if (typeof u.onboarded === "undefined") {
      u.onboarded = !!u.goalsText || !!u.habitsText;
    }
    if (!u.logs) u.logs = {};
    if (!u.stats) {
      u.stats = {
        totalDays: 0,
        daysWithBoth: 0,
        streakCurrent: 0,
        streakBest: 0
      };
    }
    if (!u.weeklyStats) {
      u.weeklyStats = {};
    }
  }

  saveUsers(users);
  return users[chatId];
}

// ---------- HELPERS ----------

// time: "HH:MM" 24h
function formatTimeString(text) {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  let m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Update per-day habit stats when day is finished (after PM logged)
function updateDailyStats(user, dateStr) {
  if (!user.logs) return;
  const day = user.logs[dateStr];
  if (!day) return;

  // Avoid double-counting if we already processed this date
  if (day._counted) return;

  if (!user.stats) {
    user.stats = {
      totalDays: 0,
      daysWithBoth: 0,
      streakCurrent: 0,
      streakBest: 0
    };
  }

  // Any check-in = a counted day
  user.stats.totalDays += 1;

  if (day.am && day.pm) {
    // fully completed day
    user.stats.daysWithBoth += 1;
    user.stats.streakCurrent += 1;
    if (user.stats.streakCurrent > user.stats.streakBest) {
      user.stats.streakBest = user.stats.streakCurrent;
    }
  } else {
    // only AM or only PM -> streak broken
    user.stats.streakCurrent = 0;
  }

  day._counted = true;
}

// AI coach reply for normal chat
async function coachReply(user, userText) {
  const name = user.name || user.firstName || "warrior";
  const goals = user.goalsText || user.habitsText || "No mission defined yet.";

  // Local fallback in case OpenAI fails
  const localFallback = (extraLine = "") => {
    return (
      `${name}, higher systems are offline.\n` +
      (extraLine ? extraLine + "\n\n" : "") +
      `Your current mission:\n${goals}\n\n` +
      `You wrote:\n"${userText}"\n\n` +
      "Pick one concrete action that moves your mission forward.\n" +
      "Execute it now."
    );
  };

  if (!hasOpenAI) {
    return localFallback("OpenAI key missing or not loaded.");
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Trainee name: ${name}.\n` +
            `Current habits / goals:\n${goals}\n\n` +
            `Message from trainee:\n${userText}`
        }
      ]
    });

    const text = completion.choices[0].message.content?.trim?.() ?? "";
    return text || localFallback("OpenAI returned an empty reply.");
  } catch (err) {
    console.error("OpenAI coachReply error:", err);
    const msg = (err && err.message) ? err.message : String(err);
    return localFallback("OpenAI error: " + msg);
  }
}

// ---------- COMMANDS ----------

// /gpt – direct OpenAI test
bot.onText(/\/gpt/, async (msg) => {
  if (!hasOpenAI) {
    bot.sendMessage(
      msg.chat.id,
      "DEBUG: hasOpenAI = false. OPENAI_API_KEY missing or not loaded."
    );
    return;
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Reply in 1–2 ruthless lines. No emojis." },
        { role: "user", content: "Say 'System online' in your style." }
      ]
    });

    const out = res.choices?.[0]?.message?.content?.trim() || "(empty response)";
    bot.sendMessage(msg.chat.id, "GPT TEST:\n\n" + out);
  } catch (err) {
    console.error("OpenAI /gpt test error:", err);
    bot.sendMessage(
      msg.chat.id,
      "GPT TEST ERROR: " + (err.message || String(err))
    );
  }
});

// /start – new users: onboarding; existing users: summary
bot.onText(/\/start/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  if (user.onboarded) {
    const stats = user.stats || {};
    const summary =
      "MindArsenal Coach online.\n" +
      "You are enlisted.\n\n" +
      `Name: ${user.name || user.firstName || "not set"}\n` +
      `Zone: ${user.timezone || "not set"}\n` +
      `AM check-in: ${user.amTime}\n` +
      `PM check-in: ${user.pmTime}\n\n` +
      `Mission:\n${user.goalsText || "not set"}\n\n` +
      "Discipline:\n" +
      `• Full execution days (AM+PM): ${stats.daysWithBoth || 0}/${stats.totalDays || 0}\n` +
      `• Current full-day streak: ${stats.streakCurrent || 0}\n` +
      `• Best streak: ${stats.streakBest || 0}\n\n` +
      "Use /onboard to reconfigure or /setgoals to update your mission.";
    bot.sendMessage(chatId, summary);
    return;
  }

  user.onboardingStep = "name";
  user.pending = null;
  saveUsers(users);

  bot.sendMessage(
    chatId,
    "MindArsenal Coach online.\n" +
      "You are entering active training.\n\n" +
      "Step 1/5 — Name.\n" +
      "How do I call you in reports?"
  );
});

// /onboard – force re-run onboarding
bot.onText(/\/onboard/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  user.onboardingStep = "name";
  user.onboarded = false;
  user.pending = null;
  saveUsers(users);

  bot.sendMessage(
    chatId,
    "Onboarding reset.\n\n" +
      "Step 1/5 — Name.\n" +
      "How do I call you in reports?"
  );
});

// /setgoals – update only habits/goals later
bot.onText(/\/setgoals/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  user.pending = "setgoals";
  saveUsers(users);

  bot.sendMessage(
    chatId,
    "Update mission.\n\n" +
      "Send your TOP 3 habits or goals in one message.\n" +
      "Only what matters."
  );
});

// /status – today’s AM / PM status + all-time stats
bot.onText(/\/status/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  const d = todayDate();
  const dayLog = user.logs[d] || {};

  const amStatus = dayLog.am ? "DONE" : "MISSING";
  const pmStatus = dayLog.pm ? "DONE" : "MISSING";

  const stats = user.stats || {};
  const total = stats.totalDays || 0;
  const full = stats.daysWithBoth || 0;
  const streak = stats.streakCurrent || 0;
  const best = stats.streakBest || 0;

  const msgText =
    `Status for ${d}:\n` +
    `AM Dawn Report: ${amStatus}\n` +
    `PM Nightly Debrief: ${pmStatus}\n\n` +
    `All-time discipline:\n` +
    `• Full execution days (AM+PM): ${full}/${total}\n` +
    `• Current full-day streak: ${streak}\n` +
    `• Best streak: ${best}`;

  bot.sendMessage(chatId, msgText);
});

// /test_am – manual trigger of Dawn Report for debugging
bot.onText(/\/test_am/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;
  const today = todayDate();

  if (!user.onboarded) {
    bot.sendMessage(
      chatId,
      "Protocol not armed.\nComplete onboarding with /onboard first."
    );
    return;
  }

  if (!user.logs[today]) user.logs[today] = {};
  const dayLog = user.logs[today];

  bot.sendMessage(chatId, AM_PROMPT);

  user.pending = "am";
  dayLog.amPromptSent = true;
  saveUsers(users);
});

// /test_pm – manual trigger of Nightly Debrief for debugging
bot.onText(/\/test_pm/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;
  const today = todayDate();

  if (!user.onboarded) {
    bot.sendMessage(
      chatId,
      "Protocol not armed.\nComplete onboarding with /onboard first."
    );
    return;
  }

  if (!user.logs[today]) user.logs[today] = {};
  const dayLog = user.logs[today];

  bot.sendMessage(chatId, PM_PROMPT);

  user.pending = "pm";
  dayLog.pmPromptSent = true;
  saveUsers(users);
});

// /test_weekly – generate Weekly War Report for last 7 days for this user
bot.onText(/\/test_weekly/, (msg) => {
  const user = ensureUser(msg);
  const chatId = user.chatId;

  if (!user.onboarded) {
    bot.sendMessage(
      chatId,
      "No data.\nComplete onboarding and execute for a few days first."
    );
    return;
  }

  const today = new Date();
  const todayStr = todayDate();
  const logs = user.logs || {};
  const dates = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  let completedDays = 0;
  let totalDays = 0;

  dates.forEach((d) => {
    if (logs[d]) {
      totalDays++;
      if (logs[d].am && logs[d].pm) completedDays++;
    }
  });

  const habitExecutionRate =
    totalDays === 0 ? 0 : Math.round((completedDays / totalDays) * 100);

  const weekMsg =
    "Weekly War Report.\n\n" +
    `Last 7 days (up to ${todayStr}):\n` +
    `• Execution rate: ${habitExecutionRate}%\n` +
    `• Full execution days: ${completedDays}/${totalDays}\n\n` +
    "This week is dead.\n" +
    "The next one is unbuilt.\n" +
    "Dominate it.";

  bot.sendMessage(chatId, weekMsg);
});

// ---------- MESSAGE ROUTER ----------

bot.on("message", async (msg) => {
  const text = msg.text || "";
  if (text.startsWith("/")) return; // commands handled above

  const user = ensureUser(msg);
  const chatId = user.chatId;
  const today = todayDate();

  if (!user.logs[today]) user.logs[today] = user.logs[today] || {};

  // ----- 1) ONBOARDING FLOW -----
  if (user.onboardingStep) {
    const step = user.onboardingStep;
    const value = text.trim();

    if (step === "name") {
      user.name = value || user.firstName || "";
      user.onboardingStep = "timezone";
      saveUsers(users);

      bot.sendMessage(
        chatId,
        "Step 2/5 — Timezone.\n" +
          "Type your timezone.\n" +
          "Example: Europe/Zurich"
      );
      return;
    }

    if (step === "timezone") {
      user.timezone = value;
      user.onboardingStep = "habits";
      saveUsers(users);

      bot.sendMessage(
        chatId,
        "Step 3/5 — Mission.\n" +
          "Write your TOP 3 habits or goals in one message.\n\n" +
          "Example:\n" +
          "1) Train 5× per week\n" +
          "2) Build MindArsenal\n" +
          "3) Study 1h daily"
      );
      return;
    }

    if (step === "habits") {
      user.habitsText = value;
      user.goalsText = value;
      user.onboardingStep = "amTime";
      saveUsers(users);

      bot.sendMessage(
        chatId,
        "Step 4/5 — AM time.\n" +
          "When should Dawn Report hit you?\n" +
          "Use 24h format HH:MM.\n" +
          "Example: 07:00"
      );
      return;
    }

    if (step === "amTime") {
      const formatted = formatTimeString(value);
      if (!formatted) {
        bot.sendMessage(
          chatId,
          "Invalid time format.\n" +
            "Use HH:MM in 24h format.\n" +
            "Examples: 06:30, 07:00, 09:15."
        );
        return;
      }
      user.amTime = formatted;
      user.onboardingStep = "pmTime";
      saveUsers(users);

      bot.sendMessage(
        chatId,
        "Step 5/5 — PM time.\n" +
          "When should Nightly Debrief hit you?\n" +
          "Use 24h format HH:MM.\n" +
          "Example: 21:00"
      );
      return;
    }

    if (step === "pmTime") {
      const formatted = formatTimeString(value);
      if (!formatted) {
        bot.sendMessage(
          chatId,
          "Invalid time format.\n" +
            "Use HH:MM in 24h format.\n" +
            "Examples: 20:00, 21:30, 22:00."
        );
        return;
      }
      user.pmTime = formatted;
      user.onboardingStep = null;
      user.onboarded = true;
      saveUsers(users);

      const summary =
        "Onboarding complete.\n" +
        "Protocol armed.\n\n" +
        `Name: ${user.name || user.firstName}\n` +
        `Zone: ${user.timezone}\n` +
        `AM check-in: ${user.amTime}\n` +
        `PM check-in: ${user.pmTime}\n\n` +
        `Mission:\n${user.goalsText}\n\n` +
        "Dawn and Nightly reports will hit at your times.\n" +
        "You report. No excuses.";
      bot.sendMessage(chatId, summary);
      return;
    }
  }

  // ----- 2) OTHER PENDING STATES -----

  // /setgoals flow
  if (user.pending === "setgoals") {
    user.goalsText = text.trim();
    user.habitsText = text.trim();
    user.pending = null;
    saveUsers(users);

    bot.sendMessage(
      chatId,
      "Mission updated.\n\n" +
        "Current top habits / goals:\n" +
        user.goalsText
    );
    return;
  }

  // AM answer
  if (user.pending === "am") {
    user.logs[today].am = {
      text: text.trim(),
      timestamp: new Date().toISOString()
    };
    user.pending = null;
    saveUsers(users);

    bot.sendMessage(
      chatId,
      "Dawn Report logged.\n" +
        "Prioritize. Execute.\n" +
        "Zero hesitation."
    );
    return;
  }

  // PM answer
  if (user.pending === "pm") {
    user.logs[today].pm = {
      text: text.trim(),
      timestamp: new Date().toISOString()
    };
    user.pending = null;

    // Update all-time stats when a day is “closed” with PM
    updateDailyStats(user, today);

    saveUsers(users);

    bot.sendMessage(
      chatId,
      "Nightly Debrief logged.\n" +
        "Success or failure — you own it.\n" +
        "Tomorrow the standard rises."
    );
    return;
  }

  // ----- 3) Fallback → Master Asmo brain -----
  const reply = await coachReply(user, text);
  bot.sendMessage(chatId, reply);
});

// ---------- CRON: AM/PM per user (check every minute) ----------

cron.schedule("* * * * *", () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const currentTime = `${hh}:${mm}`;
  const today = todayDate();

  let changed = false;

  Object.values(users).forEach((user) => {
    if (!user.onboarded) return;

    if (!user.logs[today]) user.logs[today] = user.logs[today] || {};
    const dayLog = user.logs[today];

    // AM check
    const amTime = user.amTime || "07:00";
    if (currentTime === amTime && !dayLog.amPromptSent) {
      bot.sendMessage(user.chatId, AM_PROMPT);
      user.pending = "am";
      dayLog.amPromptSent = true;
      changed = true;
    }

    // PM check
    const pmTime = user.pmTime || "21:00";
    if (currentTime === pmTime && !dayLog.pmPromptSent) {
      bot.sendMessage(user.chatId, PM_PROMPT);
      user.pending = "pm";
      dayLog.pmPromptSent = true;
      changed = true;
    }
  });

  if (changed) {
    saveUsers(users);
  }
});

// ---------- CRON: Weekly War Report (Sunday 18:00) ----------

cron.schedule("0 18 * * 0", () => {
  const today = new Date();
  const todayStr = todayDate();

  Object.values(users).forEach((user) => {
    if (!user.onboarded) return;

    const logs = user.logs || {};
    const dates = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    let completedDays = 0;
    let totalDays = 0;

    dates.forEach((d) => {
      if (logs[d]) {
        totalDays++;
        if (logs[d].am && logs[d].pm) completedDays++;
      }
    });

    const habitExecutionRate =
      totalDays === 0 ? 0 : Math.round((completedDays / totalDays) * 100);

    const weekMsg =
      "Weekly War Report.\n\n" +
      `Last 7 days (up to ${todayStr}):\n` +
      `• Execution rate: ${habitExecutionRate}%\n` +
      `• Full execution days: ${completedDays}/${totalDays}\n\n` +
      "This week is dead.\n" +
      "The next one is unbuilt.\n" +
      "Dominate it.";

    bot.sendMessage(user.chatId, weekMsg);

    // Save weekly snapshot in JSON
    const datesSorted = [...dates].sort(); // oldest -> newest
    const weekKey = `${datesSorted[0]}_${datesSorted[datesSorted.length - 1]}`;
    if (!user.weeklyStats) user.weeklyStats = {};
    user.weeklyStats[weekKey] = {
      startDate: datesSorted[0],
      endDate: datesSorted[datesSorted.length - 1],
      habitExecutionRate,
      completedDays,
      totalDays,
      generatedAt: new Date().toISOString()
    };
  });

  saveUsers(users);
});

// ---------- Startup ping ----------
Object.values(users).forEach((user) => {
  bot.sendMessage(user.chatId, STARTUP_PING);
});

console.log("MindArsenal bot running. Polling started.");
