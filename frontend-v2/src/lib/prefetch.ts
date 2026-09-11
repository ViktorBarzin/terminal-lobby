/**
 * Warm the xterm chunk while the tab is idle, so the first terminal open of a
 * page load does not pay for it.
 *
 * WHAT IT COSTS TODAY. `TerminalNative` imports `@xterm/xterm` and
 * `@xterm/addon-fit` lazily, and nothing hints at them: `dist/assets/xterm-*.js`
 * is 329,698 B raw and 82,870 B gzipped, and `index.html` carries zero
 * `modulepreload` links. Measured 2026-09-11 (ADR-0026), the first open of a
 * page load costs 1,620 ms with the chunk coming from the network against
 * 779 ms once it is in the module cache, so this is worth 413 to 841 ms — once
 * per page load.
 *
 * WHY NOT A `modulepreload` LINK. A link in the head is a blocking fetch at
 * high priority. On the 400 kbps connection this app is built for, 82 KB is
 * 1.7 s, and it would sit in front of the session list — the screen you
 * actually need first. So the chunk is fetched AFTER first paint, at idle
 * priority, where it competes with nothing.
 *
 * WHY `import()` RATHER THAN `<link rel=prefetch>`. A prefetch link fills the
 * HTTP cache, and the terminal would still have to parse and instantiate the
 * module when it opens. The same dynamic import the terminal makes fills the
 * ES module cache, so the later `import()` in `TerminalNative` resolves from
 * memory. It also keeps this honest: if the specifiers ever diverge, the two
 * are the same two strings and a grep finds both.
 */
import { isCoarsePointer } from "../mobile/pointer";

/**
 * How long the idle callback may be deferred before the browser runs it
 * anyway. Long enough not to preempt a busy boot, short enough that the chunk
 * is there before anyone has read the session list and picked a row.
 */
export const PREFETCH_IDLE_TIMEOUT_MS = 3_000;
/** The same job where `requestIdleCallback` does not exist (Safari before
 *  18.4, which is inside this app's support baseline). */
export const PREFETCH_FALLBACK_MS = 1_500;

/** `requestIdleCallback`, as much of it as this module uses. Exported because
 *  the schedule is the part worth testing, and a test supplies its own. */
export type IdleRequest = (cb: () => void, opts: { timeout: number }) => number;

export interface ChunkPrefetchDeps {
  /** What to pull. Defaults to the two specifiers `TerminalNative` imports. */
  readonly load?: () => Promise<unknown>;
  /** Whether this is a touch device. Defaults to the `(pointer: coarse)` read
   *  every other mobile-only decision in this app is gated on. */
  readonly coarsePointer?: () => boolean;
  /** The browser's idle scheduler, or `undefined` to force the timer path.
   *  Defaults to `requestIdleCallback` where the browser has one. */
  readonly idle?: IdleRequest | undefined;
  /** The fallback timer. Defaults to `setTimeout`. */
  readonly delay?: (cb: () => void, ms: number) => void;
}

/** The two imports `TerminalNative` makes, so this warms the module cache it
 *  will read rather than a second copy of the same bytes. */
function loadTerminalChunk(): Promise<unknown> {
  return Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
}

/** `requestIdleCallback` where the browser has one — the same feature test
 *  `session.ts` and `MessagesTimeline.tsx` make, and SSR-safe like both. */
function browserIdle(): IdleRequest | undefined {
  const g = globalThis as { requestIdleCallback?: IdleRequest };
  return typeof g.requestIdleCallback === "function" ? g.requestIdleCallback : undefined;
}

export interface ChunkPrefetch {
  /**
   * Schedule the fetch. True if this call scheduled it; false if it declined —
   * a touch device, or a tab that has already asked.
   */
  start(): boolean;
}

/**
 * A prefetch with its scheduling injected, which is the only part worth
 * testing: a test can say when idle arrives, and never touch the network.
 */
export function createChunkPrefetch(deps: ChunkPrefetchDeps = {}): ChunkPrefetch {
  const load = deps.load ?? loadTerminalChunk;
  const coarsePointer = deps.coarsePointer ?? isCoarsePointer;
  // `in` rather than `??`: a test passes `idle: undefined` to mean "this
  // browser has none", and that has to be different from not saying.
  const idle = "idle" in deps ? deps.idle : browserIdle();
  const delay = deps.delay ?? ((cb: () => void, ms: number): void => void setTimeout(cb, ms));
  let scheduled = false;

  return {
    start(): boolean {
      // Hover does not exist on a coarse pointer, so a phone opens a terminal
      // deliberately or not at all — and 82 KB of a chunk it may never open is
      // the wrong thing to spend a mobile connection on.
      if (scheduled || coarsePointer()) return false;
      scheduled = true;
      const run = (): void => {
        // An optimisation is never allowed to be a dependency. A chunk that
        // 404s across a deploy costs the head start and nothing else.
        void load().catch(() => {});
      };
      if (idle) idle(run, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
      else delay(run, PREFETCH_FALLBACK_MS);
      return true;
    },
  };
}

/** The tab's one prefetch, for the entry to call once at boot. Repeating the
 *  call is harmless — a second `import()` resolves from the module cache — but
 *  it schedules nothing new. */
let tabPrefetch: ChunkPrefetch | null = null;

export function prefetchTerminalChunk(): boolean {
  if (!tabPrefetch) tabPrefetch = createChunkPrefetch();
  return tabPrefetch.start();
}
