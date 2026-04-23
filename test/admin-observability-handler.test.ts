import { describe, expect, it } from "vitest";

import { isAdminRequestAllowed } from "../src/lambda/admin-observability-handler.js";

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
