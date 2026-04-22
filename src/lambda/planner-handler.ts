import pino from "pino";

import { env } from "../config/env.js";
import { matchOutboundTargets, normalizeWorkflowName } from "../domain/trigger-matcher/match.js";
import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import { authorizeDispatchTargets } from "../services/authorization-service.js";
import { createSqsClient, enqueueJson, createEventBridgeClient, publishCloudEvent } from "../async/clients.js";
import { makeCloudEvent } from "../async/cloudevents.js";
import { DispatchFacts, type DispatchRequestAcceptedMessage, type DispatchTargetWorkMessage } from "../async/contracts.js";
import { makeChildTraceContext } from "../async/trace-context.js";
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
  if (!env.DISPATCH_TARGETS_QUEUE_URL || !env.DISPATCH_FACTS_EVENT_BUS_NAME) {
    throw new Error("DISPATCH_TARGETS_QUEUE_URL and DISPATCH_FACTS_EVENT_BUS_NAME must be set");
  }

  const app = await createGitHubApp();
  const sqs = createSqsClient();
  const eb = createEventBridgeClient();
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as DispatchRequestAcceptedMessage;
      const payload = message.payload;
      const installationId = payload.installation?.id;

      if (!installationId) {
        log.warn({ deliveryId: message.deliveryId }, "Skipping message with missing installation id");
        continue;
      }

      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const sourceRepoFullName = `${owner}/${repo}`;
      const sourceWorkflow = normalizeWorkflowName(payload.workflow_run.path);
      const sourceRunId = payload.workflow_run.id ?? 0;
      const dispatchRef = payload.workflow_run.head_branch ?? env.DEFAULT_DISPATCH_REF;

      const octokit = (await app.getInstallationOctokit(installationId)) as unknown as RepoContentsClient;
      const sourceConfig = await fetchDispatchingConfig(octokit, owner, repo);

      if (!sourceConfig.found) {
        await publishCloudEvent(
          eb,
          env.DISPATCH_FACTS_EVENT_BUS_NAME,
          makeCloudEvent({
            source: "io.dispatcher.planner",
            type: DispatchFacts.planCreated,
            subject: sourceRepoFullName,
            data: {
              deliveryId: message.deliveryId,
              sourceRepo: sourceRepoFullName,
              sourceWorkflow,
              sourceRunId,
              allowedTargets: 0,
            },
            trace: makeChildTraceContext(message.trace),
          }),
        );
        continue;
      }

      const candidates = matchOutboundTargets(sourceConfig.config, owner, payload.workflow_run.path);
      const authorization = await authorizeDispatchTargets(
        candidates,
        sourceRepoFullName,
        repo,
        sourceWorkflow,
        async (targetOwner, targetRepo) => fetchDispatchingConfig(octokit, targetOwner, targetRepo),
      );

      await publishCloudEvent(
        eb,
        env.DISPATCH_FACTS_EVENT_BUS_NAME,
        makeCloudEvent({
          source: "io.dispatcher.planner",
          type: DispatchFacts.planCreated,
          subject: sourceRepoFullName,
          data: {
            deliveryId: message.deliveryId,
            sourceRepo: sourceRepoFullName,
            sourceWorkflow,
            sourceRunId,
            candidateTargets: candidates.length,
            allowedTargets: authorization.allowed.length,
            deniedTargets: authorization.denied.length,
          },
          trace: makeChildTraceContext(message.trace),
        }),
      );

      for (const target of authorization.allowed) {
        const targetMessage: DispatchTargetWorkMessage = {
          deliveryId: message.deliveryId,
          sourceOwner: owner,
          sourceRepo: repo,
          sourceWorkflow,
          sourceRunId,
          installationId,
          dispatchRef,
          target: {
            owner: target.owner,
            repo: target.repo,
            workflow: target.workflow,
          },
          trace: makeChildTraceContext(message.trace),
        };

        await enqueueJson(sqs, env.DISPATCH_TARGETS_QUEUE_URL, targetMessage);
        await publishCloudEvent(
          eb,
          env.DISPATCH_FACTS_EVENT_BUS_NAME,
          makeCloudEvent({
            source: "io.dispatcher.planner",
            type: DispatchFacts.targetQueued,
            subject: `${target.owner}/${target.repo}`,
            data: {
              deliveryId: message.deliveryId,
              sourceRepo: sourceRepoFullName,
              sourceWorkflow,
              sourceRunId,
              targetRepo: `${target.owner}/${target.repo}`,
              targetWorkflow: target.workflow,
            },
            trace: makeChildTraceContext(targetMessage.trace),
          }),
        );
      }
    } catch (error) {
      log.error({ err: error, messageId: record.messageId }, "Planner failed processing message");
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
