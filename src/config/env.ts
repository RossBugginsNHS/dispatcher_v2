import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  DEFAULT_DISPATCH_REF: z.string().default("main"),
  CREATE_ISSUES: z.coerce.boolean().default(true),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
