import type { ServerMessage } from "./types";

// The public shape. Consumers only see these three things.
export interface ReorderBuffer {
  push(msg: ServerMessage): ServerMessage[];
  reset(): void;
  readonly frontier: number;
}

export function createReorderBuffer(): ReorderBuffer {
  // ── private state (closure variables) ──
  // `pending` = the waiting room: messages received but not yet releasable,
  //   keyed by their seq so we can look one up instantly and dedup.
  const pending = new Map<number, ServerMessage>();
  // `frontier` = highest seq we've released to the renderer (the DOM frontier).
  // Starts at 0 because the server's first real message of a turn is seq 1.
  let frontier = 0;

  return {
    // a getter so callers can READ frontier but never reassign it.
    get frontier() {
      return frontier;
    },

    reset() {
      // New turn → server restarts seq at 0, so our memory must too.
      pending.clear();
      frontier = 0;
    },

    push(msg) {
      // ── Step 1: DEDUP ──
      // Drop if it's already rendered (<= frontier) OR already in the waiting room.
      // Both checks needed: the first misses duplicates that never got released yet.
      if (msg.seq <= frontier || pending.has(msg.seq)) {
        return [];
      }

      // ── Step 2: STORE ──
      // It's new and not yet releasable (maybe there's a gap before it). Park it.
      pending.set(msg.seq, msg);

      // ── Step 3: DRAIN ──
      // Release as long as the very next seq is sitting in the waiting room.
      // This is what guarantees the renderer only ever sees a gapless, ordered run.
      const released: ServerMessage[] = [];
      while (pending.has(frontier + 1)) {
        const next = pending.get(frontier + 1)!; // `!` safe: we just checked .has()
        released.push(next);
        pending.delete(frontier + 1);
        frontier += 1;
      }

      // ── Step 4: RETURN ──
      // Often empty (still waiting on a gap), sometimes a burst (a gap just filled).
      return released;
    },
  };
}
