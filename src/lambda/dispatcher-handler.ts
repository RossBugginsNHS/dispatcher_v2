import pino from "pino";

import { env } from "../config/env.js";
import { executeWorkflowDispatches, type DispatchActionsClient } from "../services/dispatch-service.js";
import { createEventBridgeClient, publishFact } from "../async/clients.js";
import { DispatchFacts, type DispatchTargetWorkMessage } from "../async/contracts.js";
import { createGitHubApp } from "./github-app.js";

const log = pino({ level: env.LOG_LEVEL });

type SqsEvent = {
  Records: Array<{
    messageId: string;
    body: string;
  }>;
};

type SqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  if (!env.DISPATCH_FACTS_EVENT_BUS_NAME) {
    throw new Error("DISPATCH_FACTS_EVENT_BUS_NAME must be set");
  }

  const app = await createGitHubApp();
  const eb = createEventBridgeClient();
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as DispatchTargetWorkMessage;
      const octokit = (await app.getInstallationOctokit(message.installationId)) as unknown as DispatchActionsClient;
      const results = await executeWorkflowDispatches(
        octokit,
        [
          {
            owner: message.target.owner,
            repo: message.target.repo,
            workflow: message.target.workflow,
          },
        ],
        message.dispatchRef,
        log,
        {
          maxRetries: env.DISPATCH_MAX_RETRIES,
          retryBaseDelayMs: env.DISPATCH_RETRY_BASE_DELAY_MS,
        },
      );

      const result = results[0];
      const detail = {
        deliveryId: message.deliveryId,
        sourceRepo: `${message.sourceOwner}/${message.sourceRepo}`,
        sourceWorkflow: message.sourceWorkflow,
        sourceRunId: message.sourceRunId,
        targetRepo: `${message.target.owner}/${message.target.repo}`,
        targetWorkflow: message.target.workflow,
        dispatchRef: message.dispatchRef,
        attempts: result.attempts,
      };

      if (result.status === "success") {
        await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.triggerSucceeded, detail);
      } else {
        await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.triggerFailed, {
          ...detail,
          error: String(result.error),
        });
      }
    } catch (error) {
      log.error({ err: error, messageId: record.messageId }, "Dispatcher failed processing message");
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
