import { describe, expect, it } from "vitest";

import { parseDispatchingConfig, DispatchingConfigSchema } from "../src/domain/dispatching-schema/schema.js";

describe("parseDispatchingConfig", () => {
  it("parses a valid config with outbound and inbound rules", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml

inbound:
  - source:
      repository: my-source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
`;
    const config = parseDispatchingConfig(yaml);

    expect(config.outbound).toHaveLength(1);
    expect(config.outbound[0].source.workflow).toBe("ci.yml");
    expect(config.outbound[0].targets[0]).toEqual({ repository: "my-target-repo", workflow: "cd.yml" });

    expect(config.inbound).toHaveLength(1);
    expect(config.inbound[0].source).toEqual({ repository: "my-source-repo", workflow: "ci.yml" });
    expect(config.inbound[0].targets[0]).toEqual({ workflow: "cd.yml" });
  });

  it("defaults outbound and inbound to empty arrays when omitted", () => {
    const config = parseDispatchingConfig("{}");
    expect(config.outbound).toEqual([]);
    expect(config.inbound).toEqual([]);
  });

  it("throws on invalid YAML structure", () => {
    expect(() => parseDispatchingConfig("outbound: not-an-array")).toThrow();
  });

  it("throws when outbound rule is missing required fields", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets: []
`;
    expect(() => parseDispatchingConfig(yaml)).toThrow();
  });

  it("throws when inbound rule is missing source.repository", () => {
    const yaml = `
inbound:
  - source:
      workflow: ci.yml
    targets:
      - workflow: cd.yml
`;
    expect(() => parseDispatchingConfig(yaml)).toThrow();
  });
});

describe("DispatchingConfigSchema", () => {
  it("rejects unknown keys", () => {
    expect(() =>
      DispatchingConfigSchema.parse({
        outbound: [],
        inbound: [],
        unknown_field: "should not be accepted",
      }),
    ).toThrow();
  });

  it("rejects duplicate YAML keys", () => {
    const yaml = `
outbound: []
outbound: []
`;
    expect(() => parseDispatchingConfig(yaml)).toThrow();
  });
});
