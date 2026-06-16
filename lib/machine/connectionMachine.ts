// ─────────────────────────────────────────────────────────────
// Connection state machine — L3 CONTROLLER. The spine of the app.
//
// This is a PURE reducer:   reduce(state, event) -> [nextState, Command[]]
// It NEVER touches a socket, a timer, React, or the DOM. It takes a
// validated, already-ordered, already-deduped ServerMessage (the reorder
// buffer in L2 did that) plus lifecycle events, and it returns the next
// state and a list of side-effects ("Commands") for someone else to run.
//
// Why a state machine instead of a pile of useEffect booleans?
//   1. STREAMING and TOOL_CALL_PENDING are mutually exclusive, and a TOKEN
//      means different things in each. Booleans make illegal combos
//      representable; a single `status` makes them unrepresentable.
//   2. On reconnect, RESUME must be the FIRST frame sent — before any
//      replay is processed. Effect ordering can't guarantee that; one
//      atomic transition can.
//   3. reduce(state,event) -> [state, commands] is trivially unit-testable
//      and explainable one row at a time. PONG / TOOL_ACK / RESUME are
//      returned as Commands and flushed by a thin effect — never sent inline.
// ─────────────────────────────────────────────────────────────

import type { ServerMessage, ClientMessage } from "../protocol/types";
import { backoffDelay } from "../transport/backoff";

// ── The seven connection states ──────────────────────────────
//   DISCONNECTED      no socket; idle (initial, or after a clean/intentional close)
//   CONNECTING        socket opening (fresh OR a reconnect attempt)
//   CONNECTED         live and idle — ready to send a USER_MESSAGE
//   STREAMING         a turn is in flight; tokens/context arriving
//   TOOL_CALL_PENDING ≥1 tool call shown, waiting on its TOOL_RESULT(s)
//   RECONNECTING      line died unexpectedly; waiting out the backoff timer
//   RESUMING          reconnected; replaying history — outbound protocol is SUPPRESSED
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
  // Highest seq actually RENDERED TO THE DOM — the "DOM frontier".
  // This is what RESUME sends, NOT the highest seq received off the socket.
  // It is advanced ONLY by FRAMES_RENDERED (fired by the render layer AFTER
  // React commits), so we never tell the server "I have N" before the user
  // can actually see N.
  domFrontier: number;
  // How many consecutive connections have died. Drives the backoff delay.
  // Reset to 0 on any successful OPEN.
  reconnectAttempt: number;
  // Tool call_ids we've ACKed but not yet seen a TOOL_RESULT for.
  // Empty again => the stream can resume from TOOL_CALL_PENDING to STREAMING.
  pendingAcks: ReadonlySet<string>;
}

export const initialState: MachineState = {
  status: "DISCONNECTED",
  domFrontier: 0,
  reconnectAttempt: 0,
  pendingAcks: new Set(),
};

// ── Events: everything that can happen TO the machine ─────────
// Note RECEIVE carries an already-ordered, already-deduped frame — the
// reorder buffer guarantees the machine sees frames in gapless seq order,
// which is why the machine itself never worries about reordering.
export type Event =
  | { type: "CONNECT" } // app boots / user hits connect
  | { type: "OPENED" } // socket.onopen fired
  | { type: "CLOSED"; wasClean: boolean } // socket.onclose; wasClean=false ⇒ a real drop
  | { type: "BACKOFF_FIRED" } // the reconnect timer elapsed
  | { type: "SEND_USER"; content: string } // user submitted a message
  | { type: "RECEIVE"; msg: ServerMessage } // a clean frame from the reorder buffer
  | { type: "REPLAY_QUIET" } // resume replay burst has gone quiet (timer)
  | { type: "FRAMES_RENDERED"; seq: number }; // render layer committed up to this seq

// ── Commands: side-effects the machine ASKS the outside world to run ──
// The reducer can't perform these (it's pure); the flush layer does.
export type Command =
  | { type: "OPEN_SOCKET" }
  | { type: "SEND"; msg: ClientMessage } // PONG / TOOL_ACK / RESUME / USER_MESSAGE
  | { type: "RESET_BUFFER" } // wipe the reorder buffer (new turn, seq restarts at 0)
  | { type: "START_BACKOFF"; delayMs: number } // schedule a BACKOFF_FIRED in delayMs
  | { type: "SCHEDULE_REPLAY_TIMEOUT"; ms: number }; // (re)arm the REPLAY_QUIET timer

// After a reconnect, the server replays history via rawSend in a tight burst
// (it BYPASSES chaos — no latency spikes during replay). So if no replayed
// frame has arrived for this long, the burst is done. 750ms is comfortably
// longer than a synchronous burst yet well under the ~2s-after-connect first
// live heartbeat PING — so we're back "live" before any real PING arrives.
export const REPLAY_QUIET_MS = 750;

// ── helpers ───────────────────────────────────────────────────

// "Live" = connected and able to process a turn. RESUMING is deliberately
// excluded: while resuming we replay frames into the model but emit NO
// outbound protocol (no PONG, no TOOL_ACK) because everything is a stale replay.
function isLive(status: Status): boolean {
  return (
    status === "CONNECTED" ||
    status === "STREAMING" ||
    status === "TOOL_CALL_PENDING"
  );
}

