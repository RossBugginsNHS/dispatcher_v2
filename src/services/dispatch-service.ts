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
  attempts: number;
};

type DispatchExecutionOptions = {
  maxRetries: number;
  retryBaseDelayMs: number;
};

export async function executeWorkflowDispatches(
  client: DispatchActionsClient,
  targets: ResolvedDispatchTarget[],
  ref: string,
  log: FastifyBaseLogger,
  options: DispatchExecutionOptions,
): Promise<DispatchExecutionResult[]> {
  const results: DispatchExecutionResult[] = [];

  for (const target of targets) {
    let attempts = 0;

    try {
      while (true) {
        attempts += 1;
        try {
          await client.actions.createWorkflowDispatch({
            owner: target.owner,
            repo: target.repo,
            workflow_id: target.workflow,
            ref,
          });
          break;
        } catch (error) {
          if (!isRetryableError(error) || attempts > options.maxRetries) {
            throw error;
          }

          const delayMs = options.retryBaseDelayMs * 2 ** (attempts - 1);
          log.warn(
            { err: error, target, attempts, maxRetries: options.maxRetries, delayMs },
            "Retrying workflow dispatch after transient failure",
          );
          await sleep(delayMs);
        }
      }

      results.push({ target, status: "success", attempts });
      log.info({ target, ref, attempts }, "Workflow dispatch succeeded");
    } catch (error) {
      results.push({ target, status: "failed", error, attempts });
      log.error({ err: error, target, ref, attempts }, "Workflow dispatch failed");
    }
  }

  return results;
}

function isRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = "status" in error ? Number(error.status) : undefined;

  if (status !== undefined && [429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = "code" in error ? String(error.code) : undefined;
  return code === "ECONNRESET" || code === "ETIMEDOUT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
