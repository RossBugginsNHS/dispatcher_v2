import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  it("returns 200 and status ok", async () => {
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
