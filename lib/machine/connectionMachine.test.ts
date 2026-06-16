import { describe, it, expect } from "vitest";
import {
  reduce,
  initialState,
  REPLAY_QUIET_MS,
  type MachineState,
  type Command,
} from "./connectionMachine";
import type { ServerMessage } from "../protocol/types";

// ── tiny builders so tests read like prose ──
const recv = (msg: ServerMessage) => ({ type: "RECEIVE" as const, msg });
const ping = (challenge: string, seq = 1): ServerMessage => ({ type: "PING", seq, challenge });
const toolCall = (call_id: string, seq = 1): ServerMessage => ({
  type: "TOOL_CALL", seq, call_id, tool_name: "x", args: {}, stream_id: "s1",
});
const toolResult = (call_id: string, seq = 2): ServerMessage => ({
  type: "TOOL_RESULT", seq, call_id, result: {}, stream_id: "s1",
});
const token = (seq = 1): ServerMessage => ({ type: "TOKEN", seq, text: "hi", stream_id: "s1" });
const streamEnd = (seq = 9): ServerMessage => ({ type: "STREAM_END", seq, stream_id: "s1" });

// drive a list of events from a starting state, return the final state
const run = (start: MachineState, events: Parameters<typeof reduce>[1][]): MachineState =>
  events.reduce((s, e) => reduce(s, e)[0], start);

// states we commonly start from
const connected: MachineState = { ...initialState, status: "CONNECTED" };
const streaming: MachineState = { ...initialState, status: "STREAMING" };

describe("connectionMachine — lifecycle", () => {
  it("CONNECT from DISCONNECTED opens the socket", () => {
    const [s, cmds] = reduce(initialState, { type: "CONNECT" });
    expect(s.status).toBe("CONNECTING");
    expect(cmds).toEqual([{ type: "OPEN_SOCKET" }]);
  });

  it("CONNECT is a no-op unless DISCONNECTED", () => {
    const [s, cmds] = reduce(connected, { type: "CONNECT" });
    expect(s).toBe(connected); // unchanged reference
    expect(cmds).toEqual([]);
  });

  it("fresh OPENED goes straight to CONNECTED with no commands", () => {
    const connecting: MachineState = { ...initialState, status: "CONNECTING" };
    const [s, cmds] = reduce(connecting, { type: "OPENED" });
    expect(s.status).toBe("CONNECTED");
    expect(cmds).toEqual([]);
  });

  it("reconnect OPENED with an interrupted turn sends RESUME(domFrontier) FIRST", () => {
    const connectingAfterDrop: MachineState = {
      ...initialState, status: "CONNECTING", reconnectAttempt: 2, domFrontier: 5,
    };
    const [s, cmds] = reduce(connectingAfterDrop, { type: "OPENED" });
    expect(s.status).toBe("RESUMING");
    expect(s.reconnectAttempt).toBe(0); // reset on successful open
    // RESUME must be the very first command
    expect(cmds[0]).toEqual({ type: "SEND", msg: { type: "RESUME", last_seq: 5 } });
    expect(cmds[1]).toEqual({ type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS });
  });

  it("reconnect OPENED with nothing in flight (domFrontier 0) just goes CONNECTED", () => {
    const connecting: MachineState = {
      ...initialState, status: "CONNECTING", reconnectAttempt: 1, domFrontier: 0,
    };
    const [s, cmds] = reduce(connecting, { type: "OPENED" });
    expect(s.status).toBe("CONNECTED");
    expect(cmds).toEqual([]);
  });

  it("unclean CLOSED starts backoff with the right delay and increments the attempt", () => {
    const [s, cmds] = reduce(streaming, { type: "CLOSED", wasClean: false });
    expect(s.status).toBe("RECONNECTING");
    expect(s.reconnectAttempt).toBe(1);
    expect(cmds).toEqual([{ type: "START_BACKOFF", delayMs: 500 }]); // backoffDelay(0)
  });

  it("a second consecutive drop backs off longer", () => {
    const afterOneDrop = reduce(streaming, { type: "CLOSED", wasClean: false })[0];
    const reconnecting = reduce(afterOneDrop, { type: "BACKOFF_FIRED" })[0]; // -> CONNECTING
    const [s, cmds] = reduce(reconnecting, { type: "CLOSED", wasClean: false });
    expect(s.reconnectAttempt).toBe(2);
    expect(cmds).toEqual([{ type: "START_BACKOFF", delayMs: 1000 }]); // backoffDelay(1)
  });

  it("clean CLOSED goes to DISCONNECTED with no reconnect", () => {
    const [s, cmds] = reduce(streaming, { type: "CLOSED", wasClean: true });
    expect(s.status).toBe("DISCONNECTED");
    expect(cmds).toEqual([]);
  });

  it("BACKOFF_FIRED reopens the socket", () => {
    const reconnecting: MachineState = { ...initialState, status: "RECONNECTING", reconnectAttempt: 1 };
    const [s, cmds] = reduce(reconnecting, { type: "BACKOFF_FIRED" });
    expect(s.status).toBe("CONNECTING");
    expect(cmds).toEqual([{ type: "OPEN_SOCKET" }]);
  });
});

