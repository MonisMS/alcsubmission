import type { ServerMessage } from "./types";

// All the `type` values a real server message can have.
// Kept as a Set so the check is O(1) and there's one place to update.
const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "TOKEN",
  "TOOL_CALL",
  "TOOL_RESULT",
  "CONTEXT_SNAPSHOT",
  "PING",
  "STREAM_END",
  "ERROR",
]);

// Is this unknown, freshly-parsed JSON actually a ServerMessage we can trust?
//
// `x is ServerMessage` is a TYPE PREDICATE: if this function returns true,
// TypeScript will treat `x` as a ServerMessage from then on — no cast needed.
// We only let something through if it has the two fields EVERY server message
// carries: a known `type` string and a numeric `seq`. Anything else (junk
// frame, half-object, null) is rejected so it never reaches the reorder buffer.
export function isServerMessage(x: unknown): x is ServerMessage {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  // Narrow to an indexable shape so we can read fields without `any`.
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    SERVER_MESSAGE_TYPES.has(obj.type) &&
    typeof obj.seq === "number"
  );
}
