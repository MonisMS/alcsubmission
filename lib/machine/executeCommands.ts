// The flush layer. The FSM only describes side-effects as Command objects;
// this is where they actually happen — opening the socket, sending a frame,
// resetting the buffer, arming a timer. A plain function (not a hook) so it
// can be tested with fake deps; everything it touches comes through `deps`.

import type { Command, Event } from "./connectionMachine";
import type { Transport } from "../transport/socket";
import type { ReorderBuffer } from "../protocol/reorderBuffer";
import type { ClientMessage } from "../protocol/types";
import type { TraceTone } from "../trace/trace";

// Short detail line for an outbound frame in the timeline.
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
  // Arm a single-shot timer; re-arming the same kind cancels the previous one.
  setTimer: (kind: "backoff" | "replay", ms: number, event: Event) => void;
  // New turn: clear the render model + the released-seq tracker.
  onResetTurn: () => void;
  // Optional observability hook for the timeline.
  onTrace?: (label: string, detail: string, tone: TraceTone) => void;
}

export function executeCommands(commands: Command[], deps: CommandDeps): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "OPEN_SOCKET":
        deps.transport?.connect();
        break;
      case "SEND":
        // PONG / TOOL_ACK / RESUME / USER_MESSAGE all flow through here.
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
