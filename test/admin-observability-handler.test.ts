import { describe, expect, it } from "vitest";

import { handler, isAdminRequestAllowed } from "../src/lambda/admin-observability-handler.js";

describe("isAdminRequestAllowed", () => {
  it("allows all requests when allowlist is empty", () => {
    expect(isAdminRequestAllowed(undefined, new Set())).toBe(true);
    expect(isAdminRequestAllowed("1.2.3.4", new Set())).toBe(true);
  });

  it("rejects requests without source IP when allowlist is configured", () => {
    expect(isAdminRequestAllowed(undefined, new Set(["1.2.3.4"]))).toBe(false);
  });

  it("allows only matching IP addresses", () => {
    const allowlist = new Set(["1.2.3.4"]);
    expect(isAdminRequestAllowed("1.2.3.4", allowlist)).toBe(true);
    expect(isAdminRequestAllowed("4.3.2.1", allowlist)).toBe(false);
  });
});

describe("GET /admin/api/version", () => {
  it("returns 200 with version and imageSha fields", async () => {
    const event = {
      rawPath: "/admin/api/version",
      requestContext: { http: { sourceIp: "1.2.3.4" } },
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("imageSha");
    expect(typeof body.version).toBe("string");
    expect(typeof body.imageSha).toBe("string");
  });
});
