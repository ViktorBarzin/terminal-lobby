/**
 * Deploy self-heal — the CONTROLLER (inventory Cat.10). Wires the pure logic in
 * ./healer.logic.ts to real fetch / reload / storage / timers / listeners and a
 * reactive `updateReady` signal the shell renders as the sticky "Update ready"
 * pill.
 *
 * The lobby (this SPA, the TOP document) is the ONLY deploy channel — there is
 * no server build header, so it polls its own served bytes on a short timer,
 * re-hashes, and on a real change routes to `requestTopReload`. TOP-owned reload:
 * the embedded terminal iframe (the ttyd page) never reloads itself — on its own
 * reconnect heal it posts `{type:'tl-build-stale'}` UP, TerminalView forwards it
 * to `onBuildStale`, and the lobby drives the SINGLE reload (which replaces the
 * iframe too). The SPA is never itself embedded, so there is no iframe branch
 * here — `reloadIfStale` always routes to `requestTopReload`.
 *
 * Every side-effecting dependency is injectable so the whole controller is
 * unit-testable with fake timers and a stubbed fetch.
 */
import { createSignal, type Accessor } from "solid-js";
import { BUILD_ID } from "../lib/config";
import {
  BUILD_SUBSTRING,
  STORM_WINDOW_MS,
  fetchSelf,
  hashPage,
  planReload,
  stormOK,
} from "./healer.logic";

/** sessionStorage key for the last AUTO-reload timestamp (the storm throttle). */
export const STORM_KEY = "tl-stale-reload";
/** Lobby self-check cadence. Short (the only deploy channel); the 304 keeps it
 *  cheap under `no-cache` against ttyd's strong ETag. */
export const SELF_CHECK_MS = 5000;

type MinStorage = Pick<Storage, "getItem" | "setItem">;
type MinTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface DeployHealerDeps {
  /** Is a terminal attached (a session selected → SessionView/iframe mounted)?
   *  The v2 analog of the vanilla `currentActive`. */
  hasAttachedTerminal: () => boolean;
  /** default: `() => document.hidden`. */
  isHidden?: () => boolean;
  /** default: bound `window.fetch`. */
  fetchImpl?: typeof fetch;
  /** the URL to self-fetch; default `location.pathname + location.search`. */
  selfUrl?: () => string;
  /** default: `() => location.reload()`. */
  reload?: () => void;
  /** default: `Date.now`. */
  now?: () => number;
  /** default: `sessionStorage` (or null when unavailable). */
  storage?: MinStorage | null;
  /** default: `window` — for the `pageshow` (bfcache) hook. */
  win?: MinTarget | null;
  /** default: `document` — for the `visibilitychange` hook. */
  doc?: MinTarget | null;
  /** default: {@link SELF_CHECK_MS}. */
  intervalMs?: number;
  /** default: {@link STORM_WINDOW_MS}. */
  stormWindowMs?: number;
  /** default: `no-cache` (lobby: revalidate against ttyd's strong ETag → 304). */
  cacheMode?: RequestCache;
  /** arm the baseline + start the poll/listeners immediately (default true). */
  autostart?: boolean;
  /** default: `console.log`. */
  log?: (...args: unknown[]) => void;
}

export interface DeployHealer {
  /** reactive: is the sticky "Update ready — tap to refresh" pill up? */
  updateReady: Accessor<boolean>;
  /** the pill tap — an EXPLICIT action, so NEVER storm-gated. */
  applyUpdate(): void;
  /** the tl-build-stale bridge destination (a terminal saw a new build). */
  onBuildStale(): void;
  /** run one lobby self-check now (skipped while hidden). */
  checkNow(): Promise<void>;
  /** (re)arm the content-hash baseline from the current served bytes. */
  armBaseline(): Promise<void>;
  dispose(): void;
}

function safeSessionStorage(): MinStorage | null {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    /* access denied (sandboxed) */
  }
  return null;
}

/**
 * The build-id marker: log `terminal-lobby build: <id>` and stamp
 * `documentElement.dataset.tlBuild`. Logging `BUILD_SUBSTRING` is what plants the
 * marker literal in the served single-file HTML — `fetchSelf` validates that
 * exact substring, and a per-deploy git SHA in `<id>` is what flips the content
 * hash so the healer fires. Call once at boot.
 */
export function logBuildId(
  id: string = BUILD_ID,
  log: (...args: unknown[]) => void = console.log,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  log(BUILD_SUBSTRING, id);
  try {
    if (doc) doc.documentElement.dataset.tlBuild = id;
  } catch {
    /* no dataset */
  }
}

