import { describe, expect, it } from "vitest";

import { evaluateSourceWorkflowRun, filterTargetsWithGuardrails } from "../src/services/dispatch-guardrails.js";

const baseSettings = {
  enforceSourceDefaultBranch: true,
  maxTargetsPerRun: 2,
  sourceRepoAllowlist: "",
  targetRepoAllowlist: "",
  sourceWorkflowAllowlist: "",
  allowedSourceConclusions: "success",
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

  it("rejects runs with a disallowed conclusion", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "failure",
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_conclusion_not_allowed" });
  });

  it("rejects runs with a cancelled conclusion when only success is allowed", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "cancelled",
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_conclusion_not_allowed" });
  });

  it("allows runs matching one of multiple allowed conclusions", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "skipped",
          head_repository: { full_name: "org/repo" },
        },
      },
      { ...baseSettings, allowedSourceConclusions: "success,skipped" },
    );

    expect(result).toEqual({ allowed: true });
  });

  it("allows all conclusions when allowedSourceConclusions is empty (wildcard)", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "failure",
          head_repository: { full_name: "org/repo" },
        },
      },
      { ...baseSettings, allowedSourceConclusions: "" },
    );

    expect(result).toEqual({ allowed: true });
  });

  it("rejects runs where head_repository is absent (unverifiable fork status)", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "success",
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_head_repository_unverifiable" });
  });

  it("rejects runs where head_repository full_name is missing (unverifiable fork status)", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "success",
          head_repository: {},
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: false, reason: "source_head_repository_unverifiable" });
  });

  it("allows legitimate runs where head_repository matches the source repository", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
          conclusion: "success",
          head_repository: { full_name: "org/repo" },
        },
      },
      baseSettings,
    );

    expect(result).toEqual({ allowed: true });
  });

  it("rejects runs even when default-branch enforcement is disabled but head_repository is absent", () => {
    const result = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "org" }, name: "repo", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_branch: "feature-branch",
          conclusion: "success",
        },
      },
      { ...baseSettings, enforceSourceDefaultBranch: false },
    );

    expect(result).toEqual({ allowed: false, reason: "source_head_repository_unverifiable" });
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

  it("allows targets matching a wildcard pattern in the target allowlist", () => {
    const result = filterTargetsWithGuardrails(
      [
        { owner: "org", repo: "target-a", workflow: "deploy.yml" },
        { owner: "other-org", repo: "target-b", workflow: "deploy.yml" },
      ],
      "org/source",
      "ci.yml",
      { ...baseSettings, maxTargetsPerRun: 10, targetRepoAllowlist: "org/*" },
    );

    expect(result.allowed).toEqual([{ owner: "org", repo: "target-a", workflow: "deploy.yml" }]);
    expect(result.denied).toEqual([
      {
        target: { owner: "other-org", repo: "target-b", workflow: "deploy.yml" },
        reason: "target_repo_not_allowlisted",
      },
    ]);
  });

  it("allows sources matching a wildcard pattern in the source repo allowlist", () => {
    const allowed = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "my-org" }, name: "repo-a", default_branch: "main" },
        workflow_run: {
          name: "CI",
          path: "ci.yml",
          head_branch: "main",
          conclusion: "success",
          head_repository: { full_name: "my-org/repo-a" },
        },
      },
      { ...baseSettings, sourceRepoAllowlist: "my-org/*" },
    );

    expect(allowed).toEqual({ allowed: true });

    const denied = evaluateSourceWorkflowRun(
      {
        repository: { owner: { login: "other-org" }, name: "repo-b", default_branch: "main" },
        workflow_run: { name: "CI", path: "ci.yml", head_branch: "main", conclusion: "success" },
      },
      { ...baseSettings, sourceRepoAllowlist: "my-org/*" },
    );

    expect(denied).toEqual({ allowed: false, reason: "source_repo_not_allowlisted" });
  });
});
