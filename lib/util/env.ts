// NEXT_PUBLIC_* is inlined at build time, so this is fine to read client-side.
// The /ws path is mandatory — the server rejects a bare-host connection.
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4747/ws";
