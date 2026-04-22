import { randomBytes } from "node:crypto";

import type { TraceContext } from "./contracts.js";

const TRACEPARENT_VERSION = "00";
const TRACE_FLAGS = "01";

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

function isValidHex(value: string, expectedLength: number): boolean {
  return value.length === expectedLength && /^[a-f0-9]+$/u.test(value);
}

export function parseTraceparent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value.trim().toLowerCase().split("-");
  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, spanId, flags] = parts;
  if (!isValidHex(version, 2) || !isValidHex(traceId, 32) || !isValidHex(spanId, 16) || !isValidHex(flags, 2)) {
    return undefined;
  }

  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) {
    return undefined;
  }

  return `${version}-${traceId}-${spanId}-${flags}`;
}

export function makeRootTraceContext(): TraceContext {
  return {
    traceparent: `${TRACEPARENT_VERSION}-${randomHex(16)}-${randomHex(8)}-${TRACE_FLAGS}`,
  };
}

export function makeChildTraceContext(parent: TraceContext): TraceContext {
  const parsed = parseTraceparent(parent.traceparent);
  if (!parsed) {
    return makeRootTraceContext();
  }

  const [version, traceId, , flags] = parsed.split("-");
  return {
    traceparent: `${version}-${traceId}-${randomHex(8)}-${flags}`,
    tracestate: parent.tracestate,
  };
}

export function withIncomingTraceContext(headers: Record<string, string | undefined>): TraceContext {
  const traceparent = parseTraceparent(headers.traceparent);
  const tracestate = headers.tracestate;

  if (!traceparent) {
    return makeRootTraceContext();
  }

  return {
    traceparent,
    tracestate,
  };
}
