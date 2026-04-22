import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CloudEvent } from "./cloudevents.js";

type DispatchFactData = {
  sourceRepo?: string;
  sourceWorkflow?: string;
  sourceRunId?: number;
  targetRepo?: string;
  targetWorkflow?: string;
  deliveryId?: string;
  allowedTargets?: number;
  error?: string;
};

type StoredDispatchEvent = {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk?: string;
  gsi2sk?: string;
  id: string;
  type: string;
  source: string;
  subject: string;
  time: string;
  appversion?: string;
  traceparent?: string;
  tracestate?: string;
  sourceRepo?: string;
  sourceWorkflow?: string;
  sourceRunId?: number;
  targetRepo?: string;
  targetWorkflow?: string;
  deliveryId?: string;
  error?: string;
  event: CloudEvent<DispatchFactData>;
};

type SummaryProjection = {
  totalEvents: number;
  triggerSucceeded: number;
  triggerFailed: number;
  targetQueued: number;
  planCreated: number;
  requestAccepted: number;
  lastEventAt?: string;
};

export type RepoStats = {
  repo: string;
  totalEvents: number;
  triggerSucceeded: number;
  triggerFailed: number;
  requestAccepted: number;
  lastEventAt?: string;
};

export type HealthStatus = {
  status: "green" | "amber" | "red" | "unknown";
  reasons: string[];
  successRate?: number;
  lastEventAt?: string;
  totalEvents: number;
};

export type StoredEvent = {
  id: string;
  type: string;
  source: string;
  subject: string;
  time: string;
  appversion?: string;
  traceparent?: string;
  sourceRepo?: string;
  targetRepo?: string;
  deliveryId?: string;
  error?: string;
};

export type RepoWindowCount = {
  repo: string;
  count: number;
};

function minuteBucket(timestampIso: string): string {
  const minute = timestampIso.slice(0, 16).replaceAll(/[-:T]/gu, "");
  return `minute#${minute}`;
}

function fiveMinuteBucket(timestampIso: string): string {
  const timestamp = new Date(timestampIso);
  timestamp.setUTCSeconds(0, 0);
  const flooredMinute = timestamp.getUTCMinutes() - (timestamp.getUTCMinutes() % 5);
  timestamp.setUTCMinutes(flooredMinute);
  const bucket = timestamp.toISOString().slice(0, 16).replaceAll(/[-:T]/gu, "");
  return `window5m#${bucket}`;
}

function normalizeEventCountKey(eventType: string): string {
  if (eventType.endsWith("request.accepted")) {
    return "requestAccepted";
  }
  if (eventType.endsWith("plan.created")) {
    return "planCreated";
  }
  if (eventType.endsWith("target.queued")) {
    return "targetQueued";
  }
  if (eventType.endsWith("trigger.succeeded")) {
    return "triggerSucceeded";
  }
  if (eventType.endsWith("trigger.failed")) {
    return "triggerFailed";
  }

  const suffix = eventType.split(".").pop() ?? "unknown";
  return suffix.replaceAll(/[^a-zA-Z0-9]/gu, "");
}

function deduceSourceRepo(event: CloudEvent<DispatchFactData>): string {
  return event.data.sourceRepo ?? event.subject ?? "unknown";
}

function deduceTargetRepo(event: CloudEvent<DispatchFactData>): string | undefined {
  return event.data.targetRepo;
}

function toStatus(eventType: string): "success" | "failed" | "other" {
  if (eventType.endsWith("trigger.succeeded")) {
    return "success";
  }
  if (eventType.endsWith("trigger.failed")) {
    return "failed";
  }
  return "other";
}

