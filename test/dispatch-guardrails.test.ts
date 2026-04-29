import { describe, expect, it } from "vitest";

import { evaluateSourceWorkflowRun, filterTargetsWithGuardrails } from "../src/services/dispatch-guardrails.js";

const baseSettings = {
  enforceSourceDefaultBranch: true,
  maxTargetsPerRun: 2,
  sourceRepoAllowlist: "",
  targetRepoAllowlist: "",
  sourceWorkflowAllowlist: "",
};

describe("evaluateSourceWorkflowRun", () => {
  it("rejects non-default-branch runs when enforcement is enabled", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: { name: "CI", path: ".github/workflows/ci.yml", head_branch: "feature", conclusion: "success" },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_not_default_branch" });
  });

  it("rejects fork-sourced runs", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "success",
          head_repository: { full_name: "attacker/repo" },
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_from_fork" });
  });
});

describe("filterTargetsWithGuardrails", () => {
  it("filters duplicates, self-dispatch, and applies target cap", () => {
    const result = filterTargetsWithGuardrails(
      [
        { owner: "org", repo: "source", workflow: "ci.yml" },
        { owner: "org", repo: "target-a", workflow: "deploy.yml" },
        { owner: "org", repo: "target-a", workflow: "deploy.yml" },
        { owner: "org", repo: "target-b", workflow: "deploy.yml" },
        { owner: "org", repo: "target-c", workflow: "deploy.yml" },
      ],
      "org/source",
      "ci.yml",
      baseSettings,
    );

    expect(result.allowed).toEqual([
      { owner: "org", repo: "target-a", workflow: "deploy.yml" },
      { owner: "org", repo: "target-b", workflow: "deploy.yml" },
    ]);
    expect(result.denied.map((item) => item.reason)).toEqual([
      "self_dispatch_blocked",
      "duplicate_target",
      "max_targets_exceeded",
    ]);
  });

  it("enforces target repository allowlist", () => {
    const result = filterTargetsWithGuardrails(
      [{ owner: "org", repo: "target-a", workflow: "deploy.yml" }],
      "org/source",
      "ci.yml",
      { ...baseSettings, targetRepoAllowlist: "org/target-b" },
    );

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([
      {
        target: { owner: "org", repo: "target-a", workflow: "deploy.yml" },
        reason: "target_repo_not_allowlisted",
      },
    ]);
  });
});
