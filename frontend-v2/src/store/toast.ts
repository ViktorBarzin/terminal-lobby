import { createSignal, type Accessor } from "solid-js";
// aliased: this module already has its own slow-operation `track`
import { track as trackEvent } from "../telemetry/track";

/**
 * Toast store + slow-request health coordinator (feature-inventory §7).
 *
 * A typed top-of-stack notification list plus a single self-updating "requests
 * are slow" toast: any tracked request still pending after SLOW_THRESHOLD_MS
 * joins ONE shared sticky warning toast (per-request rows), which closes when
 * the last slow request acks (success OR failure both ack). Built as a factory
 * so tests drive an isolated instance with fake timers; `toasts` is the app-wide
 * singleton used by the shell.
 */

export type ToastKind = "info" | "error" | "warning" | "success" | "loading";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** optional secondary line(s) — used for the slow-request row list. */
  detail?: string;
  /** sticky toasts never auto-dismiss (loading + the slow-request toast). */
  sticky: boolean;
}

export interface PushToast {
  kind: ToastKind;
  message: string;
  detail?: string;
  /** ms before auto-dismiss; 0 or undefined+sticky = never. */
  timeoutMs?: number;
  sticky?: boolean;
}

export const SLOW_THRESHOLD_MS = 15000;
export const MAX_STACK = 6;
export const MAX_TRACKED = 64;
const DEFAULT_TIMEOUT_MS = 3000;
const ERROR_TIMEOUT_MS = 5000;
const SLOW_MESSAGE = "Some requests are slow";

export interface ToastController {
  toasts: Accessor<Toast[]>;
  push(t: PushToast): number;
  dismiss(id: number): void;
  update(id: number, patch: Partial<Omit<Toast, "id">>): void;
  clear(): void;
  /** Register a pending request; returns an ack() to call when it settles. */
  track(key: string): () => void;
  dispose(): void;
}

export interface ToastControllerOptions {
  slowThresholdMs?: number;
}

export function createToastController(
  opts: ToastControllerOptions = {},
): ToastController {
  const slowMs = opts.slowThresholdMs ?? SLOW_THRESHOLD_MS;
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function clearTimer(id: number): void {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function dismiss(id: number): void {
    clearTimer(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }

  function update(id: number, patch: Partial<Omit<Toast, "id">>): void {
    setToasts((list) =>
      list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function push(t: PushToast): number {
    // Errors and warnings the user actually saw. The KIND only — a message can
    // carry a path or a name, and the catalog rule is metadata, not content.
    if (t.kind === "error" || t.kind === "warning") {
      trackEvent("app.error", { "tl.kind": t.kind });
    }
    const id = nextId++;
    const sticky = t.sticky ?? t.kind === "loading";
    const toast: Toast = {
      id,
      kind: t.kind,
      message: t.message,
      detail: t.detail,
      sticky,
    };
    setToasts((list) => {
      let next = [...list, toast];
      // MAX_STACK: drop the oldest AUTO-dismiss toast first (then oldest of all).
      while (next.length > MAX_STACK) {
        const victim =
          next.find((x) => !x.sticky)?.id ?? next[0]?.id;
        if (victim === undefined) break;
        clearTimer(victim);
        next = next.filter((x) => x.id !== victim);
      }
      return next;
    });
    const timeoutMs =
      t.timeoutMs ??
      (sticky ? 0 : t.kind === "error" ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    if (timeoutMs > 0) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), timeoutMs),
      );
    }
    return id;
  }

  function clear(): void {
    for (const id of [...timers.keys()]) clearTimer(id);
    setToasts([]);
  }

  // ---- slow-request coordinator -----------------------------------------
  interface Tracked {
    key: string;
    slow: boolean;
    timer: ReturnType<typeof setTimeout>;
  }
  const tracked = new Map<number, Tracked>();
  let trackId = 1;
  let slowToastId: number | undefined;

  function refreshSlowToast(): void {
    const slowKeys: string[] = [];
    for (const t of tracked.values()) if (t.slow) slowKeys.push(t.key);
    if (slowKeys.length === 0) {
      if (slowToastId !== undefined) {
        dismiss(slowToastId);
        slowToastId = undefined;
      }
      return;
    }
    const detail = slowKeys.join("\n");
    if (slowToastId === undefined) {
      slowToastId = push({
        kind: "warning",
        message: SLOW_MESSAGE,
        detail,
        sticky: true,
      });
    } else {
      update(slowToastId, { detail });
    }
  }

  function track(key: string): () => void {
    if (tracked.size >= MAX_TRACKED) return () => {}; // cap: don't track past 64
    const id = trackId++;
    const timer = setTimeout(() => {
      const t = tracked.get(id);
      if (t) {
        t.slow = true;
        refreshSlowToast();
      }
    }, slowMs);
    tracked.set(id, { key, slow: false, timer });
    let acked = false;
    return () => {
      if (acked) return;
      acked = true;
      const t = tracked.get(id);
      if (t) {
        clearTimeout(t.timer);
        tracked.delete(id);
      }
      refreshSlowToast();
    };
  }

  function dispose(): void {
    for (const id of [...timers.keys()]) clearTimer(id);
    for (const t of tracked.values()) clearTimeout(t.timer);
    tracked.clear();
  }

  return { toasts, push, dismiss, update, clear, track, dispose };
}

/** App-wide singleton (the shell renders this one). Tests use their own. */
export const toasts: ToastController = createToastController();

/** Convenience wrapper mirroring the vanilla showToast(msg, type). */
export function showToast(
  message: string,
  kind: ToastKind = "info",
  timeoutMs?: number,
): number {
  return toasts.push({ kind, message, timeoutMs });
}

/**
 * Monkey-patch window.fetch so every same-origin lobby/session mutation +
 * poll is auto-tracked by the slow coordinator (feature-inventory §7 "global
 * fetch wrapper"). The ORIGINAL promise is returned untouched (rejection
 * semantics intact); the long-lived SSE stream uses EventSource, not fetch, so
 * it is never tracked. Idempotent. Call once at boot (never from tests).
 */
export function installSlowRequestTracking(
  controller: ToastController = toasts,
): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const w = window as Window & { __tlFetchTracked?: boolean };
  if (w.__tlFetchTracked) return;
  w.__tlFetchTracked = true;
  const orig = window.fetch.bind(window);
  const TRACK_RE = /^\/(api|prompt|cancel|permission)(\/|$|\?)/;
  // Telemetry is fire-and-forget: the user never asked for it, cannot act on
  // it, and telemetry/track.ts swallows its failures by design ("telemetry is
  // never worth surfacing"). Tracking it here contradicted that — a stalled
  // beacon raised a sticky "Some requests are slow" warning listing
  // POST /api/sessions/telemetry, over a session that was working fine.
  const NEVER_TRACK_RE = /\/telemetry$/;
  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let path = "";
    let method = "GET";
    try {
      const url = typeof input === "string" ? input : input.toString();
      // same-origin relative paths only (mutations + polls); ignore absolute.
      path = url.startsWith("/") ? (url.split("?")[0] ?? "") : "";
      method = (init?.method ?? "GET").toUpperCase();
    } catch {
      /* opaque input — skip tracking */
    }
    const promise = orig(input as RequestInfo, init);
    if (path && TRACK_RE.test(path) && !NEVER_TRACK_RE.test(path)) {
      const ack = controller.track(`${method} ${path}`);
      promise.then(ack, ack);
    }
    return promise;
  };
}
