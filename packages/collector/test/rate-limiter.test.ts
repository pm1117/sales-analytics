import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/compliance/rate-limiter";

const opts = { minDelayMs: 10_000, jitterMs: 10_000, maxConcurrency: 1 };

describe("RateLimiter.nextDelayMs", () => {
  it("stays at or above the floor and within floor+jitter", () => {
    for (const r of [0, 0.25, 0.5, 0.9, 0.999]) {
      const rl = new RateLimiter(opts, () => 0, () => r);
      const d = rl.nextDelayMs();
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(20_000);
    }
  });

  it("varies with jitter (not uniform)", () => {
    const a = new RateLimiter(opts, () => 0, () => 0.1).nextDelayMs();
    const b = new RateLimiter(opts, () => 0, () => 0.8).nextDelayMs();
    expect(a).not.toBe(b);
  });

  it("honors a larger robots Crawl-delay as the floor", () => {
    const rl = new RateLimiter(opts, () => 0, () => 0);
    expect(rl.nextDelayMs(30_000)).toBe(30_000);
  });
});
