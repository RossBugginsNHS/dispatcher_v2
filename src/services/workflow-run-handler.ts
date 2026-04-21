import type { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";

import { matchOutboundTargets, normalizeWorkflowName } from "../domain/trigger-matcher/match.js";
import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import type { WorkflowRunPayload } from "../github/types.js";
import { authorizeDispatchTargets } from "./authorization-service.js";

export function createWorkflowRunHandler(
  app: App,
  log: FastifyBaseLogger,
): (payload: WorkflowRunPayload) => Promise<void> {
  return async (payload: WorkflowRunPayload): Promise<void> => {
    const { repository, workflow_run, installation } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const sourceRepoFullName = `${owner}/${repo}`;
    const sourceWorkflow = normalizeWorkflowName(workflow_run.path);

    log.info(
      { owner, repo, workflowPath: workflow_run.path, conclusion: workflow_run.conclusion },
      "Handling workflow_run.completed",
    );

    if (!installation?.id) {
      log.warn({ owner, repo }, "No installation ID in payload; skipping dispatching config fetch");
      return;
    }

    const octokit = (await app.getInstallationOctokit(installation.id)) as unknown as RepoContentsClient;

    const result = await fetchDispatchingConfig(octokit, owner, repo);

    if (!result.found) {
      if (result.reason === "missing") {
        log.info({ owner, repo }, "No dispatching.yml found in repository; nothing to dispatch");
      } else {
        log.warn(
          { owner, repo, err: result.error },
          "dispatching.yml is present but failed schema validation",
        );
      }
      return;
    }

    log.info(
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
      log.info(
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

    log.info(
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
  };
}
