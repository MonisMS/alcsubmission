import type { ClientMessage, ServerMessage } from "../protocol/types";
import { isServerMessage } from "../protocol/guards";
import { WS_URL } from "../util/env";

// The callbacks the outside world gives us so we can hand events upward.
// The transport itself knows NOTHING about React, reorder buffers, or seq —
// it just turns a raw WebSocket into typed, parsed events.
export interface TransportCallbacks {
  onOpen: () => void;
  onMessage: (msg: ServerMessage) => void;
  // `wasClean` distinguishes an intentional/replaced close (code 1000, true)
  // from a hard drop (terminate / code 1006, false). The FSM needs this to
  // decide DISCONNECTED vs RECONNECTING — a drop must trigger backoff.
  onClose: (wasClean: boolean) => void;
}

// The public shape — three verbs. Same factory pattern as createReorderBuffer.
export interface Transport {
  connect(): void;
  send(msg: ClientMessage): void;
  close(): void;
}

export function createTransport(
  callbacks: TransportCallbacks,
  url: string = WS_URL,
): Transport {
  // ── private state (closure) ──
  // The live socket. `null` whenever we have no open line.
  // It lives HERE (not inside connect) so send() and close() can reach it too.
  let ws: WebSocket | null = null;

  return {
    connect() {
      // Open the line.
      ws = new WebSocket(url);

      // Line is live → tell whoever's listening.
      ws.onopen = () => {
        callbacks.onOpen();
      };

      // Server said something. The wire only carries strings, so:
      //   1. event.data is a string of JSON
      //   2. parse it into a real object
      //   3. one bad frame must NOT crash us → try/catch
      ws.onmessage = (event: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          // Malformed JSON — ignore it, keep the connection alive.
          return;
        }
        // Validate the SHAPE before trusting it. Under chaos we may see junk;
        // the guard narrows `unknown` → `ServerMessage` with no unchecked cast.
        if (!isServerMessage(parsed)) {
          return;
        }
        callbacks.onMessage(parsed);
      };

      // Line dropped (for any reason). `event.wasClean` is true only for a
      // proper close handshake (code 1000); a hard terminate (1006) is false.
      ws.onclose = (event: CloseEvent) => {
        callbacks.onClose(event.wasClean);
      };
    },

    send(msg) {
      // We can only send on a live, OPEN socket.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Typed object → JSON string → out the wire.
      ws.send(JSON.stringify(msg));
    },

    close() {
      if (!ws) {
        return;
      }
      // Intentional hang-up: detach handlers FIRST so the close we're about
      // to cause doesn't fire onClose (we don't want to treat a deliberate
      // close as a "the connection died" event).
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      ws = null;
    },
  };
}
