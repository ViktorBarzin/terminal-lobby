/**
 * Client diagnostics for the v2 SPA (docs/adr/0008-client-diagnostics.md).
 *
 * The measurement core is frontend/diag.js, inlined into the page head at
 * deploy and shared verbatim with index.html and term.html. This module is
 * only the typed seam: it decides whether diagnostics are on, hands bind() the
 * surface's identity, and exposes the handle for the few call sites that
 * report something the platform wrappers cannot see.
 *
 * Keeping the state machine out of here is deliberate. A TypeScript port would
 * be a second implementation of the quiet gate, the percentile accumulation
 * and the flight recorder, and the two would drift — term.html already carries
 * calls to a function it never defined, which is what that drift costs.
 */

import { BUILD_ID } from "../lib/config";
import { commitWindow, type WindowBytes } from "../diagnostics/usage";

/** The subset of the core's surface this app calls directly. */
export interface Diagnostics {
  ids(): { tab: string; device: string };
  ring(event: Record<string, string | number | boolean | null>): void;
  incident(kind: string, attrs?: Record<string, unknown>): void;
  onRender(ms: number): void;
  onException(err: unknown, kind: string): void;
  flush(): void;
}

interface TlDiagGlobal {
  bind(opts: Record<string, unknown>): Diagnostics;
}

/** Per-browser opt-out, matching the vanilla surfaces' plain-key posture. */
const KILL_KEY = "tl-diagnostics";

export function diagnosticsWanted(): boolean {
  try {
    if (new URLSearchParams(location.search).get("diag") === "0") return false;
    return localStorage.getItem(KILL_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDiagnosticsEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KILL_KEY);
    else localStorage.setItem(KILL_KEY, "off");
  } catch {
    /* a browser that refuses storage keeps the default */
  }
}

/** A handle that does nothing, for when the core is absent (dev server, a
 *  build where the placeholder was not substituted). Diagnostics going quiet
 *  is always preferable to the app not starting. */
const inert: Diagnostics = {
  ids: () => ({ tab: "", device: "" }),
  ring: () => {},
  incident: () => {},
  onRender: () => {},
  onException: () => {},
  flush: () => {},
};

let handle: Diagnostics = inert;

export function startDiagnostics(): Diagnostics {
  try {
    const core = (globalThis as unknown as { tlDiag?: TlDiagGlobal }).tlDiag;
    if (!core) return inert;
    handle = core.bind({
      url: "/api/sessions/telemetry",
      client: "lobby-v2",
      role: "lobby",
      build: BUILD_ID,
      // Counting is not consent to send. The toggle governs the intake; the
      // device counter keeps running either way, because "is this app eating
      // my allowance" is the question someone who just opted out is most
      // likely to want answered.
      enabled: diagnosticsWanted(),
      onWindow: (w: WindowBytes) => void commitWindow(w),
    });
  } catch {
    handle = inert;
  }
  return handle;
}

/** The app-wide handle. A module singleton for the same reason the usage
 *  tracker is one: call sites are spread across stores and components, and
 *  diagnostics are not part of any component's contract. */
export const diag = (): Diagnostics => handle;
