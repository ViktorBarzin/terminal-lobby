/**
 * Background Web Push (inventory Cat.9, high-risk) — the page-side subscription
 * lifecycle layered ON TOP of the foreground notification path. Subscribing lets
 * the server (tmux-api pushsender.go) notify even when no tab is open. Everything
 * here is BEST-EFFORT: if the server has no VAPID key (vapid-public 404s), the
 * browser lacks PushManager, or subscribe() is refused, the app silently stays
 * foreground-only. The shared tag 'tl-<session>' coalesces a background push with
 * any foreground notification so the user is alerted at most once.
 *
 * PATH PREFIX — deliberately `/api/sessions/*` (NOT the lobby-api `/api/*`): these
 * three endpoints are byte-identical to the ones the VERBATIM service worker uses
 * (public/sw.js) and the ones the task specifies, and they match the production
 * ingress (deploy-options: `PathPrefix /api/sessions/` → tmux-api, strip). The
 * page and the SW MUST hit the same endpoint or a page-subscribe and an
 * SW-re-subscribe would write to different (or non-existent) URLs for the same
 * device. See the integration ledger note about the lobby-api prefix.
 */
import { base64urlToUint8Array } from "./vapid";
import { fetchWithDeadline } from "../lib/http";

export const PUSH_SUBS_API = "/api/sessions/push-subscriptions";
export const VAPID_PUBLIC_API = "/api/sessions/push/vapid-public";
export const PUSH_TEST_API = "/api/sessions/push/test";
// Not exported: nothing outside this module talks to it. The three above are,
// because the connection probes and the tests reach for them.
const PUSH_FOCUS_API = "/api/sessions/push/focus";

/** Just the two fields secureOrigin reads, so a test can hand it a page. */
export interface OriginLocation {
  protocol: string;
  origin: string;
}

/**
 * The page origin to record on the subscription, or undefined for "do not send
 * one".
 *
 * The server has no public-origin config: it sees only the ingress-forwarded
 * request, so the browser is the half that knows where the app is served from.
 * It needs the value because a Declarative Web Push message must carry an
 * ABSOLUTE navigate URL (tmux-api/pushsender.go) — WebKit parses navigate with
 * no base, and a relative URL drops the entire message, banner included.
 *
 * https only, and that guard is what keeps the dev harness working: the server
 * validates the origin strictly and 400s a bad one, which would take the whole
 * subscription PUT with it. A page on plain http sends nothing and gets today's
 * flat payload, which is all a dev browser ever needed.
 */
export function secureOrigin(loc: OriginLocation | undefined): string | undefined {
  if (!loc || loc.protocol !== "https:") return undefined;
  return loc.origin;
}

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/**
 * Subscribe this device for background push and upsert the subscription on the
 * server. Idempotent: `getSubscription()` reuses an existing browser
 * subscription, and the server PUT upserts by endpoint — so it is safe to call
 * on every load (the self-heal path). No-op when unsupported or push is dark.
 */
export async function subscribePush(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const resp = await fetchWithDeadline(VAPID_PUBLIC_API);
    if (!resp.ok) return; // 404 → push dark server-side
    const key = (await resp.text()).trim();
    if (!key) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToUint8Array(key),
      });
    }
    // The origin rides along with the subscription rather than in a call of
    // its own: it belongs to this device the way the endpoint and the keys do,
    // and the server preserves it across re-subscribes at the same endpoint.
    const origin = secureOrigin(globalThis.location);
    const body = {
      ...(sub.toJSON ? sub.toJSON() : sub),
      ...(origin ? { origin } : {}),
    };
    await fetchWithDeadline(PUSH_SUBS_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* enhancement only — the foreground path still delivers */
  }
}

/**
 * Unsubscribe this device: drop the browser subscription and DELETE it from the
 * server list. The server also prunes dead endpoints on a 404/410 from the push
 * service, so a failure here is not fatal.
 */
export async function unsubscribePush(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetchWithDeadline(PUSH_SUBS_API, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* best-effort; the server prunes dead endpoints on 404/410 */
  }
}

/**
 * Tell the server which session THIS device has on screen, so the push sender
 * can withhold that one from this device and still tell every other device
 * (tmux-api pushfocus.go). `session` is "" when the app is showing no session.
 *
 * Keyed by this browser's push endpoint, which is also what makes it a no-op on
 * a device the server does not push to: no subscription, nothing to say.
 *
 * Returns whether the server took it, so the caller can retry on the next tick
 * rather than believing a report that never landed. Best-effort like the rest of
 * this module: every failure is a `false`, never a throw.
 */
export async function reportFocus(session: string): Promise<boolean> {
  try {
    if (!pushSupported()) return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const resp = await fetchWithDeadline(PUSH_FOCUS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, session }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export type DeviceSubscriptionState = "yes" | "no" | "unsupported";

/**
 * Self-diagnosis for the settings "Subscribed here" readout: is THIS
 * device/browser actually registered for background push on the server? Compares
 * this browser's live pushManager endpoint against the server's stored list — a
 * subscription the browser silently dropped, or one that never reached the
 * server, both surface as 'no'.
 */
export async function deviceSubscriptionState(): Promise<DeviceSubscriptionState> {
  try {
    if (!pushSupported()) return "unsupported";
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return "no";
    const resp = await fetchWithDeadline(PUSH_SUBS_API);
    if (!resp.ok) return "no";
    const list = (await resp.json()) as unknown;
    return Array.isArray(list) &&
      list.some((s) => (s as { endpoint?: string }).endpoint === sub.endpoint)
      ? "yes"
      : "no";
  } catch {
    return "no";
  }
}

export type PushTestOutcome =
  | { ok: true; sent: number; pruned: number }
  | { ok: false; status?: number };

/**
 * Fan a real "Test notification" out through the server to EVERY registered
 * device (the settings "Test all devices" button). Returns the {sent,pruned}
 * counts on success so the caller can guide the user (sent==0 → nobody
 * subscribed).
 */
export async function testAllDevices(): Promise<PushTestOutcome> {
  try {
    const resp = await fetchWithDeadline(PUSH_TEST_API, {
      method: "POST",
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const body = (await resp.json()) as { sent?: number; pruned?: number };
    return { ok: true, sent: body.sent ?? 0, pruned: body.pruned ?? 0 };
  } catch {
    return { ok: false };
  }
}
