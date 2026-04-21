import type { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";

import { matchOutboundTargets, normalizeWorkflowName } from "../domain/trigger-matcher/match.js";
import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import type { WorkflowRunEventContext, WorkflowRunPayload } from "../github/types.js";
import { authorizeDispatchTargets } from "./authorization-service.js";
import { executeWorkflowDispatches, type DispatchActionsClient } from "./dispatch-service.js";
import { createDispatchResultIssue, type IssueClient } from "./issue-service.js";

type WorkflowRunHandlerOptions = {
  defaultDispatchRef: string;
  createIssues: boolean;
  dispatchMaxRetries: number;
  dispatchRetryBaseDelayMs: number;
};

type WorkflowRunOctokitClient = RepoContentsClient & DispatchActionsClient & IssueClient;

export function createWorkflowRunHandler(
  app: App,
  log: FastifyBaseLogger,
  options: WorkflowRunHandlerOptions,
): (payload: WorkflowRunPayload, context: WorkflowRunEventContext) => Promise<void> {
  return async (payload: WorkflowRunPayload, context: WorkflowRunEventContext): Promise<void> => {
    const { repository, workflow_run, installation } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const sourceRepoFullName = `${owner}/${repo}`;
    const sourceWorkflow = normalizeWorkflowName(workflow_run.path);
    const runLog = log.child({
      correlationId: context.deliveryId,
      deliveryId: context.deliveryId,
      eventName: context.eventName,
      sourceOwner: owner,
      sourceRepo: repo,
      sourceWorkflow,
      sourceRunId: workflow_run.id,
    });

    runLog.info(
      { owner, repo, workflowPath: workflow_run.path, conclusion: workflow_run.conclusion },
      "Handling workflow_run.completed",
    );

    if (!installation?.id) {
      runLog.warn({ owner, repo }, "No installation ID in payload; skipping dispatching config fetch");
      return;
    }

    const octokit = (await app.getInstallationOctokit(installation.id)) as unknown as WorkflowRunOctokitClient;

    const result = await fetchDispatchingConfig(octokit, owner, repo);

    if (!result.found) {
      if (result.reason === "missing") {
        runLog.info({ owner, repo }, "No dispatching.yml found in repository; nothing to dispatch");
      } else {
        runLog.warn(
          { owner, repo, err: result.error },
          "dispatching.yml is present but failed schema validation",
        );
      }
      return;
    }

    runLog.info(
      {
        owner,
        repo,
        outboundRules: result.config.outbound.length,
        inboundRules: result.config.inbound.length,
      },
      "Loaded dispatching.yml successfully",
    );

    const candidateTargets = matchOutboundTargets(result.config, owner, workflow_run.path);

    if (candidateTargets.length === 0) {
      runLog.info(
        { owner, repo, workflow: sourceWorkflow },
        "No outbound targets matched this workflow run",
      );
      return;
    }

    const authorization = await authorizeDispatchTargets(
      candidateTargets,
      sourceRepoFullName,
      repo,
      sourceWorkflow,
      async (targetOwner, targetRepo) => fetchDispatchingConfig(octokit, targetOwner, targetRepo),
    );

    runLog.info(
      {
        owner,
        repo,
        sourceWorkflow,
        candidateTargets: candidateTargets.length,
        allowedTargets: authorization.allowed,
        deniedTargets: authorization.denied,
      },
      "Dispatch target authorization evaluated",
    );

    const dispatchRef = payload.workflow_run.head_branch ?? options.defaultDispatchRef;
    const dispatches = await executeWorkflowDispatches(
      octokit,
      authorization.allowed,
      dispatchRef,
      runLog,
      {
        maxRetries: options.dispatchMaxRetries,
        retryBaseDelayMs: options.dispatchRetryBaseDelayMs,
      },
    );

    if (options.createIssues) {
      try {
        await createDispatchResultIssue(
          octokit,
          {
            owner,
            repo,
            sourceWorkflow,
            sourceWorkflowPath: workflow_run.path,
            sourceRunId: workflow_run.id,
            sourceRunUrl: workflow_run.html_url,
            denied: authorization.denied,
            dispatches,
          },
          runLog,
        );
      } catch (error) {
        runLog.error({ err: error, owner, repo }, "Failed to create dispatch result issue");
      }
    }

    runLog.info(
      {
        owner,
        repo,
        sourceWorkflow,
        dispatchRef,
        dispatchSuccessCount: dispatches.filter((item) => item.status === "success").length,
        dispatchFailureCount: dispatches.filter((item) => item.status === "failed").length,
        deniedCount: authorization.denied.length,
      },
      "Dispatch side effects completed",
    );
  };
}
