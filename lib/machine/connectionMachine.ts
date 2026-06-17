// Connection state machine — the controller layer. A pure reducer:
//   reduce(state, event) -> [nextState, Command[]]
// It never touches a socket, timer, React, or the DOM. It takes a validated,
// already-ordered, already-deduped frame (the reorder buffer handled that) plus
// lifecycle events, and returns the next state and a list of side-effects for
// the flush layer to run.
//
// A state machine rather than a pile of booleans because STREAMING and
// TOOL_CALL_PENDING are mutually exclusive and a TOKEN means different things in
// each, and because RESUME must be the first frame sent on reconnect — an atomic
// transition guarantees that, effect ordering can't. PONG / TOOL_ACK / RESUME
// come out as Commands and are flushed by a thin effect, never sent inline.

import type { ServerMessage, ClientMessage } from "../protocol/types";
import { backoffDelay } from "../transport/backoff";

// The seven connection states:
//   DISCONNECTED      no socket; idle (initial, or after a clean close)
//   CONNECTING        socket opening (fresh or a reconnect attempt)
//   CONNECTED         live and idle — ready to send a USER_MESSAGE
//   STREAMING         a turn is in flight; tokens/context arriving
//   TOOL_CALL_PENDING >=1 tool call shown, waiting on its TOOL_RESULT(s)
//   RECONNECTING      line died unexpectedly; waiting out the backoff timer
//   RESUMING          reconnected; replaying history, outbound protocol suppressed
export type Status =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "STREAMING"
  | "TOOL_CALL_PENDING"
  | "RECONNECTING"
  | "RESUMING";

export interface MachineState {
  status: Status;
  // Highest seq actually rendered to the DOM. RESUME sends this, not the
  // highest seq received. Advanced only by FRAMES_RENDERED (fired after React
  // commits), so we never claim a seq the user hasn't seen yet.
  domFrontier: number;
  // Consecutive dropped connections; drives the backoff delay. Reset on OPEN.
  reconnectAttempt: number;
  // Tool call_ids ACKed but not yet resolved. Empty again => stream can resume.
  pendingAcks: ReadonlySet<string>;
}

export const initialState: MachineState = {
  status: "DISCONNECTED",
  domFrontier: 0,
  reconnectAttempt: 0,
  pendingAcks: new Set(),
};

// Events. RECEIVE carries an already-ordered, already-deduped frame, so the
// machine never has to worry about reordering itself.
export type Event =
  | { type: "CONNECT" } // app boots / user hits connect
  | { type: "OPENED" } // socket.onopen fired
  | { type: "CLOSED"; wasClean: boolean } // socket.onclose; wasClean=false means a real drop
  | { type: "BACKOFF_FIRED" } // the reconnect timer elapsed
  | { type: "SEND_USER"; content: string } // user submitted a message
  | { type: "RECEIVE"; msg: ServerMessage } // a clean frame from the reorder buffer
  | { type: "REPLAY_QUIET" } // resume replay burst has gone quiet (timer)
  | { type: "FRAMES_RENDERED"; seq: number }; // render layer committed up to this seq

// Commands: side-effects the reducer describes for the flush layer to perform.
export type Command =
  | { type: "OPEN_SOCKET" }
  | { type: "SEND"; msg: ClientMessage } // PONG / TOOL_ACK / RESUME / USER_MESSAGE
  | { type: "RESET_BUFFER" } // wipe the reorder buffer (new turn, seq restarts at 0)
  | { type: "START_BACKOFF"; delayMs: number } // schedule a BACKOFF_FIRED in delayMs
  | { type: "SCHEDULE_REPLAY_TIMEOUT"; ms: number }; // (re)arm the REPLAY_QUIET timer

// On reconnect the server replays history in a tight burst that bypasses chaos,
// so if no replayed frame arrives for this long the burst is done. 750ms is
// longer than the synchronous burst yet well under the ~2s first live PING, so
// we're back live before any real heartbeat arrives.
export const REPLAY_QUIET_MS = 750;

// "Live" = connected and able to process a turn. RESUMING is excluded: while
// resuming we feed frames to the model but emit no outbound protocol, since
// every frame is a stale replay.
function isLive(status: Status): boolean {
  return (
    status === "CONNECTED" ||
    status === "STREAMING" ||
    status === "TOOL_CALL_PENDING"
  );
}

