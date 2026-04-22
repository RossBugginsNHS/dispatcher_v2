import { randomUUID } from "node:crypto";

import type { TraceContext } from "./contracts.js";

export type CloudEvent<TData = unknown> = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  appversion?: string;
  data: TData;
  traceparent?: string;
  tracestate?: string;
};

export function makeCloudEvent<TData>(params: {
  source: string;
  type: string;
  subject: string;
  data: TData;
  trace?: TraceContext;
}): CloudEvent<TData> {
  return {
    specversion: "1.0",
    id: randomUUID(),
    source: params.source,
    type: params.type,
    subject: params.subject,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    appversion: process.env.APP_VERSION ?? "unknown",
    data: params.data,
    traceparent: params.trace?.traceparent,
    tracestate: params.trace?.tracestate,
  };
}
