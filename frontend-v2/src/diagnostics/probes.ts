/**
 * The five probes Run check actually runs.
 *
 * EVERY ONE OF THEM READS. None opens, closes, reconnects or repairs anything,
 * so the broken state a person came to look at is still there after they press
 * the button — and a check cannot become the thing that fixed the bug it was
 * measuring.
 *
 * Two of them ask the server, both read-only:
 *  - `/health`, which separates "the API is down" from "this tab's poll is
 *    stuck", and is the only way to tell those apart from inside the browser.
 *  - `GET /push-subscriptions`, which answers the question no local flag can:
 *    the browser still holds a subscription, everything reads healthy, and the
 *    server dropped the endpoint after a 410 so nothing has been delivered
 *    since. Notifications deliberately SEND nothing — /push/test fans out to
 *    every device a person owns, and a diagnostic that buzzes the phone in
 *    someone's pocket is one they stop running.
 */

import { API_BASE } from "../lib/config";
import { PUSH_SUBS_API, deviceSubscriptionState } from "../pwa/push";
import type { CheckProbe } from "./check";
import {
  notificationsChannel,
  sessionsChannel,
  terminalChannel,
  transcriptChannel,
  type Channel,
  type SseStatus,
  type TerminalReport,
} from "./status";

export interface ProbeDeps {
  /** Ask the terminal frame to re-report; resolves with what it says, or null
   *  if it does not answer in time. */
  askTerminal(signal: AbortSignal): Promise<TerminalReport | null>;
  /** The transcript stream's status as the session view currently sees it. */
  transcriptStatus(): SseStatus | null;
  /** How the lobby poll is doing, from the lobby store. */
  sessionsReport(): Parameters<typeof sessionsChannel>[0];
  /** Whether an update is waiting (the deploy healer deferred a reload). */
  updateReady(): boolean;
  fetch?: typeof fetch;
}

/** Read-only liveness of the API this tab talks to. */
async function apiReachable(f: typeof fetch, signal: AbortSignal): Promise<boolean> {
  const res = await f(`${API_BASE}/health`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  return res.ok;
}

/** Does the SERVER still hold this device's push endpoint? */
async function serverHoldsThisDevice(
  f: typeof fetch,
  signal: AbortSignal,
): Promise<"holds" | "missing" | "unknown"> {
  let endpoint: string | null = null;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    endpoint = sub?.endpoint ?? null;
  } catch {
    return "unknown"; // no service worker, or storage refused — not an answer
  }
  if (!endpoint) return "unknown"; // nothing to look for; the device row says so
  const res = await f(PUSH_SUBS_API, { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) return "unknown";
  const body: unknown = await res.json();
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { subscriptions?: unknown })?.subscriptions)
      ? (body as { subscriptions: unknown[] }).subscriptions
      : null;
  if (!rows) return "unknown";
  const held = rows.some(
    (r) => typeof r === "object" && r !== null && (r as { endpoint?: unknown }).endpoint === endpoint,
  );
  return held ? "holds" : "missing";
}

function permission(): NotificationPermission | "unsupported" {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

export function buildProbes(deps: ProbeDeps): CheckProbe[] {
  const f = deps.fetch ?? fetch.bind(globalThis);
  return [
    {
      id: "terminal",
      // Silence here means the frame is not reporting — a booting iframe, a
      // cached older build, no terminal on screen at all. None of those is a
      // dead socket, and calling them one would be the panel's first lie.
      timeoutState: "unknown",
      timeoutDetail: "not reporting",
      run: async (signal) => terminalChannel(await deps.askTerminal(signal)),
    },
    {
      id: "transcript",
      run: async () => transcriptChannel(deps.transcriptStatus()),
    },
    {
      id: "sessions",
      run: async (signal): Promise<Channel> => {
        const live = sessionsChannel(deps.sessionsReport());
        // The poll's own history says whether THIS TAB is getting answers;
        // /health says whether anyone is. A failing poll against a healthy API
        // is a different problem from an API that is down, and the row should
        // not report both as the same thing.
        const up = await apiReachable(f, signal);
        if (up && live.state === "down") {
          return { ...live, detail: `${live.detail}, but the API is answering` };
        }
        if (!up) return { id: "sessions", state: "down", detail: "the API is not answering" };
        return live;
      },
    },
    {
      id: "notifications",
      run: async (signal): Promise<Channel> =>
        notificationsChannel({
          permission: permission(),
          device: await deviceSubscriptionState(),
          server: await serverHoldsThisDevice(f, signal),
        }),
    },
    {
      id: "build",
      run: async (): Promise<Channel> => {
        const ready = deps.updateReady();
        return ready
          ? { id: "build", state: "degraded", detail: "update ready" }
          : { id: "build", state: "working", detail: "up to date" };
      },
    },
  ];
}
