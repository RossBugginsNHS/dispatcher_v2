import { describe, expect, it, vi } from "vitest";

import { planDispatches, buildSourceContext } from "../src/services/dispatch-planner.js";
import type { PlanDispatchesInput } from "../src/services/dispatch-planner.js";
import type { ResolvedDispatchTarget } from "../src/domain/trigger-matcher/match.js";
import type { WorkflowRunPayload } from "../src/github/types.js";

function makeLogger() {
  return { warn: vi.fn() };
}

function authorizedTargetConfig(sourceRepo: string, sourceWorkflow: string, targetWorkflow: string) {
  return {
    found: true as const,
    config: {
      outbound: [],
      inbound: [
        {
          source: { repository: sourceRepo, workflow: sourceWorkflow },
          targets: [{ workflow: targetWorkflow }],
        },
      ],
    },
  };
}

const BASE_GUARDRAILS: PlanDispatchesInput["guardrailSettings"] = {
  enforceSourceDefaultBranch: false,
  maxTargetsPerRun: 25,
  sourceRepoAllowlist: "",
  targetRepoAllowlist: "",
  sourceWorkflowAllowlist: "",
  allowedSourceConclusions: "success",
};

const BASE_CONTEXT: PlanDispatchesInput["sourceContext"] = {
  sha: "abc123",
  head_branch: "main",
  run_id: "42",
  run_url: "https://github.com/acme/source/actions/runs/42",
  repo: "acme/source",
  workflow: "ci.yml",
};

describe("planDispatches", () => {
  it("allows authorized targets through to the allowed list", async () => {
    const candidates: ResolvedDispatchTarget[] = [
      { owner: "acme", repo: "target-a", workflow: "deploy.yml" },
    ];

    const result = await planDispatches({
      candidates,
      sourceContext: BASE_CONTEXT,
      sourceRepoFullName: "acme/source",
      sourceRepoName: "source",
      sourceWorkflow: "ci.yml",
      guardrailSettings: BASE_GUARDRAILS,
      loadTargetConfig: () =>
        authorizedTargetConfig("source", "ci.yml", "deploy.yml"),
      log: makeLogger(),
    });

    expect(result.allowed).toEqual(candidates);
    expect(result.denied).toEqual([]);
  });

  it("denies targets whose inbound rules do not match", async () => {
    const candidates: ResolvedDispatchTarget[] = [
      { owner: "acme", repo: "target-a", workflow: "deploy.yml" },
    ];

    const result = await planDispatches({
      candidates,
      sourceContext: BASE_CONTEXT,
      sourceRepoFullName: "acme/source",
      sourceRepoName: "source",
      sourceWorkflow: "ci.yml",
      guardrailSettings: BASE_GUARDRAILS,
      loadTargetConfig: () => ({
        found: true,
        config: { outbound: [], inbound: [] },
      }),
      log: makeLogger(),
    });

    expect(result.allowed).toEqual([]);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.reason).toBe("inbound_not_authorized");
  });

  it("denies targets whose inputs template contains an unknown variable", async () => {
    const candidates: ResolvedDispatchTarget[] = [
      {
        owner: "acme",
        repo: "target-a",
        workflow: "deploy.yml",
        inputs: { env: "{{ source.unknown_field }}" },
      },
    ];

    const log = makeLogger();

    const result = await planDispatches({
      candidates,
      sourceContext: BASE_CONTEXT,
      sourceRepoFullName: "acme/source",
      sourceRepoName: "source",
      sourceWorkflow: "ci.yml",
      guardrailSettings: BASE_GUARDRAILS,
      loadTargetConfig: () => authorizedTargetConfig("source", "ci.yml", "deploy.yml"),
      log,
    });

    expect(result.allowed).toEqual([]);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.reason).toBe("inputs_template_error");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("resolves template inputs and passes them to allowed targets", async () => {
    const candidates: ResolvedDispatchTarget[] = [
      {
        owner: "acme",
        repo: "target-a",
        workflow: "deploy.yml",
        inputs: { sha: "{{ source.sha }}", branch: "{{ source.head_branch }}" },
      },
    ];

    const result = await planDispatches({
      candidates,
      sourceContext: BASE_CONTEXT,
      sourceRepoFullName: "acme/source",
      sourceRepoName: "source",
      sourceWorkflow: "ci.yml",
      guardrailSettings: BASE_GUARDRAILS,
      loadTargetConfig: () => ({
        found: true,
        config: {
          outbound: [],
          inbound: [
            {
              source: { repository: "source", workflow: "ci.yml" },
              targets: [{ workflow: "deploy.yml", accept_inputs: ["sha", "branch"] }],
            },
          ],
        },
      }),
      log: makeLogger(),
    });

    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.inputs).toEqual({ sha: "abc123", branch: "main" });
    expect(result.denied).toEqual([]);
  });

  it("denies targets blocked by guardrails (self-dispatch)", async () => {
    const candidates: ResolvedDispatchTarget[] = [
      { owner: "acme", repo: "source", workflow: "ci.yml" },
    ];

    const result = await planDispatches({
      candidates,
      sourceContext: BASE_CONTEXT,
      sourceRepoFullName: "acme/source",
      sourceRepoName: "source",
      sourceWorkflow: "ci.yml",
      guardrailSettings: BASE_GUARDRAILS,
      loadTargetConfig: vi.fn(),
      log: makeLogger(),
    });

    expect(result.allowed).toEqual([]);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.reason).toBe("self_dispatch_blocked");
  });
});

describe("buildSourceContext", () => {
  it("maps workflow_run payload fields to source context", () => {
    const payload: WorkflowRunPayload = {
      installation: { id: 1 },
      repository: { name: "source", owner: { login: "acme" }, default_branch: "main" },
      workflow_run: {
        id: 99,
        name: "CI",
        path: ".github/workflows/ci.yml",
        html_url: "https://github.com/acme/source/actions/runs/99",
        head_branch: "main",
        head_sha: "deadbeef",
        conclusion: "success",
        head_repository: { full_name: "acme/source" },
      },
    };

    const context = buildSourceContext(payload, "acme/source", "ci.yml");

    expect(context).toEqual({
      sha: "deadbeef",
      head_branch: "main",
      run_id: "99",
      run_url: "https://github.com/acme/source/actions/runs/99",
      repo: "acme/source",
      workflow: "ci.yml",
    });
  });

  it("defaults missing payload fields to empty strings", () => {
    const payload: WorkflowRunPayload = {
      repository: { name: "source", owner: { login: "acme" } },
      workflow_run: {
        id: undefined,
        name: null,
        path: "ci.yml",
        html_url: undefined,
        head_branch: undefined,
        head_sha: undefined,
        conclusion: null,
      },
    };

    const context = buildSourceContext(payload, "acme/source", "ci.yml");

    expect(context.sha).toBe("");
    expect(context.head_branch).toBe("");
    expect(context.run_id).toBe("");
    expect(context.run_url).toBe("");
  });
});
