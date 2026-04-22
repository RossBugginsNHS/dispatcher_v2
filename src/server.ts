import type { App } from "@octokit/app";
import Fastify from "fastify";

import { env } from "./config/env.js";
import type { WorkflowRunEventContext, WorkflowRunPayload } from "./github/types.js";
import { registerGitHubWebhookHandler } from "./github/webhook-handler.js";
import type { DispatchEventStore } from "./services/dispatch-event-store.js";

type BuildServerOptions = {
  githubWebhookSecret?: string;
  githubApp?: App;
  eventStore?: DispatchEventStore;
  onWorkflowRunCompleted?: (
    payload: WorkflowRunPayload,
    context: WorkflowRunEventContext,
  ) => Promise<void> | void;
};

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger: true,
  });

  app.get("/health", () => {
    return { status: "ok" };
  });

  app.get("/admin/installations", async () => {
    if (!options.githubApp) {
      return { error: "GitHub App not configured" };
    }
    type AppsOctokit = { rest: { apps: { listReposAccessibleToInstallation(p: { per_page: number }): Promise<{ data: { repositories: { full_name: string }[] } }> } } };
    const installations: { installationId: number; account: string; repos: string[] }[] = [];
    for await (const { installation } of options.githubApp.eachInstallation.iterator()) {
      const octokit = (await options.githubApp.getInstallationOctokit(installation.id)) as unknown as AppsOctokit;
      const reposResp = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
      installations.push({
        installationId: installation.id,
        account: installation.account && "login" in installation.account
          ? installation.account.login
          : String(installation.id),
        repos: reposResp.data.repositories.map((r) => r.full_name),
      });
    }
    return { installations };
  });

  app.get("/admin/logs", () => {
    const events = options.eventStore?.list() ?? [];
    return { count: events.length, events };
  });

  const webhookSecret = options.githubWebhookSecret ?? env.GITHUB_WEBHOOK_SECRET;

  if (webhookSecret) {
    await registerGitHubWebhookHandler(app, {
      secret: webhookSecret,
      onWorkflowRunCompleted: options.onWorkflowRunCompleted,
    });
  } else {
    app.log.warn("GITHUB_WEBHOOK_SECRET is not set; GitHub webhook endpoint is disabled");
  }

  return app;
}