// Immutable Set helpers — the reducer must not mutate state in place.
function withAck(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.add(id);
  return next;
}
function withoutAck(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

const NO_COMMANDS: Command[] = [];

// One switch on the event (and a nested switch on the frame type for RECEIVE).
// Anything not handled falls through to a no-op [state, []] — an illegal event
// in a given state simply changes nothing.
export function reduce(
  state: MachineState,
  event: Event,
): [MachineState, Command[]] {
  switch (event.type) {
    case "CONNECT": {
      if (state.status !== "DISCONNECTED") return [state, NO_COMMANDS];
      return [{ ...state, status: "CONNECTING" }, [{ type: "OPEN_SOCKET" }]];
    }

    case "OPENED": {
      if (state.status !== "CONNECTING") return [state, NO_COMMANDS];
      // A clean open resets the backoff counter.
      const base = { ...state, reconnectAttempt: 0 };
      // Reconnect with an interrupted turn: RESUME must be the first frame on
      // the wire, so it's the first command emitted, then arm the quiet-timer.
      if (state.reconnectAttempt > 0 && state.domFrontier > 0) {
        return [
          { ...base, status: "RESUMING" },
          [
            { type: "SEND", msg: { type: "RESUME", last_seq: state.domFrontier } },
            { type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS },
          ],
        ];
      }
      // Fresh connect, or a reconnect with nothing in flight to resume.
      return [{ ...base, status: "CONNECTED" }, NO_COMMANDS];
    }

    case "CLOSED": {
      // Clean/intentional close (replaced, or we hung up) — go idle.
      if (event.wasClean) {
        return [{ ...state, status: "DISCONNECTED" }, NO_COMMANDS];
      }
      // A real drop (1006 / terminate). Ignore if already idle or waiting;
      // otherwise count it and schedule a reconnect.
      if (state.status === "DISCONNECTED" || state.status === "RECONNECTING") {
        return [state, NO_COMMANDS];
      }
      const attempt = state.reconnectAttempt; // 0-based: first drop -> 500ms
      return [
        { ...state, status: "RECONNECTING", reconnectAttempt: attempt + 1 },
        [{ type: "START_BACKOFF", delayMs: backoffDelay(attempt) }],
      ];
    }

    case "BACKOFF_FIRED": {
      if (state.status !== "RECONNECTING") return [state, NO_COMMANDS];
      return [{ ...state, status: "CONNECTING" }, [{ type: "OPEN_SOCKET" }]];
    }

    case "SEND_USER": {
      // Only from idle-live; the composer is disabled while streaming.
      if (state.status !== "CONNECTED") return [state, NO_COMMANDS];
      // New turn: the server restarts seq at 0, so wipe the buffer + frontiers.
      return [
        {
          ...state,
          status: "STREAMING",
          domFrontier: 0,
          pendingAcks: new Set(),
        },
        [
          { type: "RESET_BUFFER" },
          { type: "SEND", msg: { type: "USER_MESSAGE", content: event.content } },
        ],
      ];
    }

    case "REPLAY_QUIET": {
      // Replay burst done. Go to CONNECTED, not back to STREAMING: the server
      // doesn't re-run the script on resume, so a mid-stream response is
      // orphaned (no more tokens, no STREAM_END). The user can start a fresh
      // turn; an unresolved tool card just stays "waiting".
      if (state.status !== "RESUMING") return [state, NO_COMMANDS];
      return [{ ...state, status: "CONNECTED" }, NO_COMMANDS];
    }

    case "FRAMES_RENDERED": {
      // Advance the DOM frontier monotonically.
      if (event.seq <= state.domFrontier) return [state, NO_COMMANDS];
      return [{ ...state, domFrontier: event.seq }, NO_COMMANDS];
    }

    case "RECEIVE":
      return receive(state, event.msg);

    default:
      return [state, NO_COMMANDS];
  }
}

// Handle one clean, ordered frame. Split out to keep reduce() readable.
function receive(
  state: MachineState,
  msg: ServerMessage,
): [MachineState, Command[]] {
  // While RESUMING every frame is a replay: it's fed to the model elsewhere,
  // we emit no outbound protocol, and re-arm the quiet-timer.
  if (state.status === "RESUMING") {
    return [state, [{ type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS }]];
  }

  switch (msg.type) {
    case "PING": {
      // Answer only a live PING, and echo the challenge verbatim — including ""
      // — or the server logs a missed PONG (3 misses => terminate).
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      return [state, [{ type: "SEND", msg: { type: "PONG", echo: msg.challenge } }]];
    }

    case "TOOL_CALL": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // ACK immediately (well under the 5s timeout), track the call_id, and
      // enter/stay TOOL_CALL_PENDING. A rapid second tool call stacks here.
      return [
        {
          ...state,
          status: "TOOL_CALL_PENDING",
          pendingAcks: withAck(state.pendingAcks, msg.call_id),
        },
        [{ type: "SEND", msg: { type: "TOOL_ACK", call_id: msg.call_id } }],
      ];
    }

    case "TOOL_RESULT": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // Idempotent: clear this call_id (no-op if already gone; the ACK race lets
      // a RESULT land in any state). Draining the last ACK resumes the stream.
      const pendingAcks = withoutAck(state.pendingAcks, msg.call_id);
      const status: Status = pendingAcks.size === 0 ? "STREAMING" : "TOOL_CALL_PENDING";
      return [{ ...state, status, pendingAcks }, NO_COMMANDS];
    }

    case "TOKEN":
    case "CONTEXT_SNAPSHOT": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // First token of a turn promotes CONNECTED -> STREAMING; the text/data
      // itself is appended by the model.
      if (state.status === "CONNECTED") {
        return [{ ...state, status: "STREAMING" }, NO_COMMANDS];
      }
      return [state, NO_COMMANDS];
    }

    case "STREAM_END": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // The reorder buffer only releases in gapless seq order, so by the time
      // STREAM_END arrives everything before it is already processed — finalize
      // the turn immediately.
      return [{ ...state, status: "CONNECTED" }, NO_COMMANDS];
    }

    case "ERROR":
    default:
      // ERROR is in the protocol but this server never emits it. Ignore.
      return [state, NO_COMMANDS];
  }
}
