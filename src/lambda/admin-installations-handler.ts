import pino from "pino";

import { env } from "../config/env.js";
import { createGitHubApp } from "./github-app.js";

const log = pino({ level: env.LOG_LEVEL });

type ApiGatewayV2Event = {
  rawPath: string;
};

type ApiGatewayV2Response = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

type AppsOctokit = {
  rest: {
    apps: {
      listReposAccessibleToInstallation(params: { per_page: number }): Promise<{
        data: {
          repositories: Array<{ full_name: string }>;
        };
      }>;
    };
  };
};

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> {
  if (event.rawPath !== "/admin/installations") {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Not Found" }),
    };
  }

  const app = await createGitHubApp();
  const installations: Array<{ installationId: number; account: string; repos: string[] }> = [];

  for await (const { installation } of app.eachInstallation.iterator()) {
    const octokit = (await app.getInstallationOctokit(installation.id)) as unknown as AppsOctokit;
    const repos = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });

    installations.push({
      installationId: installation.id,
      account: installation.account && "login" in installation.account
        ? installation.account.login
        : String(installation.id),
      repos: repos.data.repositories.map((repo) => repo.full_name),
    });
  }

  log.info({ count: installations.length }, "Listed GitHub app installations");

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ installations }),
  };
}
