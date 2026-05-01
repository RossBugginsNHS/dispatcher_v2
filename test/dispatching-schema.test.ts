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

  it("parses an outbound target with an optional ref override", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml
        ref: release
`;
    const config = parseDispatchingConfig(yaml);

    expect(config.outbound[0].targets[0]).toEqual({
      repository: "my-target-repo",
      workflow: "cd.yml",
      ref: "release",
    });
  });

  it("omits ref from outbound target when not specified", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml
`;
    const config = parseDispatchingConfig(yaml);

    expect(config.outbound[0].targets[0]).toEqual({ repository: "my-target-repo", workflow: "cd.yml" });
    expect(config.outbound[0].targets[0].ref).toBeUndefined();
  });

  it("parses an outbound target with inputs", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml
        inputs:
          git_sha: "{{ source.sha }}"
          environment: production
`;
    const config = parseDispatchingConfig(yaml);

    expect(config.outbound[0].targets[0]).toEqual({
      repository: "my-target-repo",
      workflow: "cd.yml",
      inputs: {
        git_sha: "{{ source.sha }}",
        environment: "production",
      },
    });
  });

  it("parses an inbound target with accept_inputs", () => {
    const yaml = `
inbound:
  - source:
      repository: source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
        accept_inputs:
          - git_sha
          - environment
`;
    const config = parseDispatchingConfig(yaml);

    expect(config.inbound[0].targets[0]).toEqual({
      workflow: "cd.yml",
      accept_inputs: ["git_sha", "environment"],
    });
  });

  it("omits inputs from outbound target when not specified", () => {
    const yaml = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml
`;
    const config = parseDispatchingConfig(yaml);
    expect(config.outbound[0].targets[0].inputs).toBeUndefined();
  });

  it("omits accept_inputs from inbound target when not specified", () => {
    const yaml = `
inbound:
  - source:
      repository: source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
`;
    const config = parseDispatchingConfig(yaml);
    expect(config.inbound[0].targets[0].accept_inputs).toBeUndefined();
  });

  it("rejects outbound inputs with non-string values", () => {
    expect(() =>
      DispatchingConfigSchema.parse({
        outbound: [
          {
            source: { workflow: "ci.yml" },
            targets: [{ repository: "repo", workflow: "cd.yml", inputs: { key: 123 } }],
          },
        ],
        inbound: [],
      }),
    ).toThrow();
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
    expect(() => parseDispatchingConfig(yaml)).toThrow(/unique/i);
  });
});
