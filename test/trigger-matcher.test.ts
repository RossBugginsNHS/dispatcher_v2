import { describe, expect, it } from "vitest";

import { matchOutboundTargets, normalizeWorkflowName } from "../src/domain/trigger-matcher/match.js";
import { type DispatchingConfig } from "../src/domain/dispatching-schema/schema.js";

describe("normalizeWorkflowName", () => {
  it("extracts workflow file name from a full path", () => {
    expect(normalizeWorkflowName(".github/workflows/ci.yml")).toBe("ci.yml");
  });

  it("returns value unchanged when not a path", () => {
    expect(normalizeWorkflowName("ci.yml")).toBe("ci.yml");
  });
});

describe("matchOutboundTargets", () => {
  it("matches outbound targets for the completed workflow", () => {
    const config: DispatchingConfig = {
      outbound: [
        {
          source: { workflow: "ci.yml" },
          targets: [
            { repository: "target-a", workflow: "deploy.yml" },
            { repository: "other-owner/target-b", workflow: ".github/workflows/release.yml" },
          ],
        },
        {
          source: { workflow: "lint.yml" },
          targets: [{ repository: "target-c", workflow: "test.yml" }],
        },
      ],
      inbound: [],
    };

    const targets = matchOutboundTargets(config, "source-owner", ".github/workflows/ci.yml");

    expect(targets).toEqual([
      { owner: "source-owner", repo: "target-a", workflow: "deploy.yml" },
      { owner: "other-owner", repo: "target-b", workflow: "release.yml" },
    ]);
  });

  it("returns no targets when workflow does not match any outbound rule", () => {
    const config: DispatchingConfig = {
      outbound: [
        {
          source: { workflow: "ci.yml" },
          targets: [{ repository: "target-a", workflow: "deploy.yml" }],
        },
      ],
      inbound: [],
    };

    const targets = matchOutboundTargets(config, "source-owner", ".github/workflows/docs.yml");

    expect(targets).toEqual([]);
  });
});
