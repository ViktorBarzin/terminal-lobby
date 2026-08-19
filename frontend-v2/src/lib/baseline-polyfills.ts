/**
 * The APIs the oldest engine we serve does not have.
 *
 * That engine is Safari 15.6, as shipped in iPadOS 15.8 — emo's iPad, which
 * cannot be upgraded past it, and which every browser on that OS uses whatever
 * its name says. vite's build.target handles SYNTAX for that baseline; it does
 * nothing about METHODS that simply are not there, and a missing method is not
 * a quiet degradation. `AbortSignal.timeout` is read on the way into every
 * lobby request, so its absence threw a TypeError before fetch was ever called:
 * no request left the device, none appeared in the ingress log, and the sidebar
 * showed "Failed to load" with an empty session list. Nothing to open, so no
 * terminal.
 *
 * Polyfilled rather than avoided at the call sites, because the call sites are
 * not all ours: `URL.canParse` is reached inside the URL sanitizer that mermaid
 * bundles, where there is nothing of ours to edit. Filling the gap once, before
 * any app code runs, covers our code and our dependencies with one rule.
 *
 * The list is deliberately short. Everything else the bundle touches —
 * structuredClone, Object.hasOwn, crypto.randomUUID, WeakRef, Intl.Segmenter,
 * replaceChildren, queueMicrotask, ResizeObserver — landed in Safari 15.4 or
 * earlier, and requestIdleCallback is already feature-detected where it is
 * used. scripts/test_frontend_compat.py fails the build if a post-baseline API
 * turns up here without a polyfill.
 */

/** What `AbortSignal.timeout(ms)` returns, built from parts Safari 15 has. */
export function makeTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(
    // The NAME matters, not just the abort: lobby-api forwards this reason when
    // it merges the deadline with a caller's signal, and a timeout is told
    // apart from a cancel by reading it. A bare abort() would say AbortError.
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    ms,
  );
  return controller.signal;
}

/** What `URL.canParse(url, base)` answers, without the Safari 17 method. */
export function canParseURL(url: string, base?: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(url, base);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install whatever this engine is missing. Returns the names it filled in, so
 * the stamp below can say what happened on a device we cannot open a console on.
 * Idempotent, and it never replaces a real implementation.
 */
export function installBaselinePolyfills(): string[] {
  const installed: string[] = [];

  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout !== "function") {
    AS.timeout = makeTimeoutSignal;
    installed.push("AbortSignal.timeout");
  }

  const U = URL as unknown as { canParse?: (url: string, base?: string) => boolean };
  if (typeof URL !== "undefined" && typeof U.canParse !== "function") {
    U.canParse = canParseURL;
    installed.push("URL.canParse");
  }

  // Same idea as the build-id stamp: on a tablet with no developer tools, the
  // DOM is the only place a question like "did the polyfills run?" can be
  // answered. Also the literal the compat guard greps the built bundle for.
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.tlPolyfills = installed.join(",") || "none";
  }
  return installed;
}

// Self-installing on import, which is the only way "before anything else" is
// true: `import` declarations are hoisted, so a call placed among them would
// still run after every imported module's body. index.tsx imports this first
// and does not call anything. Nothing in the bundle reaches these methods
// during module init today, but the ordering should not depend on that staying
// so. The dataset write above also keeps the module from being tree-shaken.
installBaselinePolyfills();
