import type { WorkflowRunPayload } from "../github/types.js";

export type DispatchRequestAcceptedMessage = {
  deliveryId: string;
  eventName: string;
  receivedAt: string;
  payload: WorkflowRunPayload;
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
    inputs?: Record<string, string>;
  };
};

export const DispatchFacts = {
  requestAccepted: "dispatch.request.accepted",
  planCreated: "dispatch.plan.created",
  targetQueued: "dispatch.target.queued",
  triggerSucceeded: "dispatch.trigger.succeeded",
  triggerFailed: "dispatch.trigger.failed",
} as const;
