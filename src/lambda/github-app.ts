import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

import { env } from "../config/env.js";
import { getSecretValue } from "./runtime-secrets.js";

export async function createGitHubApp(): Promise<App> {
  if (!env.GITHUB_APP_ID) {
    throw new Error("GITHUB_APP_ID must be set");
  }

  const privateKey = env.GITHUB_APP_PRIVATE_KEY
    ?? (env.GITHUB_APP_PRIVATE_KEY_ARN ? await getSecretValue(env.GITHUB_APP_PRIVATE_KEY_ARN) : undefined);

  if (!privateKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_ARN must be set");
  }

  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey,
    Octokit,
  });
}
