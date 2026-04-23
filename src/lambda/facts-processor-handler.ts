import pino from "pino";

import { env } from "../config/env.js";
import {
  appendDispatchEvent,
  createEventStoreClient,
  updateDispatchProjections,
} from "../async/event-store.js";

const log = pino({ level: env.LOG_LEVEL });

type FactDetail = {
  sourceRepo?: string;
  sourceWorkflow?: string;
  sourceRunId?: number;
  targetRepo?: string;
  targetWorkflow?: string;
  deliveryId?: string;
  allowedTargets?: number;
  error?: string;
};

type EventBridgeRecord = {
  id: string;
  source: string;
  "detail-type": string;
  time: string;
  detail: FactDetail;
};

type EventBridgeBatch = {
  Records?: EventBridgeRecord[];
};

function normalizeRecords(event: unknown): EventBridgeRecord[] {
  if (Array.isArray((event as EventBridgeBatch).Records)) {
    return ((event as EventBridgeBatch).Records ?? []) as EventBridgeRecord[];
  }
  return [event as EventBridgeRecord];
}

export async function handler(event: unknown): Promise<void> {
  if (!env.DISPATCH_EVENTS_TABLE_NAME || !env.DISPATCH_PROJECTIONS_TABLE_NAME) {
    throw new Error("DISPATCH_EVENTS_TABLE_NAME and DISPATCH_PROJECTIONS_TABLE_NAME must be set");
  }

  const ddb = createEventStoreClient();
  const records = normalizeRecords(event);

  for (const record of records) {
    const sourceRepo = record.detail?.sourceRepo ?? "unknown";
    const cloudEvent = {
      id: record.id,
      source: record.source,
      type: record["detail-type"],
      subject: sourceRepo,
      time: record.time,
      appversion: env.APP_VERSION,
      data: {
        ...record.detail,
        sourceRepo,
      },
    };

    try {
      await appendDispatchEvent({
        ddb,
        eventsTableName: env.DISPATCH_EVENTS_TABLE_NAME,
        event: cloudEvent as never,
      });

      await updateDispatchProjections({
        ddb,
        projectionsTableName: env.DISPATCH_PROJECTIONS_TABLE_NAME,
        event: cloudEvent as never,
      });
    } catch (error) {
      // EventBridge retries on function errors, so rethrow after logging.
      log.error({ err: error, id: record.id, detailType: record["detail-type"] }, "Failed processing dispatch fact");
      throw error;
    }
  }
}
