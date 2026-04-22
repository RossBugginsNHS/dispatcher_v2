import { describe, expect, it, vi } from "vitest";
import { Webhooks } from "@octokit/webhooks";

import { buildServer } from "../src/server.js";

describe("POST /webhooks/github", () => {
  it("rejects invalid signatures", async () => {
    const app = await buildServer({ githubWebhookSecret: "test-secret" });

    const payload = JSON.stringify({ action: "completed", workflow_run: { id: 1 } });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": "sha256=invalid",
      },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("accepts valid workflow_run.completed webhooks", async () => {
    const onWorkflowRunCompleted = vi.fn();
    const app = await buildServer({
      githubWebhookSecret: "test-secret",
      onWorkflowRunCompleted,
    });

    const payload = JSON.stringify({
      action: "completed",
      workflow_run: { id: 123 },
      repository: { full_name: "owner/repo" },
    });

    const webhooks = new Webhooks({ secret: "test-secret" });
    const signature = await webhooks.sign(payload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(onWorkflowRunCompleted).toHaveBeenCalledTimes(1);
    expect(onWorkflowRunCompleted).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        deliveryId: "delivery-2",
        eventName: "workflow_run",
      }),
    );

    await app.close();
  });

  it("rejects duplicate webhook deliveries", async () => {
    const onWorkflowRunCompleted = vi.fn();
    const app = await buildServer({
      githubWebhookSecret: "test-secret",
      onWorkflowRunCompleted,
    });

    const payload = JSON.stringify({
      action: "completed",
      workflow_run: { id: 321 },
      repository: { full_name: "owner/repo" },
    });

    const webhooks = new Webhooks({ secret: "test-secret" });
    const signature = await webhooks.sign(payload);

    const headers = {
      "content-type": "application/json",
      "x-github-delivery": "delivery-duplicate",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signature,
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers,
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers,
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(409);
    expect(onWorkflowRunCompleted).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("rejects malformed payload even with valid signature", async () => {
    const onWorkflowRunCompleted = vi.fn();
    const app = await buildServer({
      githubWebhookSecret: "test-secret",
      onWorkflowRunCompleted,
    });

    const payload = "not-json";
    const webhooks = new Webhooks({ secret: "test-secret" });
    const signature = await webhooks.sign(payload);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-malformed",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(onWorkflowRunCompleted).not.toHaveBeenCalled();

    await app.close();
  });

  it("rate limits excessive webhook requests from the same source", async () => {
    const onWorkflowRunCompleted = vi.fn();
    const app = await buildServer({
      githubWebhookSecret: "test-secret",
      onWorkflowRunCompleted,
    });

    const payload = JSON.stringify({
      action: "completed",
      workflow_run: { id: 456 },
      repository: { full_name: "owner/repo" },
    });
    const webhooks = new Webhooks({ secret: "test-secret" });
    const signature = await webhooks.sign(payload);

    let finalStatus = 0;
    // 100 requests are allowed per minute; the 101st must be throttled.
    for (let attempt = 0; attempt < 101; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/github",
        payload,
        headers: {
          "content-type": "application/json",
          "x-github-delivery": `delivery-rate-${attempt}`,
          "x-github-event": "workflow_run",
          "x-hub-signature-256": signature,
        },
      });
      finalStatus = response.statusCode;
    }

    expect(finalStatus).toBe(429);
    expect(onWorkflowRunCompleted).toHaveBeenCalledTimes(100);

    await app.close();
  });
});
