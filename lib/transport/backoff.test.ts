import { describe, it, expect } from "vitest";
import { backoffDelay, BASE_DELAY_MS, MAX_DELAY_MS } from "./backoff";

describe("backoffDelay", () => {
  it("starts at the base delay on the first attempt", () => {
    expect(backoffDelay(0)).toBe(BASE_DELAY_MS); // 500
  });

  it("doubles each attempt until the cap", () => {
    expect(backoffDelay(0)).toBe(500);
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(4)).toBe(8000);
  });

  it("caps at MAX_DELAY_MS and never exceeds it", () => {
    expect(backoffDelay(5)).toBe(MAX_DELAY_MS); // 16000 → clamped to 10000
    expect(backoffDelay(6)).toBe(MAX_DELAY_MS);
    expect(backoffDelay(100)).toBe(MAX_DELAY_MS); // stays capped forever
  });

  it("treats a negative attempt as attempt 0 (defensive)", () => {
    expect(backoffDelay(-1)).toBe(BASE_DELAY_MS);
  });
});
