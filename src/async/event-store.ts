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
  checks?: HealthCheck[];
  latency?: LatencySummary;
};

export type HealthCheck = {
  id: string;
  label: string;
  status: "green" | "amber" | "red" | "unknown";
  detail: string;
};

export type LatencySummary = {
  count: number;
  p50Seconds?: number;
  p95Seconds?: number;
  avgSeconds?: number;
};

export type DeliveryFunnel = {
  pk: string;
  sk: string;
  sourceRepo?: string;
  requestAcceptedAt?: string;
  planCreatedAt?: string;
  firstTargetQueuedAt?: string;
  lastTargetQueuedAt?: string;
  firstSucceededAt?: string;
  firstFailedAt?: string;
  queuedCount?: number;
  succeededCount?: number;
  failedCount?: number;
  allowedTargets?: number;
  appversion?: string;
  lastUpdatedAt?: string;
};

export type RecentDelivery = {
  deliveryId: string;
  sourceRepo: string;
  lastUpdatedAt?: string;
  requestAcceptedAt?: string;
  firstSucceededAt?: string;
  status: "success" | "failed" | "in_progress";
  queuedCount: number;
  succeededCount: number;
  failedCount: number;
  latencySeconds?: number;
};

export type HourlyTrendPoint = {
  hour: string;
  totalEvents: number;
  requestAccepted: number;
  triggerSucceeded: number;
  triggerFailed: number;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function statusByThreshold(value: number | undefined, amberMax: number, redMax: number): HealthCheck["status"] {
  if (value === undefined) {
    return "unknown";
  }
  if (value > redMax) {
    return "red";
  }
  if (value > amberMax) {
    return "amber";
  }
  return "green";
}

function successStatus(successRate: number | undefined): HealthCheck["status"] {
  if (successRate === undefined) {
    return "unknown";
  }
  if (successRate < 0.8) {
    return "red";
  }
  if (successRate < 0.95) {
    return "amber";
  }
  return "green";
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
          "SET firstTargetQueuedAt = if_not_exists(firstTargetQueuedAt, :time), "
          + "lastTargetQueuedAt = :time, lastUpdatedAt = :time, "
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
          "SET firstSucceededAt = if_not_exists(firstSucceededAt, :time), "
          + "lastUpdatedAt = :time, "
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
          "SET firstFailedAt = if_not_exists(firstFailedAt, :time), "
          + "lastUpdatedAt = :time, "
          + "failedCount = if_not_exists(failedCount, :zero) + :one",
        ExpressionAttributeValues: { ":time": event.time, ":zero": 0, ":one": 1 },
      }),
    );
  }
}

export async function readRecentDeliveries(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  limit: number;
}): Promise<RecentDelivery[]> {
  const response = await params.ddb.send(
    new ScanCommand({
      TableName: params.projectionsTableName,
      FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
      ExpressionAttributeValues: { ":prefix": "delivery#", ":sk": "funnel" },
    }),
  );

  return (response.Items ?? [])
    .map((item) => {
      const funnel = item as DeliveryFunnel;
      const deliveryId = String(funnel.pk ?? "").replace("delivery#", "");
      const queued = Number(funnel.queuedCount ?? 0);
      const succeeded = Number(funnel.succeededCount ?? 0);
      const failed = Number(funnel.failedCount ?? 0);
      let status: RecentDelivery["status"] = "in_progress";
      if (succeeded > 0) {
        status = "success";
      } else if (failed > 0) {
        status = "failed";
      }
      const latencySeconds =
        funnel.requestAcceptedAt && funnel.firstSucceededAt
          ? Math.max(0, Math.round((new Date(funnel.firstSucceededAt).getTime() - new Date(funnel.requestAcceptedAt).getTime()) / 1000))
          : undefined;
      return {
        deliveryId,
        sourceRepo: funnel.sourceRepo ?? "unknown",
        lastUpdatedAt: funnel.lastUpdatedAt,
        requestAcceptedAt: funnel.requestAcceptedAt,
        firstSucceededAt: funnel.firstSucceededAt,
        status,
        queuedCount: queued,
        succeededCount: succeeded,
        failedCount: failed,
        latencySeconds,
      };
    })
    .filter((row) => row.deliveryId.length > 0)
    .sort((a, b) => (b.lastUpdatedAt ?? "").localeCompare(a.lastUpdatedAt ?? ""))
    .slice(0, params.limit);
}

export async function readHourlyTrend(params: {
  ddb: DynamoDBDocumentClient;
  projectionsTableName: string;
  hours: number;
}): Promise<HourlyTrendPoint[]> {
  const response = await params.ddb.send(
    new ScanCommand({
      TableName: params.projectionsTableName,
      FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
      ExpressionAttributeValues: { ":prefix": "hour#", ":sk": "global" },
    }),
  );

  const sorted = (response.Items ?? [])
    .map((item) => {
      const row = item as Record<string, unknown>;
      const pk = asString(row.pk) ?? "";
      return {
        hour: pk.replace("hour#", ""),
        totalEvents: Number(row.totalEvents ?? 0),
        requestAccepted: Number(row.requestAccepted ?? 0),
        triggerSucceeded: Number(row.triggerSucceeded ?? 0),
        triggerFailed: Number(row.triggerFailed ?? 0),
      };
    })
    .filter((row) => row.hour.length > 0)
    .sort((a, b) => a.hour.localeCompare(b.hour));

  return sorted.slice(Math.max(0, sorted.length - params.hours));
}

