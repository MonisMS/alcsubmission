// ─────────────────────────────────────────────────────────────
// Wire protocol types — client-side mirror of agent-server/src/types.ts
//
// We deliberately copy ONLY the messages that cross the WebSocket.
// The server's internals (ChaosConfig, ResponseScript, ClientLogEntry,
// ServerMode) are NOT mirrored — the client never sees them.
//
// If the server ever changes a field, the divergence should surface
// here as a type error where these are consumed.
// ─────────────────────────────────────────────────────────────

// ── Server → Client ───────────────────────────────────────────
// Every server message carries a `type` discriminant and a `seq`.

export interface TokenMessage {
  type: "TOKEN";
  seq: number;
  text: string;
  stream_id: string;
}

export interface ToolCallMessage {
  type: "TOOL_CALL";
  seq: number;
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  stream_id: string;
}

export interface ToolResultMessage {
  type: "TOOL_RESULT";
  seq: number;
  call_id: string;
  result: Record<string, unknown>;
  stream_id: string;
}

export interface ContextSnapshotMessage {
  type: "CONTEXT_SNAPSHOT";
  seq: number;
  context_id: string;
  data: Record<string, unknown>;
}

export interface PingMessage {
  type: "PING";
  seq: number;
  challenge: string; // may be "" in chaos mode — echo it back verbatim anyway
}

export interface StreamEndMessage {
  type: "STREAM_END";
  seq: number;
  stream_id: string;
}

export interface ErrorMessage {
  type: "ERROR";
  seq: number;
  code: string;
  message: string;
}

export type ServerMessage =
  | TokenMessage
  | ToolCallMessage
  | ToolResultMessage
  | ContextSnapshotMessage
  | PingMessage
  | StreamEndMessage
  | ErrorMessage;

// ── Client → Server ───────────────────────────────────────────
// NOTE: client messages carry NO seq number.

export interface UserMessagePayload {
  type: "USER_MESSAGE";
  content: string;
}

export interface PongPayload {
  type: "PONG";
  echo: string; // ⚠ field is `echo`, NOT `challenge` — holds the PING's challenge verbatim
}

export interface ResumePayload {
  type: "RESUME";
  last_seq: number; // highest seq RENDERED TO DOM (the "DOM frontier"), not merely received
}

export interface ToolAckPayload {
  type: "TOOL_ACK";
  call_id: string;
}

export type ClientMessage =
  | UserMessagePayload
  | PongPayload
  | ResumePayload
  | ToolAckPayload;