export function createEventStoreClient(): DynamoDBDocumentClient {
  const client = new DynamoDBClient({});
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export async function appendDispatchEvent(params: {
  ddb: DynamoDBDocumentClient;
  eventsTableName: string;
  event: CloudEvent<DispatchFactData>;
}): Promise<void> {
  const sourceRepo = deduceSourceRepo(params.event);
  const deliveryId = params.event.data.deliveryId;
  const sk = `${params.event.time}#${params.event.id}`;
  const item: StoredDispatchEvent = {
    pk: `repo#${sourceRepo}`,
    sk,
    gsi1pk: "all",
    gsi1sk: sk,
    gsi2pk: deliveryId ? `delivery#${deliveryId}` : undefined,
    gsi2sk: deliveryId ? sk : undefined,
    id: params.event.id,
    type: params.event.type,
    source: params.event.source,
    subject: params.event.subject,
    time: params.event.time,
    appversion: params.event.appversion,
    traceparent: params.event.traceparent,
    tracestate: params.event.tracestate,
    sourceRepo: params.event.data.sourceRepo,
    sourceWorkflow: params.event.data.sourceWorkflow,
    sourceRunId: params.event.data.sourceRunId,
    targetRepo: deduceTargetRepo(params.event),
    targetWorkflow: params.event.data.targetWorkflow,
    deliveryId,
    error: params.event.data.error,
    event: params.event,
  };

  await params.ddb.send(
    new PutCommand({
      TableName: params.eventsTableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    }),
  );
}

export async function updateDispatchProjections(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  event: CloudEvent<DispatchFactData>;
}): Promise<void> {
  const sourceRepo = deduceSourceRepo(params.event);
  const eventCountKey = normalizeEventCountKey(params.event.type);

  await params.ddb.send(
    new UpdateCommand({
      TableName: params.projectionsTableName,
      Key: { pk: "summary", sk: "global" },
      UpdateExpression:
        "SET totalEvents = if_not_exists(totalEvents, :zero) + :one, "
        + "#eventCount = if_not_exists(#eventCount, :zero) + :one, lastEventAt = :time",
      ExpressionAttributeNames: {
        "#eventCount": eventCountKey,
      },
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":time": params.event.time,
      },
    }),
  );

  await params.ddb.send(
    new UpdateCommand({
      TableName: params.projectionsTableName,
      Key: { pk: `repo#${sourceRepo}`, sk: "stats" },
      UpdateExpression:
        "SET repo = :repo, totalEvents = if_not_exists(totalEvents, :zero) + :one, "
        + "#eventCount = if_not_exists(#eventCount, :zero) + :one, lastEventAt = :time",
      ExpressionAttributeNames: {
        "#eventCount": eventCountKey,
      },
      ExpressionAttributeValues: {
        ":repo": sourceRepo,
        ":zero": 0,
        ":one": 1,
        ":time": params.event.time,
      },
    }),
  );

  await params.ddb.send(
    new UpdateCommand({
      TableName: params.projectionsTableName,
      Key: { pk: minuteBucket(params.event.time), sk: `repo#${sourceRepo}` },
      UpdateExpression: "SET repo = :repo, #count = if_not_exists(#count, :zero) + :one",
      ExpressionAttributeNames: {
        "#count": "count",
      },
      ExpressionAttributeValues: {
        ":repo": sourceRepo,
        ":zero": 0,
        ":one": 1,
      },
    }),
  );

  // Pre-aggregated 5-minute window; read APIs query this directly.
  await params.ddb.send(
    new UpdateCommand({
      TableName: params.projectionsTableName,
      Key: { pk: fiveMinuteBucket(params.event.time), sk: `repo#${sourceRepo}` },
      UpdateExpression: "SET repo = :repo, #count = if_not_exists(#count, :zero) + :one",
      ExpressionAttributeNames: {
        "#count": "count",
      },
      ExpressionAttributeValues: {
        ":repo": sourceRepo,
        ":zero": 0,
        ":one": 1,
      },
    }),
  );

  if (toStatus(params.event.type) === "failed") {
    await params.ddb.send(
      new PutCommand({
        TableName: params.projectionsTableName,
        Item: {
          pk: "failures",
          sk: `${params.event.time}#${params.event.id}`,
          sourceRepo,
          targetRepo: deduceTargetRepo(params.event),
          type: params.event.type,
          error: params.event.data.error,
          deliveryId: params.event.data.deliveryId,
        },
      }),
    );
  }

  // Hourly counter for rate calculations
  const hourBucket = params.event.time.slice(0, 13).replaceAll(/[-:T]/gu, "");
  await params.ddb.send(
    new UpdateCommand({
      TableName: params.projectionsTableName,
      Key: { pk: `hour#${hourBucket}`, sk: "global" },
      UpdateExpression:
        "SET totalEvents = if_not_exists(totalEvents, :zero) + :one, "
        + "#eventCount = if_not_exists(#eventCount, :zero) + :one, bucketAt = :bucket",
      ExpressionAttributeNames: { "#eventCount": eventCountKey },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":bucket": params.event.time.slice(0, 13) },
    }),
  );

  // Per-delivery funnel tracking
  const deliveryId = params.event.data.deliveryId;
  if (deliveryId) {
    await updateDeliveryFunnel({
      ddb: params.ddb,
      projectionsTableName: params.projectionsTableName,
      event: params.event,
      sourceRepo,
      deliveryId,
    });
  }
}