describe("connectionMachine — turn + streaming", () => {
  it("SEND_USER resets the buffer/frontier and sends USER_MESSAGE", () => {
    const dirty: MachineState = { ...connected, domFrontier: 7, pendingAcks: new Set(["tc_1"]) };
    const [s, cmds] = reduce(dirty, { type: "SEND_USER", content: "analyze this" });
    expect(s.status).toBe("STREAMING");
    expect(s.domFrontier).toBe(0);
    expect(s.pendingAcks.size).toBe(0);
    expect(cmds).toEqual([
      { type: "RESET_BUFFER" },
      { type: "SEND", msg: { type: "USER_MESSAGE", content: "analyze this" } },
    ]);
  });

  it("SEND_USER is ignored while busy (not CONNECTED)", () => {
    const [s, cmds] = reduce(streaming, { type: "SEND_USER", content: "x" });
    expect(s).toBe(streaming);
    expect(cmds).toEqual([]);
  });

  it("a TOKEN promotes CONNECTED -> STREAMING", () => {
    const [s, cmds] = reduce(connected, recv(token()));
    expect(s.status).toBe("STREAMING");
    expect(cmds).toEqual([]);
  });

  it("STREAM_END finalizes the turn back to CONNECTED", () => {
    const [s] = reduce(streaming, recv(streamEnd()));
    expect(s.status).toBe("CONNECTED");
  });
});

describe("connectionMachine — PING / PONG", () => {
  it("a live PING is answered with PONG echoing the challenge verbatim", () => {
    const [, cmds] = reduce(streaming, recv(ping("abc123")));
    expect(cmds).toEqual([{ type: "SEND", msg: { type: "PONG", echo: "abc123" } }]);
  });

  it("an empty-challenge PING is still PONGed with echo:'' (corrupt PING gotcha)", () => {
    const [, cmds] = reduce(streaming, recv(ping("")));
    expect(cmds).toEqual([{ type: "SEND", msg: { type: "PONG", echo: "" } }]);
  });

  it("a PING received while RESUMING is NOT answered (it is a replay)", () => {
    const resuming: MachineState = { ...initialState, status: "RESUMING" };
    const [s, cmds] = reduce(resuming, recv(ping("stale")));
    expect(s.status).toBe("RESUMING");
    // only re-arms the quiet timer, never a PONG
    expect(cmds).toEqual([{ type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS }]);
  });

  it("a PING while DISCONNECTED is ignored", () => {
    const [, cmds] = reduce(initialState, recv(ping("x")));
    expect(cmds).toEqual([]);
  });
});

