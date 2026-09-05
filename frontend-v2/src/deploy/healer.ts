/**
 * Deploy self-update — the CONTROLLER (inventory Cat.10). Wires the pure logic
 * in ./healer.logic.ts to real fetch / reload / storage / timers / listeners.
 *
 * The lobby (this SPA, the TOP document) is the ONLY deploy channel — there is
 * no server build header, so it polls its own served bytes on a short timer and
 * compares the served `TL_ASSET` against its own. ONE document, ONE stamp: the
 * terminal used to be a page of its own, with its own identity that could go
 * stale on its own, so it checked itself on every reconnect and handed the
 * verdict UP as `{type:'tl-build-stale'}`. It is drawn in this document now, so
 * this poll is the whole of the update check and there is no second opinion to
 * collect.
 *
 * ZERO-TOUCH (ADR-0007, Viktor 2026-08-04): there is no "Update ready" pill and
 * no tap. An update applies itself at a boundary that happens anyway — the next
 * open (back after >= RESUME_AWAY_MS away, a window refocus, a bfcache restore)
 * or any moment with no terminal attached. While someone is looking at an
 * attached terminal it waits, silently and indefinitely. A hidden document is
 * NEVER navigated: a backgrounded reload cannot be confirmed, and it would spend
 * a full download plus a tmux reattach on a page nobody is looking at.
 *
 * Every reload is CONFIRMED rather than fire-and-forget: the target id is
 * recorded before navigating and checked at the next boot, so a reload that
 * never lands is counted, reported once, and then dropped instead of retried
 * forever.
 *
 * Every side-effecting dependency is injectable so the whole controller is
 * unit-testable with fake timers and a stubbed fetch.
 */
import { BUILD_ID } from "../lib/config";
import {
  BUILD_SUBSTRING,
  MAX_UPDATE_ATTEMPTS,
  RESUME_AWAY_MS,
  STORM_WINDOW_MS,
  fetchSelf,
  fetchStamp,
  parseAssetId,
  planUpdate,
} from "./healer.logic";
import { track, type TlAttrs } from "../telemetry/track";

/** sessionStorage key for the last AUTO-reload timestamp (the storm throttle). */
export const STORM_KEY = "tl-stale-reload";
/** sessionStorage key for the in-flight update record (the confirmation). */
export const UPDATE_KEY = "tl-update";
/** Lobby self-check cadence.
 *
 * This was 5s, on the reasoning that `no-cache` against ttyd's strong ETag makes
 * each check a cheap 304. Measurement disagreed: over 24h on one iPhone the
 * lobby URL answered 1,279 full bodies (1.43 MB each) and exactly 2 not-modified
 * — 1.83 GB/day, 17.16 of the 17.18 MB/min this client spent at idle. Why iOS
 * does not revalidate is still unexplained (desktop Chrome does, and ttyd
 * answers If-None-Match correctly), so the check no longer depends on the answer
 * being cheap: it reads a ~12-byte stamp instead of the page, and it reads it far
 * less often. The boundaries that actually matter — a resume, a refocus, a
 * bfcache restore — are event-driven and unchanged. */
export const SELF_CHECK_MS = 300_000;

/** Where the stamp lives. Served from the shared asset whitelist, so it needs
 *  no service of its own and no restart to update. */
export const STAMP_PATH = "/build-id";

