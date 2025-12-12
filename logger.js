// logger.js
const pino = require("pino");

module.exports = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { app: "mindarsenal-bot" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
