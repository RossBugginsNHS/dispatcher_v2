import Fastify from "fastify";

import { env } from "./config/env.js";
import type { WorkflowRunPayload } from "./github/types.js";
import { registerGitHubWebhookHandler } from "./github/webhook-handler.js";

type BuildServerOptions = {
  githubWebhookSecret?: string;
  onWorkflowRunCompleted?: (payload: WorkflowRunPayload) => Promise<void> | void;
};

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger: true,
  });

  app.get("/health", () => {
    return { status: "ok" };
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