export function createDeployHealer(deps: DeployHealerDeps): DeployHealer {
  const isHidden =
    deps.isHidden ?? (() => (typeof document !== "undefined" ? document.hidden : false));
  const fetchImpl =
    deps.fetchImpl ??
    (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  const selfUrl =
    deps.selfUrl ??
    (() =>
      typeof location !== "undefined" ? location.pathname + location.search : "/");
  const reload =
    deps.reload ??
    (() => {
      if (typeof location !== "undefined") location.reload();
    });
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage;
  const win = deps.win === undefined ? (typeof window !== "undefined" ? window : null) : deps.win;
  const doc = deps.doc === undefined ? (typeof document !== "undefined" ? document : null) : deps.doc;
  const intervalMs = deps.intervalMs ?? SELF_CHECK_MS;
  const stormWindowMs = deps.stormWindowMs ?? STORM_WINDOW_MS;
  const cacheMode: RequestCache = deps.cacheMode ?? "no-cache";
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));

  const [updateReady, setUpdateReady] = createSignal(false);
  let bootHash: string | null = null;
  let updatePending = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function lastReloadAt(): number | null {
    if (!storage) return null;
    try {
      const v = storage.getItem(STORM_KEY);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  }
  function recordReload(t: number): void {
    if (!storage) return;
    try {
      storage.setItem(STORM_KEY, String(t));
    } catch {
      /* no storage */
    }
  }

  function doAutoReload(why: string): void {
    recordReload(now());
    log("deploy detected (" + why + ") — reloading");
    reload();
  }

  /** The top-owned reload policy (see planReload). */
  function requestTopReload(why: string): void {
    const plan = planReload({
      attached: deps.hasAttachedTerminal(),
      hidden: isHidden(),
      updatePending,
      now: now(),
      lastReloadAt: lastReloadAt(),
      stormWindowMs,
    });
    if (plan === "reload") {
      doAutoReload(why);
    } else if (plan === "show-pill") {
      updatePending = true;
      setUpdateReady(true);
    }
    // "throttled" (storm-gated) / "pill-pending" (already up) → no-op.
  }

  async function armBaseline(): Promise<void> {
    if (!fetchImpl) return;
    try {
      const t = await fetchSelf(fetchImpl, selfUrl(), cacheMode);
      if (t) bootHash = hashPage(t);
      else log("stale-tab healer: baseline fetch failed — will retry on next check");
    } catch {
      /* offline / transient — a failed baseline re-arms on the next check */
    }
  }

  async function reloadIfStale(): Promise<void> {
    if (!fetchImpl) return;
    // A failed boot baseline must not disarm the healer forever: re-arm now,
    // compare on the NEXT check.
    if (bootHash === null) {
      await armBaseline();
      return;
    }
    try {
      const t = await fetchSelf(fetchImpl, selfUrl(), cacheMode);
      if (!t || hashPage(t) === bootHash) return;
      // A new build is being served — the lobby (this top document) owns the
      // single reload, which replaces the terminal iframe too.
      requestTopReload("self-heal");
    } catch {
      /* transient fetch error — try again on the next check */
    }
  }

  async function checkNow(): Promise<void> {
    if (isHidden()) return;
    await reloadIfStale();
  }

  function onBuildStale(): void {
    // A terminal iframe saw a new build on its reconnect heal and handed the
    // reload UP. The top owns the single reload.
    requestTopReload("terminal signal");
  }

  function applyUpdate(): void {
    // The pill tap is an EXPLICIT user action — never storm-gate it (that guard
    // exists only to break AUTO-reload loops; gating the tap would leave the
    // pill stuck when two deploys land <2 min apart).
    updatePending = false;
    setUpdateReady(false);
    reload();
  }

  const onVisibility = (): void => {
    if (isHidden()) {
      // A deferred update fires the moment the tab hides — nothing left to
      // interrupt (storm-gated, like any auto reload).
      if (updatePending && stormOK(now(), lastReloadAt(), stormWindowMs)) {
        updatePending = false;
        setUpdateReady(false);
        doAutoReload("deferred-on-hide");
      }
      return;
    }
    // Resume: re-check immediately (iOS suspends background timers hard).
    void checkNow();
  };
  const onPageShow = (e: Event): void => {
    // bfcache restore: the page comes back frozen, not reloaded — a whole deploy
    // may have landed while it slept.
    if ((e as PageTransitionEvent).persisted) void checkNow();
  };

  function start(): void {
    void armBaseline();
    timer = setInterval(() => void checkNow(), intervalMs);
    doc?.addEventListener("visibilitychange", onVisibility);
    win?.addEventListener("pageshow", onPageShow);
  }

  function dispose(): void {
    if (timer !== undefined) clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pageshow", onPageShow);
  }

  if (deps.autostart !== false) start();

  return { updateReady, applyUpdate, onBuildStale, checkNow, armBaseline, dispose };
}
