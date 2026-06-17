export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 10_000;

// attempt is 0-based, so the first reconnect after a drop is attempt 0:
// 0 -> 500, 1 -> 1000, 2 -> 2000, 3 -> 4000, ... capped at 10s.
// Pure math so the whole curve is testable without fake timers.
export function backoffDelay(attempt: number): number {
  const n = attempt < 0 ? 0 : attempt;
  return Math.min(BASE_DELAY_MS * 2 ** n, MAX_DELAY_MS);
}
