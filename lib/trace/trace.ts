// Trace model — the observability log behind the timeline. Pure data + pure
// reducers over a TraceEntry[], with no React in sight, so the token-grouping
// rule is unit-testable on its own. The useTrace() hook is the thin stateful
// wrapper; executeCommands and the inbound path feed it.

import type { ServerMessage } from "../protocol/types";

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

export const TRACE_CAP = 500; // keep the timeline bounded

// Append a discrete event row, trimming to the cap.
export function appendEvent(
  prev: TraceEntry[],
  id: number,
  label: string,
  detail: string,
  tone: TraceTone,
): TraceEntry[] {
  return [...prev, { id, kind: "event" as const, tone, label, detail }].slice(
    -TRACE_CAP,
  );
}

// Record one token. Grows the trailing token group if there is one, so a burst
// of tokens is a single row whose tail is the only thing that repaints;
// otherwise it opens a new group. `now` is injected so this stays pure.
export function appendToken(
  prev: TraceEntry[],
  id: number,
  text: string,
  now: number,
): TraceEntry[] {
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
}

// Short detail line for an inbound (non-token) frame in the timeline.
export function inboundDetail(msg: ServerMessage): string {
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
