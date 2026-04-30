/**
 * Tests that validate the health-report logic in event-store.ts against the
 * Non-Functional Requirements documented in README.md.
 *
 * Each describe/it block explicitly references the NFR it covers, so that the
 * test suite acts as living documentation proving every NFR health check is
 * in place and correctly tuned.
 */

import { describe, expect, it } from "vitest";

import {
  computeHealthReport,
  summarizeDeliveryLatency,
  type HealthCheck,
  type HealthStatus,
  type RecentDelivery,
} from "../src/async/event-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<Parameters<typeof computeHealthReport>[0]["summary"]> = {}) {
  return {
    totalEvents: 10,
    requestAccepted: 5,
    planCreated: 5,
    targetQueued: 5,
    triggerSucceeded: 5,
    triggerFailed: 0,
    lastEventAt: new Date().toISOString(),
    ...overrides,
  };
}

function findCheck(report: HealthStatus, id: string): HealthCheck {
  const check = (report.checks ?? []).find((c) => c.id === id);
  if (!check) {
    throw new Error(`Health check "${id}" not found in report`);
  }
  return check;
}

// ---------------------------------------------------------------------------
// NFR-01 — Availability: planning and dispatch backlogs
// ---------------------------------------------------------------------------

describe("NFR-01 — Availability: planning and dispatch backlog checks", () => {
  it("marks planning_backlog green when no backlog exists", () => {
    const report = computeHealthReport({ summary: makeSummary({ requestAccepted: 5, planCreated: 5 }) });
    const check = findCheck(report, "planning_backlog");
    expect(check.status).toBe("green");
    expect(check.nfrRef).toBe("NFR-01");
  });

  it("marks planning_backlog amber when 4–10 requests are pending", () => {
    const report = computeHealthReport({
      summary: makeSummary({ requestAccepted: 10, planCreated: 5, targetQueued: 5 }),
    });
    const check = findCheck(report, "planning_backlog");
    expect(check.status).toBe("amber");
  });

  it("marks planning_backlog red when more than 10 requests are pending", () => {
    const report = computeHealthReport({
      summary: makeSummary({ requestAccepted: 20, planCreated: 5, targetQueued: 5 }),
    });
    const check = findCheck(report, "planning_backlog");
    expect(check.status).toBe("red");
  });

  it("marks dispatch_backlog green when no backlog exists", () => {
    const report = computeHealthReport({
      summary: makeSummary({ targetQueued: 5, triggerSucceeded: 5, triggerFailed: 0 }),
    });
    const check = findCheck(report, "dispatch_backlog");
    expect(check.status).toBe("green");
    expect(check.nfrRef).toBe("NFR-01");
  });

  it("marks dispatch_backlog red when more than 25 targets are unresolved", () => {
    const report = computeHealthReport({
      summary: makeSummary({ targetQueued: 50, triggerSucceeded: 10, triggerFailed: 0 }),
    });
    const check = findCheck(report, "dispatch_backlog");
    expect(check.status).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// NFR-02 — Performance: end-to-end latency threshold
// NFR-02 target: planner + dispatcher ≤ 30 s (Lambda processing); the
// stored latency includes SQS polling overhead, so the dashboard threshold
// is set to green ≤ 60 s / amber ≤ 120 s / red > 120 s.
// ---------------------------------------------------------------------------

describe("NFR-02 — Performance: end-to-end latency health check", () => {
  it("health check id is 'end_to_end_latency' and references NFR-02", () => {
    const report = computeHealthReport({ summary: makeSummary() });
    const check = findCheck(report, "end_to_end_latency");
    expect(check.nfrRef).toBe("NFR-02");
  });

  it("marks latency check green when P95 is within 60 s (NFR-02 target + SQS buffer)", () => {
    const deliveries: RecentDelivery[] = [
      {
        deliveryId: "d1",
        sourceRepo: "org/repo",
        status: "success",
        queuedCount: 1,
        succeededCount: 1,
        failedCount: 0,
        latencySeconds: 25,
      },
      {
        deliveryId: "d2",
        sourceRepo: "org/repo",
        status: "success",
        queuedCount: 1,
        succeededCount: 1,
        failedCount: 0,
        latencySeconds: 60,
      },
    ];
    const latency = summarizeDeliveryLatency(deliveries);
    const report = computeHealthReport({ summary: makeSummary(), latency });
    const check = findCheck(report, "end_to_end_latency");
    expect(check.status).toBe("green");
  });

  it("marks latency check amber when P95 is between 61 s and 120 s", () => {
    const deliveries: RecentDelivery[] = [
      {
        deliveryId: "d1",
        sourceRepo: "org/repo",
        status: "success",
        queuedCount: 1,
        succeededCount: 1,
        failedCount: 0,
        latencySeconds: 90,
      },
    ];
    const latency = summarizeDeliveryLatency(deliveries);
    const report = computeHealthReport({ summary: makeSummary(), latency });
    const check = findCheck(report, "end_to_end_latency");
    expect(check.status).toBe("amber");
  });

  it("marks latency check red when P95 exceeds 120 s", () => {
    const deliveries: RecentDelivery[] = [
      {
        deliveryId: "d1",
        sourceRepo: "org/repo",
        status: "success",
        queuedCount: 1,
        succeededCount: 1,
        failedCount: 0,
        latencySeconds: 150,
      },
    ];
    const latency = summarizeDeliveryLatency(deliveries);
    const report = computeHealthReport({ summary: makeSummary(), latency });
    const check = findCheck(report, "end_to_end_latency");
    expect(check.status).toBe("red");
  });

  it("latency detail string references the NFR-02 30 s target", () => {
    const deliveries: RecentDelivery[] = [
      {
        deliveryId: "d1",
        sourceRepo: "org/repo",
        status: "success",
        queuedCount: 1,
        succeededCount: 1,
        failedCount: 0,
        latencySeconds: 20,
      },
    ];
    const latency = summarizeDeliveryLatency(deliveries);
    const report = computeHealthReport({ summary: makeSummary(), latency });
    const check = findCheck(report, "end_to_end_latency");
    expect(check.detail).toContain("NFR-02");
    expect(check.detail).toContain("30s");
  });
});

// ---------------------------------------------------------------------------
// NFR-04 — Reliability: trigger success rate
// NFR-04 says failed dispatches must be retried; the success-rate check
// captures the outcome and alerts when the rate drops below thresholds.
// ---------------------------------------------------------------------------

describe("NFR-04 — Reliability: trigger success rate health check", () => {
  it("marks success rate green when all triggers succeed (100%)", () => {
    const report = computeHealthReport({
      summary: makeSummary({ triggerSucceeded: 100, triggerFailed: 0 }),
    });
    const check = findCheck(report, "trigger_success_rate");
    expect(check.status).toBe("green");
    expect(check.nfrRef).toBe("NFR-04");
  });

  it("marks success rate green at exactly 95%", () => {
    const report = computeHealthReport({
      summary: makeSummary({ triggerSucceeded: 95, triggerFailed: 5 }),
    });
    const check = findCheck(report, "trigger_success_rate");
    expect(check.status).toBe("green");
  });

  it("marks success rate amber when between 80% and 95%", () => {
    const report = computeHealthReport({
      summary: makeSummary({ triggerSucceeded: 85, triggerFailed: 15 }),
    });
    const check = findCheck(report, "trigger_success_rate");
    expect(check.status).toBe("amber");
  });

  it("marks success rate red when below 80%", () => {
    const report = computeHealthReport({
      summary: makeSummary({ triggerSucceeded: 70, triggerFailed: 30 }),
    });
    const check = findCheck(report, "trigger_success_rate");
    expect(check.status).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// NFR-11 — Observability: recent pipeline activity (data freshness)
// NFR-11 requires structured logs and dashboard health status.  The recency
// check ensures the admin UI flags when no events have been seen recently.
// ---------------------------------------------------------------------------

describe("NFR-11 — Observability: event recency health check", () => {
  it("marks event_recency green when last event was within 15 minutes", () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const report = computeHealthReport({
      summary: makeSummary({ lastEventAt: twoMinutesAgo }),
    });
    const check = findCheck(report, "event_recency");
    expect(check.status).toBe("green");
    expect(check.nfrRef).toBe("NFR-11");
  });

  it("marks event_recency amber when last event was 16–45 minutes ago", () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const report = computeHealthReport({
      summary: makeSummary({ lastEventAt: twentyMinutesAgo }),
    });
    const check = findCheck(report, "event_recency");
    expect(check.status).toBe("amber");
  });

  it("marks event_recency red when last event was more than 45 minutes ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const report = computeHealthReport({
      summary: makeSummary({ lastEventAt: oneHourAgo }),
    });
    const check = findCheck(report, "event_recency");
    expect(check.status).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// Overall report structure
// ---------------------------------------------------------------------------

describe("computeHealthReport — structure invariants", () => {
  it("returns unknown status when no events have been recorded", () => {
    const report = computeHealthReport({
      summary: {
        totalEvents: 0,
        requestAccepted: 0,
        planCreated: 0,
        targetQueued: 0,
        triggerSucceeded: 0,
        triggerFailed: 0,
      },
    });
    expect(report.status).toBe("unknown");
  });

  it("returns all five health checks when events are present", () => {
    const report = computeHealthReport({ summary: makeSummary() });
    const ids = (report.checks ?? []).map((c) => c.id);
    expect(ids).toContain("event_recency");
    expect(ids).toContain("trigger_success_rate");
    expect(ids).toContain("planning_backlog");
    expect(ids).toContain("dispatch_backlog");
    expect(ids).toContain("end_to_end_latency");
  });

  it("all checks carry an nfrRef when events are present", () => {
    const report = computeHealthReport({ summary: makeSummary() });
    for (const check of report.checks ?? []) {
      expect(check.nfrRef, `Check "${check.id}" should have an nfrRef`).toBeTruthy();
    }
  });

  it("overall status is worst of individual check statuses", () => {
    // Force a red on success rate; others should be green → overall red.
    const report = computeHealthReport({
      summary: makeSummary({ triggerSucceeded: 60, triggerFailed: 40 }),
    });
    expect(report.status).toBe("red");
  });
});
