/**
 * Settings → T3 apps, the pure half (ADR-0045; components/settings/pages/
 * T3AppsPage.tsx is the DOM around it).
 *
 * A person pairs one of T3's apps by pressing "Pair a device": tmux-api mints a
 * short code (POST /devices/pair, five minutes, single use), and the page shows
 * it three ways: a link to T3's own `/pair` route with the code in the
 * fragment, a QR code of that link, and the code itself for typing. The app
 * hands the code to tl-t3-view, which exchanges it for the app's own token.
 *
 * Nothing tells the lobby when that happens, so while a code is showing the
 * page polls GET /devices. A device that was not listed when the code was
 * minted is the one that used it: the card drops the code and names it.
 */

// ---- the pairing card's states ---------------------------------------------

export type PairState =
  | { kind: "idle" }
  | { kind: "requesting" }
  /**
   * `expiresAt` is a unix second, as tmux-api sends it. `known` holds the ids
   * of the devices paired before this code was minted.
   */
  | { kind: "showing"; code: string; expiresAt: number; known: readonly string[] }
  | { kind: "expired" }
  /** The code was used; `label` is the new device's own, possibly empty. */
  | { kind: "paired"; label: string }
  | { kind: "error"; message: string };

/** A paired device, as far as noticing a new one needs. */
interface ListedDevice {
  id: string;
  label: string;
}

export type PairEvent =
  | { type: "request" }
  | { type: "granted"; code: string; expiresAt: number; known: readonly string[] }
  | { type: "failed"; message: string }
  | { type: "tick"; nowMs: number }
  /** A fresh GET /devices, newest first. */
  | { type: "devices"; devices: readonly ListedDevice[] };

/** How often the page asks for the device list while a code is showing. */
export const PAIR_POLL_MS = 3000;

/**
 * One step of the card. A press while a request is in flight is ignored, so a
 * double click does not spend two of the five codes tmux-api lets one person
 * hold. An answer that arrives when nothing was asked is dropped.
 */
export function pairStep(state: PairState, event: PairEvent): PairState {
  switch (event.type) {
    case "request":
      return state.kind === "requesting" ? state : { kind: "requesting" };
    case "granted":
      return state.kind === "requesting"
        ? { kind: "showing", code: event.code, expiresAt: event.expiresAt, known: event.known }
        : state;
    case "failed":
      return state.kind === "requesting" ? { kind: "error", message: event.message } : state;
    case "tick":
      return state.kind === "showing" && secondsLeft(state.expiresAt, event.nowMs) <= 0
        ? { kind: "expired" }
        : state;
    case "devices": {
      if (state.kind !== "showing") return state;
      const fresh = event.devices.find((d) => !state.known.includes(d.id));
      return fresh ? { kind: "paired", label: fresh.label } : state;
    }
  }
}

/** Whether the page should be polling the device list: only while a code shows. */
export function pollsDevices(state: PairState): boolean {
  return state.kind === "showing";
}

/** "Paired: Pixel 9", or a generic name for an app that gave no label. */
export function pairedNote(label: string): string {
  return `Paired: ${label || "T3 app"}`;
}

/** Whole seconds until `expiresAt` (unix s), rounded up, never below zero. */
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil(expiresAt - nowMs / 1000));
}

/** "4:59". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- what a person reads or scans ------------------------------------------

/**
 * The pairing link: T3's own `/pair` route on the app origin, with the code in
 * the fragment, which a browser never sends to a server. T3's clients accept
 * this link pasted into Settings → Connections → Add environment.
 */
export function pairLink(origin: string, code: string): string {
  return `${origin}/pair#token=${encodeURIComponent(code)}`;
}

/** "ABCD EFGH JKLM": groups of four, which tmux-api forgives when typed. */
export function groupCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join(" ");
}

// ---- a paired device's row ---------------------------------------------------

/** "mobile · android", from what the app said about itself; either may be empty. */
export function deviceKind(d: { deviceType: string; os: string }): string {
  return [d.deviceType, d.os].filter((part) => part !== "").join(" · ");
}

/** "last used 3 Oct 2026", or "not used yet" for a device unused since pairing. */
export function lastUsedLabel(
  lastSeen: number,
  formatDate: (unixSeconds: number) => string,
): string {
  return lastSeen > 0 ? `last used ${formatDate(lastSeen)}` : "not used yet";
}

// ---- the QR code -------------------------------------------------------------

/** What `lean-qr`'s generate returns, as far as drawing it needs. */
export interface QrBitmap {
  readonly size: number;
  get(x: number, y: number): boolean;
}

/**
 * One SVG path drawing every dark module as a unit square, shifted by the
 * quiet zone `pad`, for a viewBox of `size + 2 * pad`.
 */
export function qrPath(bitmap: QrBitmap, pad: number): string {
  let d = "";
  for (let y = 0; y < bitmap.size; y++) {
    for (let x = 0; x < bitmap.size; x++) {
      if (bitmap.get(x, y)) d += `M${x + pad} ${y + pad}h1v1h-1z`;
    }
  }
  return d;
}
