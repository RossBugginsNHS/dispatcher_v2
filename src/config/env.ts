import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  APP_VERSION: z.string().default("local"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET_ARN: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_ARN: z.string().optional(),
  DISPATCH_REQUESTS_QUEUE_URL: z.string().optional(),
  DISPATCH_TARGETS_QUEUE_URL: z.string().optional(),
  DISPATCH_FACTS_EVENT_BUS_NAME: z.string().optional(),
  DEFAULT_DISPATCH_REF: z.string().default("main"),
  CREATE_ISSUES: z.coerce.boolean().default(true),
  DISPATCH_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  DISPATCH_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(200),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
