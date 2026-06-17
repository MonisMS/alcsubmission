import type { ServerMessage } from "./types";

const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "TOKEN",
  "TOOL_CALL",
  "TOOL_RESULT",
  "CONTEXT_SNAPSHOT",
  "PING",
  "STREAM_END",
  "ERROR",
]);

// Narrows freshly-parsed JSON to a ServerMessage. We require a known `type`
// and a numeric `seq`; anything else (junk frame, null, half-object) is
// rejected before it can reach the reorder buffer.
export function isServerMessage(x: unknown): x is ServerMessage {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    SERVER_MESSAGE_TYPES.has(obj.type) &&
    typeof obj.seq === "number"
  );
}