/** What the healer wrote before it navigated, read back at the next boot. */
interface UpdateRecord {
  /** the asset id this document was reloading TOWARDS. */
  target: string;
  /** the asset id it was leaving (telemetry only). */
  from: string | null;
  at: number;
  /** how many reloads have been attempted at `target` without landing. */
  n: number;
  /** has the give-up already been reported? (report once, not per boot) */
  reported?: boolean;
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type MinTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface DeployHealerDeps {
  /** Is a terminal attached (a session selected → a mounted SessionView)?
   *  The v2 analog of the vanilla `currentActive`. */
  hasAttachedTerminal: () => boolean;
  /** this document's own update identity; default: the `tl-asset` meta tag. */
  assetId?: () => string | null;
  /** default: `() => document.hidden`. */
  isHidden?: () => boolean;
  /** default: `() => document.hasFocus()`. */
  isFocused?: () => boolean;
  /** default: bound `window.fetch`. */
  fetchImpl?: typeof fetch;
  /** the URL to self-fetch; default `location.pathname + location.search`.
   *  Only used on the legacy fallback path (an origin with no stamp endpoint). */
  selfUrl?: () => string;
  /** the stamp endpoint; default {@link STAMP_PATH}. */
  stampUrl?: () => string;
  /** default: `() => location.reload()`. */
  reload?: () => void;
  /** default: `Date.now`. */
  now?: () => number;
  /** default: `sessionStorage` (or null when unavailable). */
  storage?: MinStorage | null;
  /** default: `window` — for the `pageshow` (bfcache) + focus/blur hooks. */
  win?: MinTarget | null;
  /** default: `document` — for the `visibilitychange` hook. */
  doc?: MinTarget | null;
  /** default: {@link SELF_CHECK_MS}. */
  intervalMs?: number;
  /** default: {@link STORM_WINDOW_MS}. */
  stormWindowMs?: number;
  /** default: {@link RESUME_AWAY_MS}. */
  resumeAwayMs?: number;
  /** default: `no-cache` (lobby: revalidate against ttyd's strong ETag → 304). */
  cacheMode?: RequestCache;
  /** arm the confirmation + start the poll/listeners immediately (default true). */
  autostart?: boolean;
  /** default: `console.log`. */
  log?: (...args: unknown[]) => void;
  /** default: the telemetry `track`. */
  emit?: (event: "app.reloaded" | "app.update_failed", attrs: TlAttrs) => void;
  /** Called after every evaluation with whether an update is waiting that this
   *  page is not running — the Build row of the connection status panel. */
  onUpdatePending?: (pending: boolean) => void;
}

export interface DeployHealer {
  /** run one lobby self-check now (skipped while hidden). */
  checkNow(opts?: { justResumed?: boolean }): Promise<void>;
  /** read back the record the previous page life wrote before it navigated. */
  confirmBoot(): void;
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

/** This document's own `TL_ASSET`, read from the head. Null when unstamped. */
function metaAssetId(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector('meta[name="tl-asset"]');
  const v = el?.getAttribute("content")?.trim();
  return !v || v.includes("__TL_") ? null : v;
}

/**
 * The build-id marker: log `terminal-lobby build: <id>` and stamp
 * `documentElement.dataset.tlBuild`. `TL_BUILD` is PROVENANCE (which commit is
 * deployed) — it is what telemetry reports and what a human reads in the
 * console. It is deliberately NOT what update detection compares; that is
 * `TL_ASSET` (ADR-0007). Logging `BUILD_SUBSTRING` is what plants the marker
 * literal in the served single-file HTML, which `fetchSelf` validates. Call once
 * at boot.
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
  const isFocused =
    deps.isFocused ??
    (() => (typeof document !== "undefined" && document.hasFocus ? document.hasFocus() : true));
  const assetId = deps.assetId ?? metaAssetId;
  const fetchImpl =
    deps.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  const selfUrl =
    deps.selfUrl ??
    (() => (typeof location !== "undefined" ? location.pathname + location.search : "/"));
  const reload =
    deps.reload ??
    (() => {
      if (typeof location !== "undefined") location.reload();
    });
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage;
  const win = deps.win === undefined ? (typeof window !== "undefined" ? window : null) : deps.win;
  const doc =
    deps.doc === undefined ? (typeof document !== "undefined" ? document : null) : deps.doc;
  const stampUrl = deps.stampUrl ?? (() => STAMP_PATH);
  const intervalMs = deps.intervalMs ?? SELF_CHECK_MS;
  const stormWindowMs = deps.stormWindowMs ?? STORM_WINDOW_MS;
  const resumeAwayMs = deps.resumeAwayMs ?? RESUME_AWAY_MS;
  const cacheMode: RequestCache = deps.cacheMode ?? "no-cache";
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));
  const emit =
    deps.emit ??
    ((event: "app.reloaded" | "app.update_failed", attrs: TlAttrs) => track(event, attrs));

  const runningAsset = assetId();
  const bootAt = now();
  /** when the document went away (hidden or blurred); null while it is here. */
  let awaySince: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** One check at a time. The old poll was fire-and-forget on a 5s timer, so on a
   *  slow link the fetches stacked — three were observed in flight at once, each
   *  pulling the whole page. A request arriving during one is COALESCED, not
   *  dropped: the checks that matter are event-driven (a resume, a refocus, a
   *  bfcache restore), and swallowing one because a poll happened to be in flight
   *  would defer a real update to the next tick — now five minutes away. */
  let checking = false;
  let queued: { justResumed: boolean; why: string } | null = null;
  /** Set once the stamp endpoint answers 404: this origin predates it, so fall
   *  back to reading the id out of the page (at the new, long interval) rather
   *  than losing self-update entirely on an older deploy. */
  let stampMissing = false;

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
  function readRecord(): UpdateRecord | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(UPDATE_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw) as UpdateRecord;
      return typeof rec?.target === "string" ? rec : null;
    } catch {
      return null;
    }
  }
  function writeRecord(rec: UpdateRecord | null): void {
    if (!storage) return;
    try {
      if (rec) storage.setItem(UPDATE_KEY, JSON.stringify(rec));
      else storage.removeItem(UPDATE_KEY);
    } catch {
      /* no storage */
    }
  }

  /** Reloads already attempted at THIS target without landing (0 for a new one). */
  function attemptsFor(target: string): number {
    const rec = readRecord();
    return rec && rec.target === target ? rec.n : 0;
  }

  /**
   * The apply step. Records the target FIRST (so the next boot can tell whether
   * the navigation landed), then the storm timestamp, then navigates.
   */
  function applyUpdate(target: string, why: string): void {
    writeRecord({ target, from: runningAsset, at: now(), n: attemptsFor(target) + 1 });
    recordReload(now());
    log("update " + target + " (" + why + ") — reloading");
    reload();
  }

  /** One evaluation of the whole policy, with at most one fetch in flight. */
  async function evaluate(justResumed: boolean, why: string): Promise<void> {
    if (checking) {
      queued = { justResumed, why };
      return;
    }
    checking = true;
    try {
      await evaluateOnce(justResumed, why);
    } finally {
      checking = false;
    }
    if (queued) {
      const next = queued;
      queued = null;
      await evaluate(next.justResumed, next.why);
    }
  }

  /** The policy itself, against the currently served stamp. */
  async function evaluateOnce(justResumed: boolean, why: string): Promise<void> {
    if (!fetchImpl) return;
    if (isHidden()) return; // never fetch (or navigate) for a backgrounded page
    let served: string | null = null;
    try {
      if (!stampMissing) {
        const stamp = await fetchStamp(fetchImpl, stampUrl(), cacheMode);
        if (stamp.missing) stampMissing = true;
        else served = stamp.id;
      }
      if (stampMissing) {
        const text = await fetchSelf(fetchImpl, selfUrl(), cacheMode);
        served = text ? parseAssetId(text) : null;
      }
    } catch {
      return; // transient fetch error — try again on the next check
    }
    if (!served) return;
    const plan = planUpdate({
      runningAsset,
      servedAsset: served,
      attached: deps.hasAttachedTerminal(),
      visible: !isHidden() && isFocused(),
      justResumed,
      attempts: attemptsFor(served),
      now: now(),
      lastReloadAt: lastReloadAt(),
      stormWindowMs,
      storageAvailable: !!storage,
      uptimeMs: now() - bootAt,
    });
    // A deferred or given-up update is a real one this page is not running, and
    // a tab on old JavaScript against a new server looks exactly like a broken
    // connection — which is why the status panel gets a row for it (ADR-0016).
    deps.onUpdatePending?.(plan === "defer" || plan === "give-up");
    if (plan === "reload") applyUpdate(served, why);
    // "defer" — a real update is waiting for the next open; nothing is shown.
    // "none" / "give-up" — nothing to do (give-up was already reported at boot).
  }

  async function checkNow(opts: { justResumed?: boolean } = {}): Promise<void> {
    await evaluate(!!opts.justResumed, opts.justResumed ? "resume" : "poll");
  }

  /**
   * Read back what the previous page life was reloading towards. Landed → clear
   * and report; did not land → keep the count, and once it hits the cap report
   * that ONCE and let `planUpdate` go quiet for that target.
   */
  function confirmBoot(): void {
    const rec = readRecord();
    if (!rec) return;
    if (runningAsset && rec.target === runningAsset) {
      writeRecord(null);
      emit("app.reloaded", {
        "tl.reason": "update",
        "tl.from": rec.from,
        "tl.to": runningAsset,
      });
      return;
    }
    if (rec.n >= MAX_UPDATE_ATTEMPTS && !rec.reported) {
      writeRecord({ ...rec, reported: true });
      emit("app.update_failed", { "tl.to": rec.target, "tl.count": rec.n });
    }
  }

  /** Away → here. Only a real absence counts as "the next open". */
  function returned(): void {
    const away = awaySince;
    awaySince = null;
    if (isHidden() || !isFocused()) return; // not actually back yet
    void evaluate(away !== null && now() - away >= resumeAwayMs, "resume");
  }
  function left(): void {
    if (awaySince === null) awaySince = now();
  }

  const onVisibility = (): void => {
    if (isHidden()) left();
    else returned();
  };
  const onFocus = (): void => returned();
  const onBlur = (): void => left();
  const onPageShow = (e: Event): void => {
    // bfcache restore: the page comes back frozen, not reloaded — a whole deploy
    // may have landed while it slept. Always an open.
    if ((e as PageTransitionEvent).persisted) {
      awaySince = null;
      void evaluate(true, "bfcache");
    }
  };

  function start(): void {
    confirmBoot();
    void checkNow();
    timer = setInterval(() => void checkNow(), intervalMs);
    doc?.addEventListener("visibilitychange", onVisibility);
    win?.addEventListener("pageshow", onPageShow);
    win?.addEventListener("focus", onFocus);
    win?.addEventListener("blur", onBlur);
  }

  function dispose(): void {
    if (timer !== undefined) clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pageshow", onPageShow);
    win?.removeEventListener("focus", onFocus);
    win?.removeEventListener("blur", onBlur);
  }

  if (deps.autostart !== false) start();

  return { checkNow, confirmBoot, dispose };
}
