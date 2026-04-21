import { describe, expect, it, vi } from "vitest";

import { createDispatchResultIssue } from "../src/services/issue-service.js";

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

describe("createDispatchResultIssue", () => {
  it("creates a summary issue containing success, failure and denial outcomes", async () => {
    const create = vi.fn().mockResolvedValue({});
    const client = {
      issues: { create },
    } as never;

    const log = createLogger() as never;

    await createDispatchResultIssue(
      client,
      {
        owner: "source-owner",
        repo: "source-repo",
        sourceWorkflow: "ci.yml",
        sourceWorkflowPath: ".github/workflows/ci.yml",
        sourceRunId: 42,
        sourceRunUrl: "https://example/run/42",
        dispatches: [
          {
            target: { owner: "team-a", repo: "target-a", workflow: "deploy.yml" },
            status: "success",
          },
          {
            target: { owner: "team-b", repo: "target-b", workflow: "release.yml" },
            status: "failed",
            error: new Error("boom"),
          },
        ],
        denied: [
          {
            target: { owner: "team-c", repo: "target-c", workflow: "scan.yml" },
            reason: "inbound_not_authorized",
          },
        ],
      },
      log,
    );

    expect(create).toHaveBeenCalledTimes(1);

    const args = create.mock.calls[0][0] as {
      owner: string;
      repo: string;
      title: string;
      body: string;
    };

    expect(args.owner).toBe("source-owner");
    expect(args.repo).toBe("source-repo");
    expect(args.title).toContain("success=1");
    expect(args.title).toContain("failed=1");
    expect(args.title).toContain("denied=1");

    expect(args.body).toContain("SUCCESS team-a/target-a :: deploy.yml");
    expect(args.body).toContain("FAILED team-b/target-b :: release.yml");
    expect(args.body).toContain("DENIED team-c/target-c :: scan.yml (inbound_not_authorized)");
    expect(args.body).toContain("Run ID: 42");
    expect(args.body).toContain("Run URL: https://example/run/42");
  });
});
