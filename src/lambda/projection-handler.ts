import pino from "pino";

import { env } from "../config/env.js";
import type { CloudEvent } from "../async/cloudevents.js";
import { appendDispatchEvent, createEventStoreClient, updateDispatchProjections } from "../async/event-store.js";

const log = pino({ level: env.LOG_LEVEL });

type EventBridgeEnvelope = {
  id: string;
  detail?: unknown;
};

type DispatchFactData = {
  sourceRepo?: string;
  sourceWorkflow?: string;
  sourceRunId?: number;
  targetRepo?: string;
  targetWorkflow?: string;
  deliveryId?: string;
  error?: string;
};

function isCloudEvent(value: unknown): value is CloudEvent<DispatchFactData> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CloudEvent<DispatchFactData>>;
  return candidate.specversion === "1.0"
    && typeof candidate.id === "string"
    && typeof candidate.source === "string"
    && typeof candidate.type === "string"
    && typeof candidate.subject === "string"
    && typeof candidate.time === "string"
    && typeof candidate.data === "object";
}

export async function handler(event: EventBridgeEnvelope): Promise<void> {
  if (!env.DISPATCH_EVENTS_TABLE_NAME || !env.DISPATCH_PROJECTIONS_TABLE_NAME) {
    throw new Error("DISPATCH_EVENTS_TABLE_NAME and DISPATCH_PROJECTIONS_TABLE_NAME must be set");
  }

  const cloudEvent = event.detail;
  if (!isCloudEvent(cloudEvent)) {
    log.warn({ eventId: event.id }, "Ignored non-CloudEvent detail");
    return;
  }

  const ddb = createEventStoreClient();

  await appendDispatchEvent({
    ddb,
    eventsTableName: env.DISPATCH_EVENTS_TABLE_NAME,
    event: cloudEvent,
  });

  await updateDispatchProjections({
    ddb,
    projectionsTableName: env.DISPATCH_PROJECTIONS_TABLE_NAME,
    event: cloudEvent,
  });
}
