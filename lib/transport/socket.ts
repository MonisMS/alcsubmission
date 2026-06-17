import type { ClientMessage, ServerMessage } from "../protocol/types";
import { isServerMessage } from "../protocol/guards";
import { WS_URL } from "../util/env";

export interface TransportCallbacks {
  onOpen: () => void;
  onMessage: (msg: ServerMessage) => void;
  // wasClean separates an intentional close (1000) from a hard drop (1006).
  // The FSM needs this to choose DISCONNECTED vs RECONNECTING + backoff.
  onClose: (wasClean: boolean) => void;
}

export interface Transport {
  connect(): void;
  send(msg: ClientMessage): void;
  close(): void;
}

export function createTransport(
  callbacks: TransportCallbacks,
  url: string = WS_URL,
): Transport {
  // Lives in the closure (not inside connect) so send() and close() can reach it.
  let ws: WebSocket | null = null;

  return {
    connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        callbacks.onOpen();
      };

      ws.onmessage = (event: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          // Malformed JSON — drop it, keep the connection alive.
          return;
        }
        // Validate the shape before trusting it; under chaos we may see junk.
        if (!isServerMessage(parsed)) {
          return;
        }
        callbacks.onMessage(parsed);
      };

      ws.onclose = (event: CloseEvent) => {
        callbacks.onClose(event.wasClean);
      };
    },

    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(msg));
    },

    close() {
      if (!ws) {
        return;
      }
      // Detach handlers before closing so our own teardown doesn't fire onClose
      // and get mistaken for a dropped connection.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      ws = null;
    },
  };
}