// immutable Set helpers (the reducer must not mutate state in place)
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

// ── the reducer ───────────────────────────────────────────────
// One switch on the event, and for RECEIVE a nested switch on the frame type.
// Anything not explicitly handled falls through to a no-op [state, []] — an
// illegal event in a given state changes nothing, which is exactly what we want.
export function reduce(
  state: MachineState,
  event: Event,
): [MachineState, Command[]] {
  switch (event.type) {
    // ── lifecycle ──────────────────────────────────────────
    case "CONNECT": {
      if (state.status !== "DISCONNECTED") return [state, NO_COMMANDS];
      return [{ ...state, status: "CONNECTING" }, [{ type: "OPEN_SOCKET" }]];
    }

    case "OPENED": {
      if (state.status !== "CONNECTING") return [state, NO_COMMANDS];
      // A clean open always resets the backoff counter.
      const base = { ...state, reconnectAttempt: 0 };
      // Reconnect with an interrupted turn (domFrontier > 0): RESUME FIRST,
      // then arm the quiet-timer that will end the replay. RESUME must be the
      // very first frame on the wire — so it's the first command emitted.
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
      // Clean/intentional close (replaced, or we hung up) — just go idle.
      if (event.wasClean) {
        return [{ ...state, status: "DISCONNECTED" }, NO_COMMANDS];
      }
      // A real drop (1006 / terminate). If we're already idle or waiting,
      // ignore; otherwise count it and schedule a backoff'd reconnect.
      if (state.status === "DISCONNECTED" || state.status === "RECONNECTING") {
        return [state, NO_COMMANDS];
      }
      const attempt = state.reconnectAttempt; // 0-based: first drop uses backoffDelay(0)=500
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
      // Only from idle-live. If busy (streaming/tool), the composer is disabled.
      if (state.status !== "CONNECTED") return [state, NO_COMMANDS];
      // New turn: server restarts seq at 0, so wipe the buffer + our frontiers.
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
      // Replay burst is done. Go live-idle. We do NOT try to restore STREAMING:
      // the server does not re-run the script on resume, so any mid-stream
      // response is orphaned (no more tokens, no STREAM_END coming). CONNECTED
      // is the honest state — the user can start a fresh turn. An unresolved
      // tool card simply stays "waiting" in the UI (a tolerated failure mode).
      if (state.status !== "RESUMING") return [state, NO_COMMANDS];
      return [{ ...state, status: "CONNECTED" }, NO_COMMANDS];
    }

    case "FRAMES_RENDERED": {
      // Advance the DOM frontier monotonically. No status change, no command.
      if (event.seq <= state.domFrontier) return [state, NO_COMMANDS];
      return [{ ...state, domFrontier: event.seq }, NO_COMMANDS];
    }

    // ── inbound frames ─────────────────────────────────────
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
  // While RESUMING, every frame is a replay: feed it to the model (elsewhere),
  // emit NO outbound protocol, and re-arm the quiet-timer so the burst end is
  // detected correctly.
  if (state.status === "RESUMING") {
    return [state, [{ type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS }]];
  }

  switch (msg.type) {
    case "PING": {
      // Answer ONLY a live PING. echo the challenge VERBATIM — including "" —
      // or the server counts it as a missed PONG (3 misses ⇒ terminate).
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      return [state, [{ type: "SEND", msg: { type: "PONG", echo: msg.challenge } }]];
    }

    case "TOOL_CALL": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // ACK immediately (well under the 5s server timeout), track the call_id,
      // and enter/stay TOOL_CALL_PENDING. Rapid second tool call stacks here.
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
      // Idempotent: clear this call_id (no-op if already gone — the ACK race
      // means a RESULT can land in any state). If that drained the last
      // outstanding ACK, the stream resumes; otherwise more cards are pending.
      const pendingAcks = withoutAck(state.pendingAcks, msg.call_id);
      const status: Status = pendingAcks.size === 0 ? "STREAMING" : "TOOL_CALL_PENDING";
      return [{ ...state, status, pendingAcks }, NO_COMMANDS];
    }

    case "TOKEN":
    case "CONTEXT_SNAPSHOT": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // First token of a turn promotes CONNECTED -> STREAMING; otherwise the
      // status is unchanged. The text/data itself is appended by the model.
      if (state.status === "CONNECTED") {
        return [{ ...state, status: "STREAMING" }, NO_COMMANDS];
      }
      return [state, NO_COMMANDS];
    }

    case "STREAM_END": {
      if (!isLive(state.status)) return [state, NO_COMMANDS];
      // Because the reorder buffer only releases in gapless seq order, by the
      // time STREAM_END reaches us everything before it is already processed —
      // so we can finalize the turn immediately. (The L2 layer already solved
      // the "STREAM_END arrives early in chaos" problem for us.)
      return [{ ...state, status: "CONNECTED" }, NO_COMMANDS];
    }

    case "ERROR":
    default:
      // ERROR is defined in the protocol but never emitted by this server.
      // Handle defensively: ignore, stay where we are.
      return [state, NO_COMMANDS];
  }
}
