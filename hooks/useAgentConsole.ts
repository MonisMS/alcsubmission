"use client";

// The orchestrator. Wires the layers together:
//   transport -> reorderBuffer -> { reduce() FSM -> executeCommands,
//                                   applyMessage -> ChatModel -> render }
//
// We don't use useReducer directly because our reducer returns
// [state, Command[]], not just state. Instead a stable `dispatch` runs reduce()
// against a ref (synchronous, so frames released together can't clobber each
// other's commands), updates React state for the UI, then runs the commands —
// side-effects live in event handlers, never in render.
//
// There are two frontiers: the buffer's release frontier advances as soon as a
// frame arrives, but domFrontier advances only in a layout effect after the
// model commits to the DOM. RESUME sends domFrontier, so we never claim a seq
// the user hasn't actually seen.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  reduce,
  initialState,
  type MachineState,
  type Event,
} from "../lib/machine/connectionMachine";
import {
  applyMessage,
  emptyModel,
  type ChatModel,
} from "../lib/machine/streamModel";
import { executeCommands } from "../lib/machine/executeCommands";
import { createReorderBuffer } from "../lib/protocol/reorderBuffer";
import { createTransport, type Transport } from "../lib/transport/socket";
import type { ServerMessage } from "../lib/protocol/types";

export type TraceTone = "in" | "out" | "life";

// Consecutive TOKEN frames collapse into one of these, so the timeline stays
// short (one row per burst) instead of one row per token — which is what keeps
// it from re-rendering the whole list at the streaming rate.
export interface TokenGroupEntry {
  id: number;
  kind: "tokens";
  count: number;
  text: string;
  startMs: number;
  endMs: number;
}

// Any other event: an inbound non-token frame, outbound protocol, or a
// connection-state transition.
export interface EventEntry {
  id: number;
  kind: "event";
  tone: TraceTone;
  label: string;
  detail: string;
}

export type TraceEntry = TokenGroupEntry | EventEntry;

const TRACE_CAP = 500; // keep the timeline bounded

export interface AgentConsole {
  status: MachineState["status"];
  domFrontier: number;
  pendingToolCount: number;
  model: ChatModel;
  trace: TraceEntry[];
  sendUserMessage: (content: string) => void;
}

// Short detail line for an inbound (non-token) frame in the timeline.
function inboundDetail(msg: ServerMessage): string {
  switch (msg.type) {
    case "TOOL_CALL":
      return `${msg.tool_name} ${msg.call_id}`;
    case "TOOL_RESULT":
      return msg.call_id;
    case "CONTEXT_SNAPSHOT":
      return msg.context_id;
    case "PING":
      return `challenge "${msg.challenge}"`;
    default:
      return "";
  }
}

