// ─────────────────────────────────────────────────────────────
// Stream model — folds an ordered run of ServerMessages into a
// render-ready ChatModel. This is where Streaming Fidelity (20%) lives.
//
// The response is a list of SEGMENTS in arrival order:
//   • text segment  — a run of TOKENs concatenated
//   • tool segment  — a TOOL_CALL card, later resolved by its TOOL_RESULT
//
// The critical idea is the TOKEN-BOUNDARY FREEZE:
//   When a TOOL_CALL interrupts the text, the open text segment is FROZEN
//   (made immutable) and the tool card is appended. When tokens resume after
//   the tool resolves, they open a BRAND-NEW text segment — they never flow
//   back into the frozen one. That's what prevents flicker / reflow / dupes.
//
// Reference stability is the mechanism: appendToken rebuilds only the LAST
// segment and REUSES the references of every earlier (frozen) segment. So
// React's reconciler sees the frozen segments as unchanged and never
// re-renders them — only the one growing tail segment repaints.
//
// Pure + incremental: applyMessage(model, msg) for the live path, and
// buildModel(msgs) (a fold of applyMessage) to rebuild from replayed history
// on RESUME. Same function ⇒ live render and resumed render can't diverge.
// ─────────────────────────────────────────────────────────────

import type { ServerMessage } from "../protocol/types";

export interface TextSegment {
  kind: "text";
  id: string;
  text: string;
  frozen: boolean; // true ⇒ immutable; no more tokens will ever join it
}

export interface ToolSegment {
  kind: "tool";
  id: string;
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  status: "pending" | "resolved";
  result: Record<string, unknown> | null;
}

export type Segment = TextSegment | ToolSegment;

export interface ContextSnapshot {
  context_id: string;
  data: Record<string, unknown>;
}

export interface ChatModel {
  segments: Segment[];
  context: ContextSnapshot | null; // latest CONTEXT_SNAPSHOT (for the inspector)
  previousContext: ContextSnapshot | null; // the one before it, so we can diff old→new
  ended: boolean; // STREAM_END seen
}

export const emptyModel: ChatModel = {
  segments: [],
  context: null,
  previousContext: null,
  ended: false,
};

// If the last segment is an OPEN text segment, return a copy of the array with
// it frozen; otherwise return the array unchanged (same reference). Used at
// every tool/stream boundary so text never resumes into a closed segment.
function freezeOpenText(segments: Segment[]): Segment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === "text" && !last.frozen) {
    const frozen: TextSegment = { ...last, frozen: true };
    return [...segments.slice(0, -1), frozen];
  }
  return segments;
}

function appendToken(model: ChatModel, text: string): ChatModel {
  const last = model.segments[model.segments.length - 1];
  if (last && last.kind === "text" && !last.frozen) {
    // Grow the open tail segment. Reuse every earlier reference (slice(0,-1)).
    const grown: TextSegment = { ...last, text: last.text + text };
    return { ...model, segments: [...model.segments.slice(0, -1), grown] };
  }
  // No open text segment (start of turn, or right after a tool) → open one.
  const seg: TextSegment = {
    kind: "text",
    id: `seg-${model.segments.length}`,
    text,
    frozen: false,
  };
  return { ...model, segments: [...model.segments, seg] };
}

function openToolCard(
  model: ChatModel,
  msg: Extract<ServerMessage, { type: "TOOL_CALL" }>,
): ChatModel {
  const segments = freezeOpenText(model.segments); // close the text run first
  const card: ToolSegment = {
    kind: "tool",
    id: `seg-${segments.length}`,
    call_id: msg.call_id,
    tool_name: msg.tool_name,
    args: msg.args,
    status: "pending",
    result: null,
  };
  return { ...model, segments: [...segments, card] };
}

function resolveToolCard(
  model: ChatModel,
  msg: Extract<ServerMessage, { type: "TOOL_RESULT" }>,
): ChatModel {
  let changed = false;
  const segments = model.segments.map((s) => {
    if (s.kind === "tool" && s.call_id === msg.call_id && s.status === "pending") {
      changed = true;
      return { ...s, status: "resolved" as const, result: msg.result };
    }
    return s;
  });
  // Unknown / already-resolved call_id (ACK race, duplicate) → no-op, same ref.
  return changed ? { ...model, segments } : model;
}

// Apply ONE clean, ordered frame to the model. Returns a new model (or the
// same reference when nothing changed). PING / ERROR are not part of the
// rendered response, so they fall through untouched.
export function applyMessage(model: ChatModel, msg: ServerMessage): ChatModel {
  switch (msg.type) {
    case "TOKEN":
      return appendToken(model, msg.text);
    case "TOOL_CALL":
      return openToolCard(model, msg);
    case "TOOL_RESULT":
      return resolveToolCard(model, msg);
    case "CONTEXT_SNAPSHOT":
      // Shift current → previous so the inspector can diff successive snapshots.
      return {
        ...model,
        previousContext: model.context,
        context: { context_id: msg.context_id, data: msg.data },
      };
    case "STREAM_END":
      return { ...model, segments: freezeOpenText(model.segments), ended: true };
    default:
      return model;
  }
}

// Fold a whole run of frames into a model — used to rebuild from replayed
// history on RESUME. buildModel(history) and the live applyMessage path share
// the exact same logic, so a resumed render can never disagree with a live one.
export function buildModel(msgs: ServerMessage[]): ChatModel {
  return msgs.reduce(applyMessage, emptyModel);
}