async function updateDeliveryFunnel(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  event: CloudEvent<DispatchFactData>;
  sourceRepo: string;
  deliveryId: string;
}): Promise<void> {
  const { event, sourceRepo, deliveryId } = params;
  const eventType = event.type;

  if (eventType.endsWith("request.accepted")) {
    await params.ddb.send(
      new UpdateCommand({
        TableName: params.projectionsTableName,
        Key: { pk: `delivery#${deliveryId}`, sk: "funnel" },
        UpdateExpression:
          "SET sourceRepo = :repo, requestAcceptedAt = if_not_exists(requestAcceptedAt, :time), "
          + "appversion = if_not_exists(appversion, :ver), lastUpdatedAt = :time",
        ExpressionAttributeValues: {
          ":repo": sourceRepo,
          ":time": event.time,
          ":ver": event.appversion ?? "unknown",
        },
      }),
    );
  } else if (eventType.endsWith("plan.created")) {
    await params.ddb.send(
      new UpdateCommand({
        TableName: params.projectionsTableName,
        Key: { pk: `delivery#${deliveryId}`, sk: "funnel" },
        UpdateExpression:
          "SET planCreatedAt = if_not_exists(planCreatedAt, :time), "
          + "allowedTargets = if_not_exists(allowedTargets, :allowed), lastUpdatedAt = :time",
        ExpressionAttributeValues: {
          ":time": event.time,
          ":allowed": event.data.allowedTargets ?? 0,
        },
      }),
    );
  } else if (eventType.endsWith("target.queued")) {
    await params.ddb.send(
      new UpdateCommand({
        TableName: params.projectionsTableName,
        Key: { pk: `delivery#${deliveryId}`, sk: "funnel" },
        UpdateExpression:
          "SET lastTargetQueuedAt = :time, lastUpdatedAt = :time, "
          + "queuedCount = if_not_exists(queuedCount, :zero) + :one",
        ExpressionAttributeValues: { ":time": event.time, ":zero": 0, ":one": 1 },
      }),
    );
  } else if (eventType.endsWith("trigger.succeeded")) {
    await params.ddb.send(
      new UpdateCommand({
        TableName: params.projectionsTableName,
        Key: { pk: `delivery#${deliveryId}`, sk: "funnel" },
        UpdateExpression:
          "SET lastUpdatedAt = :time, "
          + "succeededCount = if_not_exists(succeededCount, :zero) + :one",
        ExpressionAttributeValues: { ":time": event.time, ":zero": 0, ":one": 1 },
      }),
    );
  } else if (eventType.endsWith("trigger.failed")) {
    await params.ddb.send(
      new UpdateCommand({
        TableName: params.projectionsTableName,
        Key: { pk: `delivery#${deliveryId}`, sk: "funnel" },
        UpdateExpression:
          "SET lastUpdatedAt = :time, "
          + "failedCount = if_not_exists(failedCount, :zero) + :one",
        ExpressionAttributeValues: { ":time": event.time, ":zero": 0, ":one": 1 },
      }),
    );
  }
}

export async function readSummaryProjection(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
}): Promise<SummaryProjection> {
  const response = await params.ddb.send(
    new GetCommand({
      TableName: params.projectionsTableName,
      Key: { pk: "summary", sk: "global" },
    }),
  );

  return (response.Item as SummaryProjection | undefined) ?? {
    totalEvents: 0,
    triggerSucceeded: 0,
    triggerFailed: 0,
    targetQueued: 0,
    planCreated: 0,
    requestAccepted: 0,
  };
}

export async function readTopReposLastMinutes(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  minutes: number;
  limit: number;
}): Promise<RepoWindowCount[]> {
  // Keep parameter for compatibility while reading pre-aggregated 5-minute windows.
  void params.minutes;
  const bucket = fiveMinuteBucket(new Date().toISOString());
  const response = await params.ddb.send(
    new QueryCommand({
      TableName: params.projectionsTableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": bucket,
      },
    }),
  );

  return (response.Items ?? [])
    .map((item) => ({
      repo: String(item.repo ?? "unknown"),
      count: Number(item.count ?? 0),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, params.limit);
}

export async function readRecentFailures(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  limit: number;
}): Promise<Array<Record<string, unknown>>> {
  const response = await params.ddb.send(
    new QueryCommand({
      TableName: params.projectionsTableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": "failures",
      },
      ScanIndexForward: false,
      Limit: params.limit,
    }),
  );

  return response.Items ?? [];
}

