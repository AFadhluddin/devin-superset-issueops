import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_OWNER: z.string().min(1, "GITHUB_OWNER is required"),
  GITHUB_REPO: z.string().default("superset"),
  GITHUB_TARGET_BRANCH: z.string().default("master"),
  DEVIN_API_KEY: z.string().min(1, "DEVIN_API_KEY is required"),
  DEVIN_ORG_ID: z.string().min(1, "DEVIN_ORG_ID is required"),
  DEVIN_CREATE_AS_USER_ID: z.string().optional(),
  TRIGGER_LABEL: z.string().default("devin-remediate"),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