export function useAgentConsole(url?: string): AgentConsole {
  // Refs: live state the dispatcher reads/writes synchronously.
  const stateRef = useRef<MachineState>(initialState);
  const bufferRef = useRef(createReorderBuffer());
  const transportRef = useRef<Transport | null>(null);
  const dispatchRef = useRef<(event: Event) => void>(() => {});
  const timersRef = useRef<{
    backoff?: ReturnType<typeof setTimeout>;
    replay?: ReturnType<typeof setTimeout>;
  }>({});
  // Highest seq the buffer has released — promoted to domFrontier once the
  // model that contains it has committed.
  const releasedSeqRef = useRef(0);

  // React state that drives the UI.
  const [machine, setMachine] = useState<MachineState>(initialState);
  const [model, setModel] = useState<ChatModel>(emptyModel);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const traceIdRef = useRef(0);

  // Append a discrete event row.
  const traceEvent = useCallback((label: string, detail: string, tone: TraceTone) => {
    const id = traceIdRef.current++;
    setTrace((prev) =>
      [...prev, { id, kind: "event" as const, tone, label, detail }].slice(-TRACE_CAP),
    );
  }, []);

  // Record one token. Grows the trailing token group if there is one, so a
  // burst of tokens is a single row whose tail is the only thing that repaints.
  const traceToken = useCallback((text: string) => {
    const id = traceIdRef.current++;
    const now = Date.now();
    setTrace((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "tokens") {
        const grown: TokenGroupEntry = {
          ...last,
          count: last.count + 1,
          text: last.text + text,
          endMs: now,
        };
        return [...prev.slice(0, -1), grown];
      }
      return [
        ...prev,
        { id, kind: "tokens" as const, count: 1, text, startMs: now, endMs: now },
      ].slice(-TRACE_CAP);
    });
  }, []);

  // Arm/replace a single-shot timer; firing feeds an event back in.
  const setTimer = useCallback(
    (kind: "backoff" | "replay", ms: number, event: Event) => {
      const timers = timersRef.current;
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => dispatchRef.current(event), ms);
    },
    [],
  );

  // New turn: clear the render model + released tracker.
  const onResetTurn = useCallback(() => {
    releasedSeqRef.current = 0;
    setModel(emptyModel);
  }, []);

  // The one dispatcher. Stable identity — only refs inside.
  const dispatch = useCallback(
    (event: Event) => {
      const prev = stateRef.current;
      const [next, commands] = reduce(prev, event);
      stateRef.current = next; // synchronous — the next dispatch sees it
      setMachine(next); // async — re-renders the UI
      if (next.status !== prev.status) {
        traceEvent(`● ${next.status}`, "", "life");
      }
      if (commands.length > 0) {
        executeCommands(commands, {
          transport: transportRef.current,
          buffer: bufferRef.current,
          dispatch: dispatchRef.current,
          setTimer,
          onResetTurn,
          onTrace: traceEvent,
        });
      }
    },
    [setTimer, onResetTurn, traceEvent],
  );
  // Point the ref at the latest dispatch. Declared before the mount effect so
  // it's set before connect fires.
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // Mount: build the transport, wire callbacks, connect.
  useEffect(() => {
    const buffer = bufferRef.current;
    const timers = timersRef.current;
    const transport = createTransport(
      {
        onOpen: () => dispatchRef.current({ type: "OPENED" }),
        onMessage: (msg) => {
          // Order + dedupe; only gapless, in-order frames come back.
          const released = buffer.push(msg);
          for (const m of released) {
            if (m.type === "TOKEN") traceToken(m.text);
            else traceEvent(`↓ ${m.type}`, inboundDetail(m), "in");
            dispatchRef.current({ type: "RECEIVE", msg: m });
            setModel((prev) => applyMessage(prev, m));
          }
          if (released.length > 0) {
            // Remember the release frontier; the layout effect promotes it to
            // domFrontier once the model paints.
            releasedSeqRef.current = released[released.length - 1].seq;
          }
        },
        onClose: (wasClean) => dispatchRef.current({ type: "CLOSED", wasClean }),
      },
      url,
    );
    transportRef.current = transport;
    dispatchRef.current({ type: "CONNECT" });

    return () => {
      clearTimeout(timers.backoff);
      clearTimeout(timers.replay);
      transport.close(); // detaches handlers, so no spurious reconnect fires
      transportRef.current = null;
    };
  }, [url, traceEvent, traceToken]);

  // After the model commits, advance domFrontier. useLayoutEffect runs
  // post-commit, so the released frames are actually painted by now — the
  // honest "rendered, not merely received".
  useLayoutEffect(() => {
    if (releasedSeqRef.current > stateRef.current.domFrontier) {
      dispatchRef.current({ type: "FRAMES_RENDERED", seq: releasedSeqRef.current });
    }
  }, [model]);

  const sendUserMessage = useCallback((content: string) => {
    const trimmed = content.trim();
    if (trimmed.length > 0) dispatchRef.current({ type: "SEND_USER", content: trimmed });
  }, []);

  return {
    status: machine.status,
    domFrontier: machine.domFrontier,
    pendingToolCount: machine.pendingAcks.size,
    model,
    trace,
    sendUserMessage,
  };
}
