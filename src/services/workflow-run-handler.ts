import type { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";

import { matchOutboundTargets, normalizeWorkflowName } from "../domain/trigger-matcher/match.js";
import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import type { WorkflowRunEventContext, WorkflowRunPayload } from "../github/types.js";
import { executeWorkflowDispatches, type DispatchActionsClient } from "./dispatch-service.js";
import { evaluateSourceWorkflowRun, type GuardrailSettings } from "./dispatch-guardrails.js";
import type { DispatchEventStore } from "./dispatch-event-store.js";
import { createDispatchResultIssue, type IssueClient } from "./issue-service.js";
import { buildSourceContext, planDispatches } from "./dispatch-planner.js";

type WorkflowRunHandlerOptions = {
  defaultDispatchRef: string;
  createIssues: boolean;
  dispatchMaxRetries: number;
  dispatchRetryBaseDelayMs: number;
  eventStore?: DispatchEventStore;
  guardrails: GuardrailSettings;
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

    const sourceAssessment = evaluateSourceWorkflowRun(payload, options.guardrails);
    if (!sourceAssessment.allowed) {
      runLog.warn(
        { owner, repo, sourceWorkflow, reason: sourceAssessment.reason },
        "Skipped workflow run due to source guardrail policy",
      );
      return;
    }

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

    // Build source context for template resolution.
    // Fields that are absent from the payload default to empty strings; the template resolver
    // treats empty resolved values as errors, so dispatches using missing fields will be denied
    // with an `inputs_template_error` reason and a clear log message.
    const sourceContext = buildSourceContext(payload, sourceRepoFullName, sourceWorkflow);

    const plan = await planDispatches({
      candidates: candidateTargets,
      sourceContext,
      sourceRepoFullName,
      sourceRepoName: repo,
      sourceWorkflow,
      guardrailSettings: options.guardrails,
      loadTargetConfig: async (targetOwner, targetRepo) =>
        fetchDispatchingConfig(octokit, targetOwner, targetRepo),
      log: runLog,
    });

    const { allowed: allowedTargets, denied: deniedTargets } = plan;

    runLog.info(
      {
        owner,
        repo,
        sourceWorkflow,
        candidateTargets: candidateTargets.length,
        allowedTargets: allowedTargets,
        deniedTargets: deniedTargets,
      },
      "Dispatch target authorization evaluated",
    );

    const dispatchRef = payload.workflow_run.head_branch ?? options.defaultDispatchRef;
    const dispatches = await executeWorkflowDispatches(
      octokit,
      allowedTargets,
      dispatchRef,
      runLog,
      {
        maxRetries: options.dispatchMaxRetries,
        retryBaseDelayMs: options.dispatchRetryBaseDelayMs,
      },
    );

    const timestamp = new Date().toISOString();
    const sourceRunId = workflow_run.id ?? 0;
    for (const d of dispatches) {
      options.eventStore?.record({
        timestamp,
        correlationId: context.deliveryId,
        sourceRepo: `${owner}/${repo}`,
        sourceWorkflow,
        sourceRunId,
        targetRepo: `${d.target.owner}/${d.target.repo}`,
        targetWorkflow: d.target.workflow,
        status: d.status,
        error: d.status === "failed" ? String(d.error) : undefined,
      });
    }
    for (const denied of deniedTargets) {
      options.eventStore?.record({
        timestamp,
        correlationId: context.deliveryId,
        sourceRepo: `${owner}/${repo}`,
        sourceWorkflow,
        sourceRunId,
        targetRepo: `${denied.target.owner}/${denied.target.repo}`,
        targetWorkflow: denied.target.workflow,
        status: "denied",
      });
    }

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
            denied: deniedTargets,
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
        deniedCount: deniedTargets.length,
      },
      "Dispatch side effects completed",
    );
  };
}
