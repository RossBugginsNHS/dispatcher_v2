export type DispatchEventStatus = "success" | "failed" | "denied";

export type DispatchEvent = {
  timestamp: string;
  correlationId: string;
  sourceRepo: string;
  sourceWorkflow: string;
  sourceRunId: number;
  targetRepo: string;
  targetWorkflow: string;
  status: DispatchEventStatus;
  error?: string;
};

export type DispatchEventStore = {
  record(event: DispatchEvent): void;
  list(): DispatchEvent[];
};

const MAX_EVENTS = 500;

export function createDispatchEventStore(): DispatchEventStore {
  const events: DispatchEvent[] = [];

  return {
    record(event: DispatchEvent): void {
      events.unshift(event);
      if (events.length > MAX_EVENTS) {
        events.splice(MAX_EVENTS);
      }
    },
    list(): DispatchEvent[] {
      return events.slice();
    },
  };
}
