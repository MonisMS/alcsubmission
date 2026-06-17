import type { ServerMessage } from "./types";

export interface ReorderBuffer {
  push(msg: ServerMessage): ServerMessage[];
  reset(): void;
  readonly frontier: number;
}

export function createReorderBuffer(): ReorderBuffer {
  // Waiting room of messages received but not yet releasable, keyed by seq
  // for O(1) lookup + dedupe.
  const pending = new Map<number, ServerMessage>();
  // Highest seq released downstream. Starts at 0; the first real frame is seq 1.
  let frontier = 0;

  return {
    get frontier() {
      return frontier;
    },

    reset() {
      // New turn — the server restarts seq at 0, so our memory has to as well.
      pending.clear();
      frontier = 0;
    },

    push(msg) {
      // Drop anything already released, or already waiting. Both checks matter:
      // chaos can duplicate a seq that hasn't been released yet.
      if (msg.seq <= frontier || pending.has(msg.seq)) {
        return [];
      }

      pending.set(msg.seq, msg);

      // Release as long as the next seq is sitting in the waiting room. This is
      // what guarantees downstream only sees a gapless, ordered run.
      const released: ServerMessage[] = [];
      while (pending.has(frontier + 1)) {
        const next = pending.get(frontier + 1)!;
        released.push(next);
        pending.delete(frontier + 1);
        frontier += 1;
      }

      return released;
    },
  };
}
