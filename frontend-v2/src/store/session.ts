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

/** Toast severity forwarded to the app (subset of the toast ToastKind). */
export type NotifyKind = "info" | "error" | "warning" | "success";

export interface SessionStoreOptions {
  /** surface a control-channel error to the app's toast stack. Omitted in
   *  tests; when present, failures ALSO toast but still never throw (the read
   *  path stays intact). */
  notify?: (message: string, kind: NotifyKind) => void;
}

/**
 * Wires the resumable SSE client into a Solid store. Events arrive already
 * ordered + deduped by the client (server replays from the Last-Event-ID
 * cursor), so we simply append. Control writes POST to session-events'
 * /prompt/<session> (body {text}) and /cancel/<session>; failures never break
 * the read path (the transcript still tails), but they surface as an error
 * toast via `notify` so a dropped prompt/cancel/permission isn't silent.
 */
export function createSessionStore(
  session: string,
  opts: SessionStoreOptions = {},
): SessionStore {
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
      if (!res.ok) {
        opts.notify?.(`Couldn't resolve permission (HTTP ${res.status})`, "error");
      }
      return res.ok; // 204 No Content on success
    } catch {
      opts.notify?.("Couldn't resolve permission", "error");
      return false;
    }
  };

  const send = async (text: string): Promise<void> => {
    try {
      const res = await fetch(promptUrl(session), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // 409 = a turn is already running (config.promptUrl contract).
        opts.notify?.(
          res.status === 409
            ? "A turn is already running"
            : `Couldn't send prompt (HTTP ${res.status})`,
          "error",
        );
      }
    } catch {
      /* the prompt still shows once the transcript tails */
      opts.notify?.("Couldn't reach the session", "error");
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      const res = await fetch(cancelUrl(session), {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) opts.notify?.(`Couldn't interrupt (HTTP ${res.status})`, "error");
    } catch {
      /* best-effort cancel */
      opts.notify?.("Couldn't interrupt the session", "error");
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
