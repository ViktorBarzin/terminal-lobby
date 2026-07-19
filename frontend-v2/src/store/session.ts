import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { SseClient, type SseStatus } from "../sse/client";
import { cancelUrl, eventsUrl, permissionUrl, promptUrl } from "../lib/config";
import type { Event, PermissionDecision } from "../types/events";

export interface SessionStore {
  /** Reactive, ordered, deduped event list (Solid store proxy). */
  events: Event[];
  /** SSE connection status. */
  status: Accessor<SseStatus>;
  /** Resolve a permission request. Returns true on the backend's 204. */
  resolvePermission: (
    reqId: string,
    decision: PermissionDecision,
  ) => Promise<boolean>;
  /** Send a prompt (provisional control endpoint — see blockers). */
  send: (text: string) => Promise<void>;
  /** Interrupt the running turn (provisional control endpoint). */
  interrupt: () => Promise<void>;
  close: () => void;
}

/**
 * Wires the resumable SSE client into a Solid store. Events arrive already
 * ordered + deduped by the client (server replays from the Last-Event-ID
 * cursor), so we simply append. Control writes POST to session-events'
 * /prompt/<session> (body {text}) and /cancel/<session>; failures are swallowed
 * so an unwired control channel never breaks the read path. The prompt/result
 * still surface once the transcript tails.
 */
export function createSessionStore(session: string): SessionStore {
  const [events, setEvents] = createStore<Event[]>([]);
  const [status, setStatus] = createSignal<SseStatus>("connecting");

  const client = new SseClient({
    session,
    url: eventsUrl,
    onEvent: (e: Event) => setEvents(events.length, e),
    onStatus: setStatus,
  });
  client.start();
  onCleanup(() => client.close());

  const resolvePermission = async (
    reqId: string,
    decision: PermissionDecision,
  ): Promise<boolean> => {
    try {
      const res = await fetch(permissionUrl(reqId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      return res.ok; // 204 No Content on success
    } catch {
      return false;
    }
  };

  const send = async (text: string): Promise<void> => {
    try {
      await fetch(promptUrl(session), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      /* the prompt still shows once the transcript tails */
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await fetch(cancelUrl(session), {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      /* best-effort cancel */
    }
  };

  return {
    events,
    status,
    resolvePermission,
    send,
    interrupt,
    close: () => client.close(),
  };
}