function percentile(sorted: number[], pct: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarizeDeliveryLatency(deliveries: RecentDelivery[]): LatencySummary {
  const values = deliveries
    .map((d) => d.latencySeconds)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return { count: 0 };
  }

  const total = values.reduce((acc, cur) => acc + cur, 0);
  return {
    count: values.length,
    p50Seconds: percentile(values, 50),
    p95Seconds: percentile(values, 95),
    avgSeconds: Math.round(total / values.length),
  };
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
  // Query one pre-aggregated 5-minute bucket closest to the requested window.
  const now = new Date();
  if (params.minutes > 5) {
    now.setUTCMinutes(now.getUTCMinutes() - (params.minutes - 5));
  }
  const bucket = fiveMinuteBucket(now.toISOString());
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
    .map((item: Record<string, unknown>) => ({
      repo: asString(item.repo) ?? "unknown",
      count: Number(item.count ?? 0),
    }))
    .sort((a: RepoWindowCount, b: RepoWindowCount) => b.count - a.count)
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

  return (response.Items ?? []).map((item: Record<string, unknown>) => {
    const repoFromItem = asString(item.repo);
    const pk = asString(item.pk) ?? "";
    const repoFromPk = pk.startsWith("repo#") ? pk.replace("repo#", "") : "";
    return {
      repo: repoFromItem ?? (repoFromPk || "unknown"),
      totalEvents: Number(item.totalEvents ?? 0),
      triggerSucceeded: Number(item.triggerSucceeded ?? 0),
      triggerFailed: Number(item.triggerFailed ?? 0),
      requestAccepted: Number(item.requestAccepted ?? 0),
      lastEventAt: item.lastEventAt as string | undefined,
    };
  }).sort((a: RepoStats, b: RepoStats) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
}

export function computeHealthStatus(summary: SummaryProjection): HealthStatus {
  return computeHealthReport({ summary });
}

export function computeHealthReport(params: {
  summary: SummaryProjection;
  latency?: LatencySummary;
}): HealthStatus {
  const { summary, latency } = params;
  const checks: HealthCheck[] = [];
  const triggerSucceeded = Number(summary.triggerSucceeded ?? 0);
  const triggerFailed = Number(summary.triggerFailed ?? 0);
  const requestAccepted = Number(summary.requestAccepted ?? 0);
  const planCreated = Number(summary.planCreated ?? 0);
  const targetQueued = Number(summary.targetQueued ?? 0);

  if (summary.totalEvents === 0) {
    return {
      status: "unknown",
      reasons: ["No events recorded yet"],
      totalEvents: 0,
      checks: [
        {
          id: "events_seen",
          label: "Events observed",
          status: "unknown",
          detail: "No facts have been recorded yet.",
        },
      ],
      latency,
    };
  }

  const triggerTotal = triggerSucceeded + triggerFailed;
  const successRate = triggerTotal > 0 ? triggerSucceeded / triggerTotal : undefined;
  const lastEventMs = summary.lastEventAt ? Date.now() - new Date(summary.lastEventAt).getTime() : undefined;
  const pendingPlan = requestAccepted - planCreated;
  const pendingDispatch = targetQueued - triggerTotal;

  const recencyStatus = statusByThreshold(lastEventMs, 15 * 60 * 1000, 45 * 60 * 1000);
  checks.push({
    id: "event_recency",
    label: "Recent pipeline activity",
    status: recencyStatus,
    detail:
      lastEventMs === undefined
        ? "No last-event timestamp available"
        : `Last event ${Math.round(lastEventMs / 60000)} min ago (green <= 15, amber <= 45, red > 45).`,
  });

  const triggerStatus = successStatus(successRate);
  checks.push({
    id: "trigger_success_rate",
    label: "Trigger success rate",
    status: triggerStatus,
    detail:
      successRate === undefined
        ? "No trigger outcomes yet"
        : `${Math.round(successRate * 100)}% (green >= 95%, amber >= 80%, red < 80%).`,
  });

  const planStatus = statusByThreshold(pendingPlan, 3, 10);
  checks.push({
    id: "planning_backlog",
    label: "Planning backlog",
    status: planStatus,
    detail: `${pendingPlan} requests waiting to be planned (green <= 3, amber <= 10, red > 10).`,
  });

  const dispatchStatus = statusByThreshold(pendingDispatch, 8, 25);
  checks.push({
    id: "dispatch_backlog",
    label: "Dispatch backlog",
    status: dispatchStatus,
    detail: `${pendingDispatch} queued targets without outcome (green <= 8, amber <= 25, red > 25).`,
  });

  if (latency?.count && latency.p95Seconds !== undefined) {
    const latencyStatus = statusByThreshold(latency.p95Seconds, 420, 900);
    checks.push({
      id: "end_to_end_latency",
      label: "End-to-end latency (request to first success)",
      status: latencyStatus,
      detail: `P95 ${latency.p95Seconds}s over ${latency.count} deliveries (green <= 420s, amber <= 900s, red > 900s).`,
    });
  } else {
    checks.push({
      id: "end_to_end_latency",
      label: "End-to-end latency (request to first success)",
      status: "unknown",
      detail: "Not enough successful delivery journeys yet to compute latency.",
    });
  }

  const rank = { unknown: 0, green: 1, amber: 2, red: 3 } as const;
  const worst = checks.reduce<HealthCheck["status"]>((acc, check) => (rank[check.status] > rank[acc] ? check.status : acc), "green");
  const reasons = checks.filter((c) => c.status !== "green").map((c) => `${c.label}: ${c.detail}`);

  return {
    status: worst,
    reasons: reasons.length > 0 ? reasons : ["All checks within expected operating thresholds."],
    successRate,
    lastEventAt: summary.lastEventAt,
    totalEvents: summary.totalEvents,
    checks,
    latency,
  };
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

