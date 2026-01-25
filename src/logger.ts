import pino from "pino";
import pinoPretty from "pino-pretty";

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
  },
  pinoPretty({
    colorize: true,
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    ignore: "pid,hostname",
    sync: true,
  })
);
