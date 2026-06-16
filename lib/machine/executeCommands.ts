// ─────────────────────────────────────────────────────────────
// Command interpreter — the "flush" layer.
//
// The FSM is pure: it can only DESCRIBE side-effects as Command objects.
// This is the one place those descriptions actually happen: opening the
// socket, sending a frame, resetting the buffer, arming a timer.
//
// It's a plain function (not a hook) so it can be unit-tested with fake
// deps and so the React layer stays thin. Everything it touches arrives
// through `deps` — it has no globals, no imports of the socket, no React.
// ─────────────────────────────────────────────────────────────

import type { Command, Event } from "./connectionMachine";
import type { Transport } from "../transport/socket";
import type { ReorderBuffer } from "../protocol/reorderBuffer";
import type { ClientMessage } from "../protocol/types";

// a short, human-readable detail line for an outbound frame in the Timeline
function outboundDetail(msg: ClientMessage): string {
  switch (msg.type) {
    case "PONG":
      return `echo "${msg.echo}"`;
    case "RESUME":
      return `last_seq ${msg.last_seq}`;
    case "TOOL_ACK":
      return msg.call_id;
    case "USER_MESSAGE":
      return msg.content;
  }
}

export interface CommandDeps {
  transport: Transport | null;
  buffer: ReorderBuffer;
  // Feed an event back into the machine (used by timers).
  dispatch: (event: Event) => void;
  // Arm a single-shot timer of a given kind; firing dispatches `event`.
  // Re-arming the same kind cancels the previous one (idempotent).
  setTimer: (kind: "backoff" | "replay", ms: number, event: Event) => void;
  // New turn: clear the render model + the released-seq tracker.
  onResetTurn: () => void;
  // Optional observability hook for the Timeline (no-op if absent).
  onTrace?: (label: string, detail: string, tone: "in" | "out" | "life") => void;
}

export function executeCommands(commands: Command[], deps: CommandDeps): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "OPEN_SOCKET":
        deps.transport?.connect();
        break;
      case "SEND":
        // PONG / TOOL_ACK / RESUME / USER_MESSAGE all flow through here —
        // never sent inline from the reducer.
        deps.transport?.send(cmd.msg);
        deps.onTrace?.(`↑ ${cmd.msg.type}`, outboundDetail(cmd.msg), "out");
        break;
      case "RESET_BUFFER":
        deps.buffer.reset();
        deps.onResetTurn();
        break;
      case "START_BACKOFF":
        deps.setTimer("backoff", cmd.delayMs, { type: "BACKOFF_FIRED" });
        deps.onTrace?.("⟳ reconnect", `in ${cmd.delayMs}ms`, "life");
        break;
      case "SCHEDULE_REPLAY_TIMEOUT":
        deps.setTimer("replay", cmd.ms, { type: "REPLAY_QUIET" });
        break;
    }
  }
}
