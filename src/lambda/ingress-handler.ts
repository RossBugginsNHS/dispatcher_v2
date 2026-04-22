import pino from "pino";
import { Webhooks } from "@octokit/webhooks";

import { env } from "../config/env.js";
import { enqueueJson, createEventBridgeClient, createSqsClient, publishFact } from "../async/clients.js";
import { DispatchFacts, type DispatchRequestAcceptedMessage } from "../async/contracts.js";
import type { WorkflowRunPayload } from "../github/types.js";
import { getSecretValue } from "./runtime-secrets.js";

const log = pino({ level: env.LOG_LEVEL });

type ApiGatewayV2Event = {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

type ApiGatewayV2Response = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

function getHeader(event: ApiGatewayV2Event, name: string): string | undefined {
  const headers = event.headers ?? {};
  const exact = headers[name];
  if (exact) {
    return exact;
  }
  const lower = headers[name.toLowerCase()];
  return lower;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> {
  if (event.rawPath === "/health") {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }

  if (event.rawPath !== "/webhooks/github") {
    return { statusCode: 404, body: JSON.stringify({ error: "Not Found" }) };
  }

  if (!env.DISPATCH_REQUESTS_QUEUE_URL || !env.DISPATCH_FACTS_EVENT_BUS_NAME) {
    log.error("Missing required environment for async ingress handler");
    return { statusCode: 500, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const webhookSecret = env.GITHUB_WEBHOOK_SECRET
    ?? (env.GITHUB_WEBHOOK_SECRET_ARN ? await getSecretValue(env.GITHUB_WEBHOOK_SECRET_ARN) : undefined);

  if (!webhookSecret) {
    log.error("Missing webhook secret configuration");
    return { statusCode: 500, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const body = event.body ?? "";
  const payload = event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  const deliveryId = getHeader(event, "x-github-delivery");
  const eventName = getHeader(event, "x-github-event");
  const signature = getHeader(event, "x-hub-signature-256");

  if (!deliveryId || !eventName || !signature || !payload) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required GitHub webhook headers or payload" }) };
  }

  const webhooks = new Webhooks({ secret: webhookSecret });

  try {
    await webhooks.verifyAndReceive({
      id: deliveryId,
      name: eventName,
      payload,
      signature,
    });
  } catch (error) {
    log.warn({ err: error, deliveryId, eventName }, "Rejected GitHub webhook");
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid webhook signature" }) };
  }

  if (eventName !== "workflow_run") {
    return { statusCode: 202, body: JSON.stringify({ accepted: true, ignored: true }) };
  }

  const parsed = JSON.parse(payload) as WorkflowRunPayload & { action?: string };
  if (parsed.action !== "completed") {
    return { statusCode: 202, body: JSON.stringify({ accepted: true, ignored: true }) };
  }

  const message: DispatchRequestAcceptedMessage = {
    deliveryId,
    eventName,
    receivedAt: new Date().toISOString(),
    payload: parsed,
  };

  const sqs = createSqsClient();
  const eb = createEventBridgeClient();

  await enqueueJson(sqs, env.DISPATCH_REQUESTS_QUEUE_URL, message);
  await publishFact(eb, env.DISPATCH_FACTS_EVENT_BUS_NAME, DispatchFacts.requestAccepted, {
    deliveryId,
    sourceRepo: `${parsed.repository.owner.login}/${parsed.repository.name}`,
    sourceWorkflow: parsed.workflow_run.path,
    sourceRunId: parsed.workflow_run.id,
  });

  return { statusCode: 202, body: JSON.stringify({ accepted: true }) };
}
