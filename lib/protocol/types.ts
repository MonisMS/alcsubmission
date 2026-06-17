// Client-side mirror of the wire protocol (agent-server/src/types.ts). Only the
// messages that actually cross the WebSocket are copied here; the server's
// internals are not. A field change on the server should surface as a type
// error where these are consumed.

// Server -> Client. Every message carries a `type` discriminant and a `seq`.

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

// Client -> Server. These carry no seq.

export interface UserMessagePayload {
  type: "USER_MESSAGE";
  content: string;
}

export interface PongPayload {
  type: "PONG";
  echo: string; // field is `echo`, not `challenge`; holds the PING challenge verbatim
}

export interface ResumePayload {
  type: "RESUME";
  last_seq: number; // highest seq rendered to DOM, not merely received
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
