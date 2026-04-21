import type { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";

import { fetchDispatchingConfig, type RepoContentsClient } from "../github/content.js";
import type { WorkflowRunPayload } from "../github/types.js";

export function createWorkflowRunHandler(
  app: App,
  log: FastifyBaseLogger,
): (payload: WorkflowRunPayload) => Promise<void> {
  return async (payload: WorkflowRunPayload): Promise<void> => {
    const { repository, workflow_run, installation } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;

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
  };
}