export async function readRecentEvents(params: {
  ddb: DynamoDBDocumentClient;
  eventsTableName: string;
  limit: number;
}): Promise<StoredEvent[]> {
  const response = await params.ddb.send(
    new QueryCommand({
      TableName: params.eventsTableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": "all" },
      ScanIndexForward: false,
      Limit: params.limit,
    }),
  );

  return (response.Items ?? []).map(itemToStoredEvent);
}

export async function readJourneyByDeliveryId(params: {
  ddb: DynamoDBDocumentClient;
  eventsTableName: string;
  deliveryId: string;
}): Promise<StoredEvent[]> {
  const response = await params.ddb.send(
    new QueryCommand({
      TableName: params.eventsTableName,
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :pk",
      ExpressionAttributeValues: { ":pk": `delivery#${params.deliveryId}` },
      ScanIndexForward: true,
    }),
  );

  return (response.Items ?? []).map(itemToStoredEvent);
}

export async function readPerRepoStats(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
}): Promise<RepoStats[]> {
  const response = await params.ddb.send(
    new ScanCommand({
      TableName: params.projectionsTableName,
      FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
      ExpressionAttributeValues: { ":prefix": "repo#", ":sk": "stats" },
    }),
  );

  return (response.Items ?? []).map((item) => ({
    repo: String(item.repo ?? item.pk?.replace("repo#", "") ?? "unknown"),
    totalEvents: Number(item.totalEvents ?? 0),
    triggerSucceeded: Number(item.triggerSucceeded ?? 0),
    triggerFailed: Number(item.triggerFailed ?? 0),
    requestAccepted: Number(item.requestAccepted ?? 0),
    lastEventAt: item.lastEventAt as string | undefined,
  })).sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
}

export function computeHealthStatus(summary: SummaryProjection): HealthStatus {
  if (summary.totalEvents === 0) {
    return { status: "unknown", reasons: ["No events recorded yet"], totalEvents: 0 };
  }

  const reasons: string[] = [];
  const triggerTotal = summary.triggerSucceeded + summary.triggerFailed;
  const successRate = triggerTotal > 0 ? summary.triggerSucceeded / triggerTotal : undefined;

  // Check recency
  const lastEventMs = summary.lastEventAt ? Date.now() - new Date(summary.lastEventAt).getTime() : undefined;
  if (lastEventMs !== undefined && lastEventMs > 60 * 60 * 1000) {
    reasons.push(`No events in last ${Math.round(lastEventMs / 60000)} minutes`);
  }

  // Check pipeline stall: requests accepted but plans lagging significantly
  const pendingPlan = summary.requestAccepted - summary.planCreated;
  if (pendingPlan > 5) {
    reasons.push(`${pendingPlan} requests accepted but not yet planned (possible stall)`);
  }

  // Check dispatch stall: targets queued but triggers lagging
  const pendingDispatch = summary.targetQueued - (summary.triggerSucceeded + summary.triggerFailed);
  if (pendingDispatch > 10) {
    reasons.push(`${pendingDispatch} targets queued but not yet triggered (possible stall)`);
  }

  if (successRate !== undefined && successRate < 0.7) {
    reasons.push(`Low success rate: ${Math.round(successRate * 100)}%`);
    return { status: "red", reasons, successRate, lastEventAt: summary.lastEventAt, totalEvents: summary.totalEvents };
  }

  if (reasons.length > 0 || (successRate !== undefined && successRate < 0.9)) {
    if (successRate !== undefined && successRate < 0.9) {
      reasons.push(`Success rate below 90%: ${Math.round(successRate * 100)}%`);
    }
    return { status: "amber", reasons, successRate, lastEventAt: summary.lastEventAt, totalEvents: summary.totalEvents };
  }

  return { status: "green", reasons: ["All systems operational"], successRate, lastEventAt: summary.lastEventAt, totalEvents: summary.totalEvents };
}

function itemToStoredEvent(item: Record<string, unknown>): StoredEvent {
  return {
    id: (item.id as string | undefined) ?? "",
    type: (item.type as string | undefined) ?? "",
    source: (item.source as string | undefined) ?? "",
    subject: (item.subject as string | undefined) ?? "",
    time: (item.time as string | undefined) ?? "",
    appversion: item.appversion as string | undefined,
    traceparent: item.traceparent as string | undefined,
    sourceRepo: item.sourceRepo as string | undefined,
    targetRepo: item.targetRepo as string | undefined,
    deliveryId: item.deliveryId as string | undefined,
    error: item.error as string | undefined,
  };
}

