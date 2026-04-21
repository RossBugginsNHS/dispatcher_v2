import { describe, expect, it } from "vitest";

import { fetchDispatchingConfig, type RepoContentsClient } from "../src/github/content.js";

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function makeClient(response: { data: unknown } | { throws: Error }): RepoContentsClient {
  return {
    repos: {
      getContent: () => {
        if ("throws" in response) {
          return Promise.reject(response.throws);
        }
        return Promise.resolve(response as { data: { type: string; content: string; encoding: string } });
      },
    },
  };
}

function makePathAwareClient(
  responsesByPath: Record<string, { data: unknown } | { throws: Error }>,
): RepoContentsClient {
  return {
    repos: {
      getContent: ({ path }) => {
        const response = responsesByPath[path];
        if (!response) {
          return Promise.reject(new HttpError("Not Found", 404));
        }
        if ("throws" in response) {
          return Promise.reject(response.throws);
        }
        return Promise.resolve(response as { data: { type: string; content: string; encoding: string } });
      },
    },
  };
}

function encodeYaml(yaml: string): string {
  return Buffer.from(yaml).toString("base64");
}

const VALID_YAML = `
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: target-repo
        workflow: cd.yml
`;

describe("fetchDispatchingConfig", () => {
  it("returns found:true with parsed config for a valid file", async () => {
    const client = makeClient({
      data: { type: "file", content: encodeYaml(VALID_YAML), encoding: "base64" },
    });

    const result = await fetchDispatchingConfig(client, "owner", "repo");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.config.outbound).toHaveLength(1);
    }
  });

  it("returns found:false reason:missing when API returns 404", async () => {
    const client = makeClient({ throws: new HttpError("Not Found", 404) });

    const result = await fetchDispatchingConfig(client, "owner", "repo");

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("missing");
    }
  });

  it("falls back to .github/dispatching.yml when root dispatching.yml is missing", async () => {
    const client = makePathAwareClient({
      "dispatching.yml": { throws: new HttpError("Not Found", 404) },
      ".github/dispatching.yml": {
        data: { type: "file", content: encodeYaml(VALID_YAML), encoding: "base64" },
      },
    });

    const result = await fetchDispatchingConfig(client, "owner", "repo");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.config.outbound).toHaveLength(1);
    }
  });

  it("returns found:false reason:missing when data is a directory listing", async () => {
    const client = makeClient({ data: [{ name: "file.txt" }] });

    const result = await fetchDispatchingConfig(client, "owner", "repo");

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("missing");
    }
  });

  it("returns found:false reason:invalid when YAML fails schema validation", async () => {
    const invalidYaml = "outbound: not-a-list";
    const client = makeClient({
      data: { type: "file", content: encodeYaml(invalidYaml), encoding: "base64" },
    });

    const result = await fetchDispatchingConfig(client, "owner", "repo");

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("invalid");
    }
  });

  it("re-throws unexpected errors from the API", async () => {
    const client = makeClient({ throws: new Error("network error") });

    await expect(fetchDispatchingConfig(client, "owner", "repo")).rejects.toThrow("network error");
  });
});
