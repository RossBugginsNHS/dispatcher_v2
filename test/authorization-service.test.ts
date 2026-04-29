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
});
