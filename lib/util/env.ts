// Single source of truth for the backend WebSocket endpoint.
//
// NEXT_PUBLIC_* env vars are inlined at build time, so this is safe to read
// from client code. Defaults to the local agent-server; the `/ws` path is
// mandatory (the server rejects a bare-host connection).
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4747/ws";