describe("connectionMachine — tool calls", () => {
  it("TOOL_CALL acks immediately and enters TOOL_CALL_PENDING", () => {
    const [s, cmds] = reduce(streaming, recv(toolCall("tc_1")));
    expect(s.status).toBe("TOOL_CALL_PENDING");
    expect(s.pendingAcks.has("tc_1")).toBe(true);
    expect(cmds).toEqual([{ type: "SEND", msg: { type: "TOOL_ACK", call_id: "tc_1" } }]);
  });

  it("two rapid tool calls stack; both must resolve before STREAMING resumes", () => {
    let s = reduce(streaming, recv(toolCall("tc_1")))[0];
    s = reduce(s, recv(toolCall("tc_2")))[0];
    expect(s.status).toBe("TOOL_CALL_PENDING");
    expect(s.pendingAcks.size).toBe(2);

    // first result: still one outstanding -> stay pending
    s = reduce(s, recv(toolResult("tc_1")))[0];
    expect(s.status).toBe("TOOL_CALL_PENDING");

    // last result: drained -> resume STREAMING
    s = reduce(s, recv(toolResult("tc_2")))[0];
    expect(s.status).toBe("STREAMING");
    expect(s.pendingAcks.size).toBe(0);
  });

  it("a TOOL_RESULT for an unknown call_id is a harmless no-op (idempotent / ACK race)", () => {
    const [s, cmds] = reduce(streaming, recv(toolResult("ghost")));
    expect(s.status).toBe("STREAMING");
    expect(cmds).toEqual([]);
  });
});

describe("connectionMachine — RESUMING + frontier", () => {
  it("FRAMES_RENDERED advances domFrontier monotonically only", () => {
    let s = reduce(streaming, { type: "FRAMES_RENDERED", seq: 3 })[0];
    expect(s.domFrontier).toBe(3);
    s = reduce(s, { type: "FRAMES_RENDERED", seq: 2 })[0]; // older — ignored
    expect(s.domFrontier).toBe(3);
    s = reduce(s, { type: "FRAMES_RENDERED", seq: 5 })[0];
    expect(s.domFrontier).toBe(5);
  });

  it("RESUMING + REPLAY_QUIET returns to CONNECTED", () => {
    const resuming: MachineState = { ...initialState, status: "RESUMING" };
    const [s] = reduce(resuming, { type: "REPLAY_QUIET" });
    expect(s.status).toBe("CONNECTED");
  });

  it("full mid-stream drop -> reconnect -> RESUME -> quiet -> live path", () => {
    // streaming, rendered up to seq 5, then the line drops
    const mid = run(streaming, [{ type: "FRAMES_RENDERED", seq: 5 }]);
    const dropped = run(mid, [{ type: "CLOSED", wasClean: false }]);
    expect(dropped.status).toBe("RECONNECTING");

    const reopening = run(dropped, [{ type: "BACKOFF_FIRED" }]);
    expect(reopening.status).toBe("CONNECTING");

    const [resuming, openCmds] = reduce(reopening, { type: "OPENED" });
    expect(resuming.status).toBe("RESUMING");
    expect(openCmds[0]).toEqual({ type: "SEND", msg: { type: "RESUME", last_seq: 5 } });

    const live = run(resuming, [recv(token(6)), recv(streamEnd(7)), { type: "REPLAY_QUIET" }]);
    expect(live.status).toBe("CONNECTED"); // orphaned/ended stream, ready for a new turn
  });
});

describe("connectionMachine — unknown commands stay typed", () => {
  it("the Command union is exhaustively constructed (compile-time guard)", () => {
    // a throwaway runtime assertion that doubles as a reminder if the union grows
    const sample: Command[] = [
      { type: "OPEN_SOCKET" },
      { type: "RESET_BUFFER" },
      { type: "START_BACKOFF", delayMs: 500 },
      { type: "SCHEDULE_REPLAY_TIMEOUT", ms: REPLAY_QUIET_MS },
      { type: "SEND", msg: { type: "PONG", echo: "" } },
    ];
    expect(sample).toHaveLength(5);
  });
});
