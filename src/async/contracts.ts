import type { WorkflowRunPayload } from "../github/types.js";

export type TraceContext = {
  traceparent: string;
  tracestate?: string;
};

export type DispatchRequestAcceptedMessage = {
  deliveryId: string;
  eventName: string;
  receivedAt: string;
  payload: WorkflowRunPayload;
  trace: TraceContext;
};

export type DispatchTargetWorkMessage = {
  deliveryId: string;
  sourceOwner: string;
  sourceRepo: string;
  sourceWorkflow: string;
  sourceRunId: number;
  installationId: number;
  dispatchRef: string;
  target: {
    owner: string;
    repo: string;
    workflow: string;
  };
  trace: TraceContext;
};

export const DispatchFacts = {
  requestAccepted: "com.dispatcher.request.accepted",
  planCreated: "com.dispatcher.plan.created",
  targetQueued: "com.dispatcher.target.queued",
  triggerSucceeded: "com.dispatcher.trigger.succeeded",
  triggerFailed: "com.dispatcher.trigger.failed",
} as const;
