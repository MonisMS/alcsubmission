// Folds an ordered run of ServerMessages into a render-ready ChatModel. The
// response is a list of segments in arrival order: text segments (a run of
// TOKENs concatenated) and tool segments (a TOOL_CALL card, later resolved by
// its TOOL_RESULT).
//
// The key idea is the token-boundary freeze: when a TOOL_CALL interrupts the
// text, the open text segment is frozen and the tool card is appended; tokens
// after the tool resolves open a brand-new segment rather than flowing back
// into the frozen one. That's what prevents flicker, reflow, and duplication.
// The mechanism is reference stability — appendToken rebuilds only the last
// segment and reuses the references of every earlier one, so React's reconciler
// only repaints the growing tail.
//
// applyMessage(model, msg) is the live path; the resume path folds it
// incrementally too (one replayed frame at a time). buildModel(msgs) is the
// batch equivalent the resume-parity test folds over a whole history at once —
// asserting the incremental and batch results agree, so a resumed render can't
// diverge from the live one.

import type { ServerMessage } from "../protocol/types";

export interface TextSegment {
  kind: "text";
  id: string;
  text: string;
  frozen: boolean; // once true, immutable — no more tokens will join it
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
  context: ContextSnapshot | null; // latest snapshot, for the inspector
  previousContext: ContextSnapshot | null; // the one before it, to diff against
  ended: boolean; // STREAM_END seen
}

export const emptyModel: ChatModel = {
  segments: [],
  context: null,
  previousContext: null,
  ended: false,
};

// Freeze the last segment if it's an open text run; otherwise return the same
// array reference. Called at every tool/stream boundary.
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
    // Grow the open tail; slice(0,-1) reuses every earlier reference.
    const grown: TextSegment = { ...last, text: last.text + text };
    return { ...model, segments: [...model.segments.slice(0, -1), grown] };
  }
  // No open text segment (start of turn, or just after a tool) — open one.
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
  const segments = freezeOpenText(model.segments); // close the open text run first
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
  // Unknown / already-resolved call_id (ACK race, duplicate) — no-op, same ref.
  return changed ? { ...model, segments } : model;
}

// Apply one clean, ordered frame. Returns a new model, or the same reference
// when nothing changed. PING / ERROR aren't part of the rendered response.
export function applyMessage(model: ChatModel, msg: ServerMessage): ChatModel {
  switch (msg.type) {
    case "TOKEN":
      return appendToken(model, msg.text);
    case "TOOL_CALL":
      return openToolCard(model, msg);
    case "TOOL_RESULT":
      return resolveToolCard(model, msg);
    case "CONTEXT_SNAPSHOT":
      // Shift current -> previous so the inspector can diff successive snapshots.
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

// Batch fold of a whole run of frames. The live and resume paths apply frames
// one at a time; this folds them all at once via the same applyMessage, and the
// resume-parity test asserts the two agree.
export function buildModel(msgs: ServerMessage[]): ChatModel {
  return msgs.reduce(applyMessage, emptyModel);
}
