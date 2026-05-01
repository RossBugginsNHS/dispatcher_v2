import pino from "pino";

import { env } from "../config/env.js";
import { matchOutboundTargets, normalizeWorkflowName } from "../domain/trigger-matcher/match.js";
import { resolveInputs, type SourceContext } from "../domain/template-resolver/resolve.js";
import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import { authorizeDispatchTargets } from "../services/authorization-service.js";
import { evaluateSourceWorkflowRun, filterTargetsWithGuardrails } from "../services/dispatch-guardrails.js";
import { createSqsClient, enqueueJson, createEventBridgeClient, publishFact } from "../async/clients.js";
import { DispatchFacts, type DispatchRequestAcceptedMessage, type DispatchTargetWorkMessage } from "../async/contracts.js";
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

      const sourceAssessment = evaluateSourceWorkflowRun(payload, {
        enforceSourceDefaultBranch: env.ENFORCE_SOURCE_DEFAULT_BRANCH,
        maxTargetsPerRun: env.DISPATCH_MAX_TARGETS_PER_RUN,
        sourceRepoAllowlist: env.SOURCE_REPO_ALLOWLIST,
        targetRepoAllowlist: env.TARGET_REPO_ALLOWLIST,
        sourceWorkflowAllowlist: env.SOURCE_WORKFLOW_ALLOWLIST,
        allowedSourceConclusions: env.ALLOWED_SOURCE_CONCLUSIONS,
      });
      if (!sourceAssessment.allowed) {
        log.warn(
          { deliveryId: message.deliveryId, sourceRepo: sourceRepoFullName, reason: sourceAssessment.reason },
          "Planner skipped source workflow due to guardrail policy",
        );
        await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.planCreated, {
          deliveryId: message.deliveryId,
          sourceRepo: sourceRepoFullName,
          sourceWorkflow,
          sourceRunId,
          candidateTargets: 0,
          allowedTargets: 0,
          deniedTargets: 0,
        });
        continue;
      }

      const octokit = (await app.getInstallationOctokit(installationId)) as unknown as RepoContentsClient;
      const sourceConfig = await fetchDispatchingConfig(octokit, owner, repo);

      if (!sourceConfig.found) {
        await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.planCreated, {
          deliveryId: message.deliveryId,
          sourceRepo: sourceRepoFullName,
          sourceWorkflow,
          sourceRunId,
          allowedTargets: 0,
        });
        continue;
      }

      const candidates = matchOutboundTargets(sourceConfig.config, owner, payload.workflow_run.path);

      // Resolve template inputs for each candidate target
      const sourceContext: SourceContext = {
        sha: payload.workflow_run.head_sha ?? "",
        head_branch: payload.workflow_run.head_branch ?? "",
        run_id: String(payload.workflow_run.id ?? ""),
        run_url: payload.workflow_run.html_url ?? "",
        repo: sourceRepoFullName,
        workflow: sourceWorkflow,
      };

      const resolvedCandidates: typeof candidates = [];
      const templateErrors: Array<{ target: (typeof candidates)[0]; reason: string }> = [];

      for (const target of candidates) {
        if (!target.inputs || Object.keys(target.inputs).length === 0) {
          resolvedCandidates.push({
            owner: target.owner,
            repo: target.repo,
            workflow: target.workflow,
            ...(target.ref !== undefined ? { ref: target.ref } : {}),
          });
          continue;
        }
        const resolution = resolveInputs(target.inputs, sourceContext);
        if ("error" in resolution) {
          templateErrors.push({ target, reason: resolution.error });
        } else {
          resolvedCandidates.push({ ...target, inputs: resolution.resolved });
        }
      }

      for (const { target, reason } of templateErrors) {
        log.warn(
          { deliveryId: message.deliveryId, target, reason },
          "Dispatch denied: template resolution failed for target inputs",
        );
      }

      const targetGuardrails = filterTargetsWithGuardrails(resolvedCandidates, sourceRepoFullName, sourceWorkflow, {
        enforceSourceDefaultBranch: env.ENFORCE_SOURCE_DEFAULT_BRANCH,
        maxTargetsPerRun: env.DISPATCH_MAX_TARGETS_PER_RUN,
        sourceRepoAllowlist: env.SOURCE_REPO_ALLOWLIST,
        targetRepoAllowlist: env.TARGET_REPO_ALLOWLIST,
        sourceWorkflowAllowlist: env.SOURCE_WORKFLOW_ALLOWLIST,
        allowedSourceConclusions: env.ALLOWED_SOURCE_CONCLUSIONS,
      });
      const authorization = await authorizeDispatchTargets(
        targetGuardrails.allowed,
        sourceRepoFullName,
        repo,
        sourceWorkflow,
        async (targetOwner, targetRepo) => fetchDispatchingConfig(octokit, targetOwner, targetRepo),
      );
      const templateDenied = templateErrors.map(({ target }) => ({ target, reason: "inputs_template_error" as const }));
      const deniedTargets = [...templateDenied, ...targetGuardrails.denied, ...authorization.denied];

      await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.planCreated, {
        deliveryId: message.deliveryId,
        sourceRepo: sourceRepoFullName,
        sourceWorkflow,
        sourceRunId,
        candidateTargets: candidates.length,
        allowedTargets: authorization.allowed.length,
        deniedTargets: deniedTargets.length,
      });

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
            ...(target.inputs !== undefined ? { inputs: target.inputs } : {}),
          },
        };

        await enqueueJson(sqs, env.DISPATCH_TARGETS_QUEUE_URL, targetMessage);
        await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.targetQueued, {
          deliveryId: message.deliveryId,
          sourceRepo: sourceRepoFullName,
          sourceWorkflow,
          sourceRunId,
          targetRepo: `${target.owner}/${target.repo}`,
          targetWorkflow: target.workflow,
        });
      }
    } catch (error) {
      log.error({ err: error, messageId: record.messageId }, "Planner failed processing message");
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
