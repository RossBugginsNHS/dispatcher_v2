import { describe, expect, it } from "vitest";

import { authorizeDispatchTargets } from "../src/services/authorization-service.js";
import { type ResolvedDispatchTarget } from "../src/domain/trigger-matcher/match.js";

const CANDIDATES: ResolvedDispatchTarget[] = [
  { owner: "source-owner", repo: "target-a", workflow: "deploy.yml" },
  { owner: "other-owner", repo: "target-b", workflow: "release.yml" },
];

describe("authorizeDispatchTargets", () => {
  it("allows target when inbound rule authorizes source repo and workflow", async () => {
    const result = await authorizeDispatchTargets(
      [CANDIDATES[0]],
      "source-owner/source-repo",
      "source-repo",
      ".github/workflows/ci.yml",
      () => ({
        found: true,
        config: {
          outbound: [],
          inbound: [
            {
              source: { repository: "source-repo", workflow: "ci.yml" },
              targets: [{ workflow: ".github/workflows/deploy.yml" }],
            },
          ],
        },
      }),
    );

    expect(result.allowed).toEqual([CANDIDATES[0]]);
    expect(result.denied).toEqual([]);
  });

  it("supports inbound source.repository as full repo name", async () => {
    const result = await authorizeDispatchTargets(
      [CANDIDATES[0]],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () => ({
        found: true,
        config: {
          outbound: [],
          inbound: [
            {
              source: { repository: "source-owner/source-repo", workflow: "ci.yml" },
              targets: [{ workflow: "deploy.yml" }],
            },
          ],
        },
      }),
    );

    expect(result.allowed).toEqual([CANDIDATES[0]]);
    expect(result.denied).toEqual([]);
  });

  it("denies target when target dispatching.yml is missing", async () => {
    const result = await authorizeDispatchTargets(
      [CANDIDATES[0]],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () => ({ found: false, reason: "missing" }),
    );

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([
      {
        target: CANDIDATES[0],
        reason: "missing_target_config",
      },
    ]);
  });

  it("denies target when inbound rules do not authorize workflow", async () => {
    const result = await authorizeDispatchTargets(
      [CANDIDATES[1]],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () => ({
        found: true,
        config: {
          outbound: [],
          inbound: [
            {
              source: { repository: "source-repo", workflow: "ci.yml" },
              targets: [{ workflow: "deploy.yml" }],
            },
          ],
        },
      }),
    );

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([
      {
        target: CANDIDATES[1],
        reason: "inbound_not_authorized",
      },
    ]);
  });

  it("allows target when sent inputs are all listed in accept_inputs", async () => {
    const targetWithInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
      inputs: { git_sha: "abc123", environment: "production" },
    };

    const result = await authorizeDispatchTargets(
      [targetWithInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml", accept_inputs: ["git_sha", "environment"] }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([targetWithInputs]);
    expect(result.denied).toEqual([]);
  });

  it("denies target when inputs are sent but accept_inputs is not declared", async () => {
    const targetWithInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
      inputs: { git_sha: "abc123" },
    };

    const result = await authorizeDispatchTargets(
      [targetWithInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml" }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([{ target: targetWithInputs, reason: "inputs_not_accepted" }]);
  });

  it("denies target when a sent input key is not in accept_inputs", async () => {
    const targetWithInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
      inputs: { git_sha: "abc123", extra_key: "value" },
    };

    const result = await authorizeDispatchTargets(
      [targetWithInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml", accept_inputs: ["git_sha"] }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([{ target: targetWithInputs, reason: "inputs_not_accepted" }]);
  });

  it("allows target when no inputs are sent even if accept_inputs is declared", async () => {
    const targetNoInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
    };

    const result = await authorizeDispatchTargets(
      [targetNoInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml", accept_inputs: ["git_sha"] }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([targetNoInputs]);
    expect(result.denied).toEqual([]);
  });

  it("allows target when no inputs are sent and accept_inputs is not declared", async () => {
    const targetNoInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
    };

    const result = await authorizeDispatchTargets(
      [targetNoInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml" }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([targetNoInputs]);
    expect(result.denied).toEqual([]);
  });

  it("allows target when a second matching rule accepts the sent inputs even if the first does not", async () => {
    const targetWithInputs: ResolvedDispatchTarget = {
      owner: "source-owner",
      repo: "target-a",
      workflow: "deploy.yml",
      inputs: { git_sha: "abc123", environment: "staging" },
    };

    const result = await authorizeDispatchTargets(
      [targetWithInputs],
      "source-owner/source-repo",
      "source-repo",
      "ci.yml",
      () =>
        Promise.resolve({
          found: true,
          config: {
            outbound: [],
            inbound: [
              // First rule: only accepts git_sha — not sufficient
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml", accept_inputs: ["git_sha"] }],
              },
              // Second rule: accepts both keys — sufficient
              {
                source: { repository: "source-repo", workflow: "ci.yml" },
                targets: [{ workflow: "deploy.yml", accept_inputs: ["git_sha", "environment"] }],
              },
            ],
          },
        }),
    );

    expect(result.allowed).toEqual([targetWithInputs]);
    expect(result.denied).toEqual([]);
  });
});
