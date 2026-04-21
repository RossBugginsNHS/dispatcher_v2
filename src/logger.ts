import pino from "pino";

import { env } from "./config/env.js";

const isDevelopment = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});
