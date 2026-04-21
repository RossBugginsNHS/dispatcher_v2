import type { FastifyBaseLogger } from "fastify";

import type { ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";

export interface DispatchActionsClient {
  actions: {
    createWorkflowDispatch(params: {
      owner: string;
      repo: string;
      workflow_id: string;
      ref: string;
      inputs?: Record<string, string>;
    }): Promise<unknown>;
  };
}

export type DispatchExecutionResult = {
  target: ResolvedDispatchTarget;
  status: "success" | "failed";
  error?: unknown;
};

export async function executeWorkflowDispatches(
  client: DispatchActionsClient,
  targets: ResolvedDispatchTarget[],
  ref: string,
  log: FastifyBaseLogger,
): Promise<DispatchExecutionResult[]> {
  const results: DispatchExecutionResult[] = [];

  for (const target of targets) {
    try {
      await client.actions.createWorkflowDispatch({
        owner: target.owner,
        repo: target.repo,
        workflow_id: target.workflow,
        ref,
      });

      results.push({ target, status: "success" });
      log.info({ target, ref }, "Workflow dispatch succeeded");
    } catch (error) {
      results.push({ target, status: "failed", error });
      log.error({ err: error, target, ref }, "Workflow dispatch failed");
    }
  }

  return results;
}
