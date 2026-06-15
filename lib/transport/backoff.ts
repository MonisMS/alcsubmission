// ─────────────────────────────────────────────────────────────
// Exponential backoff — pure, no timers, no socket.
//
// When the line dies (hard terminate / 1006), we don't hammer the
// server with instant reconnects. We wait a bit, and the wait DOUBLES
// each failed attempt, capped so we never wait forever.
//
// This file owns ONLY the math: "given it's my Nth attempt, how long
// do I wait?" Who counts the attempts (the FSM) and who actually waits
// (the command-flush effect, via setTimeout) lives elsewhere. Keeping
// the math pure means we can unit-test the whole sequence with zero
// fake timers.
// ─────────────────────────────────────────────────────────────

// First reconnect waits this long.
export const BASE_DELAY_MS = 500;
// We never wait longer than this, no matter how many attempts fail.
export const MAX_DELAY_MS = 10_000;

// How long to wait before reconnect attempt number `attempt`.
//
// `attempt` is 0-based: the FIRST reconnect after a drop is attempt 0.
//   0 → 500, 1 → 1000, 2 → 2000, 3 → 4000, 4 → 8000, 5+ → 10000 (capped)
//
// Doubling = 500 * 2^attempt. Math.min clamps it to the cap.
// We guard attempt < 0 so a bad caller can't ask for 500 * 2^-1.
export function backoffDelay(attempt: number): number {
  const n = attempt < 0 ? 0 : attempt;
  return Math.min(BASE_DELAY_MS * 2 ** n, MAX_DELAY_MS);
}
