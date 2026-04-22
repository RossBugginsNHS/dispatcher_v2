import type { FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import rateLimit from "@fastify/rate-limit";
import { Webhooks } from "@octokit/webhooks";

import type { WorkflowRunEventContext, WorkflowRunPayload } from "./types.js";

type WorkflowRunCompletedHandler = (
  payload: WorkflowRunPayload,
  context: WorkflowRunEventContext,
) => Promise<void> | void;

export type RegisterGitHubWebhookHandlerOptions = {
  secret: string;
  onWorkflowRunCompleted?: WorkflowRunCompletedHandler;
};

type RequestWithRawBody = {
  rawBody?: string;
  headers: Record<string, string | string[] | undefined>;
};

const DELIVERY_ID_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const DELIVERY_ID_PRUNE_INTERVAL_MS = 60 * 1000;
const WEBHOOK_RATE_LIMIT_WINDOW = "1 minute";
const WEBHOOK_RATE_LIMIT_MAX_REQUESTS_PER_IP = 100;

export async function registerGitHubWebhookHandler(
  app: FastifyInstance,
  options: RegisterGitHubWebhookHandlerOptions,
): Promise<void> {
  const webhooks = new Webhooks({ secret: options.secret });
  const seenDeliveryIds = new Map<string, number>();
  const pruneTimer = setInterval(() => {
    pruneExpiredDeliveryIds(seenDeliveryIds, Date.now());
  }, DELIVERY_ID_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  webhooks.on("workflow_run.completed", async ({ id, payload }) => {
    app.log.info({ deliveryId: id }, "Received workflow_run.completed event");
    await options.onWorkflowRunCompleted?.(payload, {
      deliveryId: id,
      eventName: "workflow_run",
    });
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    runFirst: true,
    encoding: "utf8",
  });
  await app.register(rateLimit, {
    global: false,
  });

  app.post(
    "/webhooks/github",
    {
      config: {
        rawBody: true,
        rateLimit: {
          max: WEBHOOK_RATE_LIMIT_MAX_REQUESTS_PER_IP,
          timeWindow: WEBHOOK_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const req = request as typeof request & RequestWithRawBody;
      const payload = req.rawBody;
      const deliveryId = req.headers["x-github-delivery"];
      const eventName = req.headers["x-github-event"];
      const signature = req.headers["x-hub-signature-256"];

      if (
        typeof payload !== "string" ||
        typeof deliveryId !== "string" ||
        typeof eventName !== "string" ||
        typeof signature !== "string"
      ) {
        return reply.code(400).send({ error: "Missing required GitHub webhook headers or payload" });
      }

      const isValidSignature = await webhooks.verify(payload, signature);
      if (!isValidSignature) {
        app.log.warn({ deliveryId, eventName }, "Rejected GitHub webhook with invalid signature");
        return reply.code(401).send({ error: "Invalid webhook signature" });
      }

      const now = Date.now();
      if (seenDeliveryIds.has(deliveryId)) {
        app.log.warn({ deliveryId, eventName }, "Rejected duplicate GitHub webhook delivery");
        return reply.code(409).send({ error: "Duplicate webhook delivery" });
      }

      try {
        await webhooks.verifyAndReceive({
          id: deliveryId,
          name: eventName,
          payload,
          signature,
        });
        seenDeliveryIds.set(deliveryId, now);

        return reply.code(202).send({ accepted: true });
      } catch (error) {
        app.log.warn({ err: error, deliveryId, eventName }, "Rejected GitHub webhook");
        return reply.code(400).send({ error: "Failed to process webhook" });
      }
    },
  );
}

function pruneExpiredDeliveryIds(seenDeliveryIds: Map<string, number>, now: number): void {
  for (const [deliveryId, timestamp] of seenDeliveryIds.entries()) {
    if (now - timestamp > DELIVERY_ID_REPLAY_WINDOW_MS) {
      seenDeliveryIds.delete(deliveryId);
    }
  }
}
