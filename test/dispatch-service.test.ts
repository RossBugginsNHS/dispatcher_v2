import { describe, expect, it, vi } from "vitest";

import { executeWorkflowDispatches, type DispatchActionsClient } from "../src/services/dispatch-service.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
  };
}

describe("executeWorkflowDispatches", () => {
  it("dispatches all targets and records success/failure without stopping", async () => {
    const createWorkflowDispatch = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({});

    const client = {
      actions: {
        createWorkflowDispatch,
      },
    } as unknown as DispatchActionsClient;

    const targets = [
      { owner: "acme", repo: "target-a", workflow: "deploy.yml" },
      { owner: "acme", repo: "target-b", workflow: "release.yml" },
      { owner: "acme", repo: "target-c", workflow: "scan.yml" },
    ];

    const log = createLogger() as never;

    const results = await executeWorkflowDispatches(client, targets, "main", log, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    expect(createWorkflowDispatch).toHaveBeenCalledTimes(3);
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "target-a",
      workflow_id: "deploy.yml",
      ref: "main",
    });
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "target-b",
      workflow_id: "release.yml",
      ref: "main",
    });
    expect(createWorkflowDispatch).toHaveBeenNthCalledWith(3, {
      owner: "acme",
      repo: "target-c",
      workflow_id: "scan.yml",
      ref: "main",
    });

    expect(results).toEqual([
      { target: targets[0], status: "success", attempts: 1 },
      { target: targets[1], status: "failed", error: expect.any(Error), attempts: 1 },
      { target: targets[2], status: "success", attempts: 1 },
    ]);
  });

  it("retries transient status errors and eventually succeeds", async () => {
    const createWorkflowDispatch = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce({});

    const client = {
      actions: {
        createWorkflowDispatch,
      },
    } as unknown as DispatchActionsClient;

    const targets = [{ owner: "acme", repo: "target-a", workflow: "deploy.yml" }];
    const log = createLogger() as never;

    const results = await executeWorkflowDispatches(client, targets, "main", log, {
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    expect(createWorkflowDispatch).toHaveBeenCalledTimes(2);
    expect(results).toEqual([{ target: targets[0], status: "success", attempts: 2 }]);
  });
});
