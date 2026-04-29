import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isReplayDelivery } from "../src/github/replay-protection.js";

describe("isReplayDelivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first delivery and rejects immediate replay", () => {
    expect(isReplayDelivery("d-1", 1000)).toBe(false);
    expect(isReplayDelivery("d-1", 1000)).toBe(true);
  });

  it("allows same delivery id again after TTL expiry", () => {
    expect(isReplayDelivery("d-ttl", 1000)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(isReplayDelivery("d-ttl", 1000)).toBe(false);
  });
});
