import { describe, expect, it } from "vitest";

import { resolveInputs, type SourceContext } from "../src/domain/template-resolver/resolve.js";

const baseContext: SourceContext = {
  sha: "abc123def456abc123def456abc123def456abc1",
  head_branch: "main",
  run_id: "987654321",
  run_url: "https://github.com/org/repo/actions/runs/987654321",
  repo: "org/repo",
  workflow: "ci.yml",
};

describe("resolveInputs", () => {
  it("resolves source.sha template variable", () => {
    const result = resolveInputs({ git_sha: "{{ source.sha }}" }, baseContext);
    expect(result).toEqual({ resolved: { git_sha: baseContext.sha } });
  });

  it("resolves source.head_branch template variable", () => {
    const result = resolveInputs({ branch: "{{ source.head_branch }}" }, baseContext);
    expect(result).toEqual({ resolved: { branch: "main" } });
  });

  it("resolves source.run_id template variable", () => {
    const result = resolveInputs({ run: "{{ source.run_id }}" }, baseContext);
    expect(result).toEqual({ resolved: { run: "987654321" } });
  });

  it("resolves source.run_url template variable", () => {
    const result = resolveInputs({ url: "{{ source.run_url }}" }, baseContext);
    expect(result).toEqual({ resolved: { url: baseContext.run_url } });
  });

  it("resolves source.repo template variable", () => {
    const result = resolveInputs({ repo: "{{ source.repo }}" }, baseContext);
    expect(result).toEqual({ resolved: { repo: "org/repo" } });
  });

  it("resolves source.workflow template variable", () => {
    const result = resolveInputs({ wf: "{{ source.workflow }}" }, baseContext);
    expect(result).toEqual({ resolved: { wf: "ci.yml" } });
  });

  it("passes through literal string values unchanged", () => {
    const result = resolveInputs({ environment: "production" }, baseContext);
    expect(result).toEqual({ resolved: { environment: "production" } });
  });

  it("resolves a mix of template and literal values", () => {
    const result = resolveInputs(
      {
        git_sha: "{{ source.sha }}",
        environment: "staging",
        run_url: "{{ source.run_url }}",
      },
      baseContext,
    );
    expect(result).toEqual({
      resolved: {
        git_sha: baseContext.sha,
        environment: "staging",
        run_url: baseContext.run_url,
      },
    });
  });

  it("handles templates with extra whitespace around the variable name", () => {
    const result = resolveInputs({ sha: "{{  source.sha  }}" }, baseContext);
    expect(result).toEqual({ resolved: { sha: baseContext.sha } });
  });

  it("returns an error for an unknown template variable", () => {
    const result = resolveInputs({ bad: "{{ source.unknown_var }}" }, baseContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/unknown template variable/i);
    expect((result as { error: string }).error).toContain("source.unknown_var");
  });

  it("returns an error listing supported variables when an unknown variable is used", () => {
    const result = resolveInputs({ bad: "{{ source.not_real }}" }, baseContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("source.sha");
  });

  it("returns an empty resolved object when templateInputs is empty", () => {
    const result = resolveInputs({}, baseContext);
    expect(result).toEqual({ resolved: {} });
  });

  it("returns an error when a resolved value exceeds the maximum length", () => {
    const longValue = "x".repeat(1025);
    const result = resolveInputs({ key: longValue }, baseContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/maximum length/i);
  });

  it("returns an error when a resolved value contains a newline character", () => {
    const result = resolveInputs({ key: "line1\nline2" }, baseContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/control characters/i);
  });

  it("returns an error when a resolved value contains a null byte", () => {
    const result = resolveInputs({ key: "val\x00ue" }, baseContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/control characters/i);
  });

  it("stops at the first unknown variable when multiple inputs are defined", () => {
    const result = resolveInputs(
      {
        good: "{{ source.sha }}",
        bad: "{{ source.nonexistent }}",
      },
      baseContext,
    );
    expect(result).toHaveProperty("error");
  });
});
