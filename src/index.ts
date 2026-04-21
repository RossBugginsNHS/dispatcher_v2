import { App } from "@octokit/app";

import { env } from "./config/env.js";
import type { WorkflowRunPayload } from "./github/types.js";
import { buildServer } from "./server.js";
import { createWorkflowRunHandler } from "./services/workflow-run-handler.js";

async function start(): Promise<void> {
  // Lazy handler: set after server is built so we can use app.log
  let dispatchHandler: ((payload: WorkflowRunPayload) => Promise<void>) | undefined;

  const app = await buildServer({
    onWorkflowRunCompleted: (payload) => dispatchHandler?.(payload),
  });

  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    const githubApp = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    dispatchHandler = createWorkflowRunHandler(githubApp, app.log, {
      defaultDispatchRef: env.DEFAULT_DISPATCH_REF,
      createIssues: env.CREATE_ISSUES,
    });
  } else {
    app.log.warn("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not set; dispatching is disabled");
  }

  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

void start();
