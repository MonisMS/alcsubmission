"use client";

// ─────────────────────────────────────────────────────────────
// useAgentConsole — the orchestrator. Wires the four layers together:
//
//   transport (L1) ──onMessage──▶ reorderBuffer (L2) ──released──▶
//        ├──▶ reduce() FSM (L3)  ──Command[]──▶ executeCommands
//        └──▶ applyMessage streamModel ──▶ ChatModel (L4 renders)
//
// Design notes worth defending:
//  • We do NOT use useReducer directly, because our reducer returns
//    [state, Command[]] (not just state). Instead a stable `dispatch`
//    computes reduce() against a REF (synchronous, so several frames
//    released together can't clobber each other's commands), updates
//    React state for the UI, then runs the emitted commands. Side-effects
//    happen in event handlers — never during render.
//  • Two frontiers: the buffer's RELEASE frontier advances the moment a
//    frame arrives; the FSM's domFrontier advances only in a layout effect
//    AFTER the model commits to the DOM. RESUME sends domFrontier, so we
//    never claim a seq the user hasn't actually seen.
// ─────────────────────────────────────────────────────────────

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

export type TraceTone = "in" | "out" | "life";

export interface TraceEntry {
  id: number;
  label: string;
  detail: string;
  tone: TraceTone;
}

const TRACE_CAP = 500; // keep the timeline bounded

export interface AgentConsole {
  status: MachineState["status"];
  domFrontier: number;
  pendingToolCount: number;
  model: ChatModel;
  trace: TraceEntry[];
  sendUserMessage: (content: string) => void;
}

// short detail line for an inbound frame in the Timeline
function inboundDetail(msg: Parameters<typeof applyMessage>[1]): string {
  switch (msg.type) {
    case "TOKEN":
      return JSON.stringify(msg.text);
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
  // ── refs: live state the dispatcher reads/writes synchronously ──
  const stateRef = useRef<MachineState>(initialState);
  const bufferRef = useRef(createReorderBuffer());
  const transportRef = useRef<Transport | null>(null);
  const dispatchRef = useRef<(event: Event) => void>(() => {});
  const timersRef = useRef<{
    backoff?: ReturnType<typeof setTimeout>;
    replay?: ReturnType<typeof setTimeout>;
  }>({});
  // Highest seq the buffer has RELEASED — candidate for the DOM frontier
  // once the model that contains it has committed.
  const releasedSeqRef = useRef(0);

  // ── React state that drives the UI ──
  const [machine, setMachine] = useState<MachineState>(initialState);
  const [model, setModel] = useState<ChatModel>(emptyModel);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const traceIdRef = useRef(0);

  // append a bounded trace entry (the Timeline reads this)
  const pushTrace = useCallback((label: string, detail: string, tone: TraceTone) => {
    const id = traceIdRef.current++;
    setTrace((prev) => [...prev, { id, label, detail, tone }].slice(-TRACE_CAP));
  }, []);

  // arm/replace a single-shot timer; firing feeds an event back in
  const setTimer = useCallback(
    (kind: "backoff" | "replay", ms: number, event: Event) => {
      const timers = timersRef.current;
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => dispatchRef.current(event), ms);
    },
    [],
  );

  // new turn: clear the render model + released tracker
  const onResetTurn = useCallback(() => {
    releasedSeqRef.current = 0;
    setModel(emptyModel);
  }, []);

  // the one dispatcher. Stable identity (refs only inside).
  const dispatch = useCallback(
    (event: Event) => {
      const prev = stateRef.current;
      const [next, commands] = reduce(prev, event);
      stateRef.current = next; // synchronous — next dispatch sees it
      setMachine(next); // async — re-renders the UI
      if (next.status !== prev.status) {
        pushTrace(`● ${next.status}`, "", "life"); // a connection transition
      }
      if (commands.length > 0) {
        executeCommands(commands, {
          transport: transportRef.current,
          buffer: bufferRef.current,
          dispatch: dispatchRef.current,
          setTimer,
          onResetTurn,
          onTrace: pushTrace,
        });
      }
    },
    [setTimer, onResetTurn, pushTrace],
  );
  // Keep the ref pointing at the latest dispatch (it's stable, so this runs
  // once). Declared BEFORE the mount effect so it's set before connect fires.
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // ── mount: build the transport, wire callbacks, connect ──
  useEffect(() => {
    const buffer = bufferRef.current;
    const timers = timersRef.current;
    const transport = createTransport(
      {
        onOpen: () => dispatchRef.current({ type: "OPENED" }),
        onMessage: (msg) => {
          // L2: order + dedupe. Only gapless, in-order frames come back.
          const released = buffer.push(msg);
          for (const m of released) {
            pushTrace(`↓ ${m.type}`, inboundDetail(m), "in"); // timeline
            dispatchRef.current({ type: "RECEIVE", msg: m }); // FSM (PONG/ACK)
            setModel((prev) => applyMessage(prev, m)); // render model
          }
          if (released.length > 0) {
            // remember the release frontier; the layout effect promotes it
            // to the DOM frontier after the model paints.
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
      transport.close(); // detaches handlers → no onClose → no spurious reconnect
      transportRef.current = null;
    };
  }, [url, pushTrace]);

  // ── after the model commits to the DOM, advance the DOM frontier ──
  // useLayoutEffect runs post-commit, so by here the released frames are
  // actually painted. This is the honest "rendered, not merely received".
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
