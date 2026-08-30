import { createSignal, type Accessor } from "solid-js";
import {
  DEFAULT_SESSION_ORDER,
  isSessionOrder,
  type SessionOrder,
} from "../components/order.logic";
import { apiUrl, PREFS_PATH } from "../lib/config";
import { track } from "../telemetry/track";
import { fetchWithDeadline } from "../lib/http";

/**
 * Roamed preferences — the whole-document, last-writer-wins store that mirrors
 * the vanilla frontend's `tl:prefs:v1` ↔ `/prefs` contract (index.html + the
 * tmux-api handlePrefs / parseNotifyPrefs Go side). The server treats the doc as
 * opaque (it only guards the envelope); the client validates-or-defaults every
 * KNOWN field on read.
 *
 * This SPA deliberately owns only a SUBSET of the fields the vanilla terminal
 * page also reads (fontSize, session.newCommand, notify.*). Because that page
 * still runs inside the terminal iframe (xterm stays external), a whole-doc
 * write here MUST NOT drop the fields it doesn't know about — so, unlike the
 * vanilla `normalizePrefs` which drops unknown keys, this store PRESERVES every
 * unknown top-level key AND unknown subkey on write-back (composeDoc). Known
 * fields are still validate-or-defaulted for use.
 *
 * Adoption is local-wins-until-first-load: a persisted `tl:prefs-dirty:v1`
 * marker (set on any local change, cleared only when a PUT acks) keeps an
 * unacked local change winning over the server doc across reloads and across the
 * sibling iframe's own boot GET.
 */

export type NewCommand = "default" | "claude" | "codex" | "shell";
export const NEW_COMMANDS: readonly NewCommand[] = [
  "claude",
  "codex",
  "shell",
  "default",
];
export const DEFAULT_NEW_COMMAND: NewCommand = "claude";

/** xterm cursor shapes the terminal page accepts (vanilla PREF_VALID). */
export type CursorStyle = "block" | "bar" | "underline";
/** The two bold faces Task 1.3 pinned; anything else renders as a synthetic. */
export type BoldWeight = "600" | "700";
/** Desktop wheel multiplier — an enumeration, not a range. */
export type WheelSpeed = 1 | 1.5 | 2 | 3;

export interface Prefs {
  fontSize: number;
  /**
   * Terminal rendering, all roamed and all consumed by `term.html`, which has
   * been reading them from the shared-origin `tl:prefs:v1` doc since long
   * before this SPA existed — only the editing UI was missing here. Ranges and
   * enumerations mirror the vanilla page's PREF_VALID exactly: a value it
   * rejects is a setting that silently does nothing.
   */
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  fontWeightBold: BoldWeight;
  /** The copy chip on terminal links. One key today; namespaced upstream. */
  links: { copyChip: boolean };
  /**
   * Desktop smooth-wheel only. The `gestures` namespace also holds eight TOUCH
   * flags this panel does not edit (keyRepeat, cardLongPress, haptics, …); they
   * belong to the terminal page and survive every write from here.
   */
  gestures: { wheelSmooth: boolean; wheelSpeed: WheelSpeed };
  session: { newCommand: NewCommand };
  notify: { onDone: boolean; onAwaiting: boolean };
  /** Session-list display. `showLastActive` governs the relative "5m ago" on
   *  each card — OFF by default, and deliberately not the running session's
   *  live working timer, which is progress on the turn in flight rather than a
   *  timestamp. `order` is which order the cards come in (manual / created /
   *  active), roamed rather than per-browser because it is a view preference
   *  about the SAME list on every device — a phone that ordered itself
   *  differently from the laptop beside it would be answering a question
   *  nobody asked. Its own namespace because the vanilla page never wrote one,
   *  so there is nothing to collide with. */
  sidebar: { showLastActive: boolean; order: SessionOrder };
}

export interface PrefsPatch {
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  fontWeightBold?: BoldWeight;
  links?: Partial<Prefs["links"]>;
  gestures?: Partial<Prefs["gestures"]>;
  session?: Partial<Prefs["session"]>;
  notify?: Partial<Prefs["notify"]>;
  sidebar?: Partial<Prefs["sidebar"]>;
}

// Device-local + roamed keys — the exact names the vanilla app uses, so the two
// frontends stay byte-compatible on the same origin (feature-inventory §6).
export const PREFS_KEY = "tl:prefs:v1";
export const PREFS_DIRTY_KEY = "tl:prefs-dirty:v1";
export const FONT_SIZE_KEY = "tl-font-size";

export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 15;

export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 1.4;
export const LETTER_SPACING_MIN = 0;
export const LETTER_SPACING_MAX = 1;
export const CURSOR_STYLES: readonly CursorStyle[] = ["block", "bar", "underline"];
export const BOLD_WEIGHTS: readonly BoldWeight[] = ["600", "700"];
export const WHEEL_SPEEDS: readonly WheelSpeed[] = [1, 1.5, 2, 3];

export const PREF_DEFAULTS: Prefs = {
  fontSize: FONT_SIZE_DEFAULT,
  lineHeight: 1, // xterm default
  letterSpacing: 0, // px; fractional ok (device-pixel rounding)
  cursorStyle: "block",
  cursorBlink: true, // the historical constructor value
  fontWeightBold: "700", // the real JBM 700 face
  links: { copyChip: true },
  gestures: { wheelSmooth: true, wheelSpeed: 1 },
  session: { newCommand: DEFAULT_NEW_COMMAND },
  notify: { onDone: true, onAwaiting: true },
  sidebar: { showLastActive: false, order: DEFAULT_SESSION_ORDER },
};

// ---- pure helpers (exported for unit tests) -------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isValidFontSize(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= FONT_SIZE_MIN &&
    v <= FONT_SIZE_MAX
  );
}

/** Finite number inside an inclusive range — the vanilla PREF_VALID shape for
 *  lineHeight and letterSpacing. Rejects strings: the terminal page compares
 *  these straight into `term.options`, where "1.2" is not 1.2. */
function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[]): v is T {
  return (allowed as readonly unknown[]).includes(v);
}

function isNewCommand(v: unknown): v is NewCommand {
  return (
    v === "default" || v === "claude" || v === "codex" || v === "shell"
  );
}

/** Clamp any input to a valid integer font size (invalid → default). */
export function clampFontSize(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(v)));
}

/** validate-or-default the KNOWN fields of a raw doc into a typed Prefs. */
export function coercePrefs(raw: unknown): Prefs {
  const src = isPlainObject(raw) ? raw : {};
  const session = isPlainObject(src.session) ? src.session : {};
  const notify = isPlainObject(src.notify) ? src.notify : {};
  const sidebar = isPlainObject(src.sidebar) ? src.sidebar : {};
  const links = isPlainObject(src.links) ? src.links : {};
  const gestures = isPlainObject(src.gestures) ? src.gestures : {};
  return {
    fontSize: isValidFontSize(src.fontSize) ? src.fontSize : FONT_SIZE_DEFAULT,
    lineHeight: inRange(src.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)
      ? src.lineHeight
      : PREF_DEFAULTS.lineHeight,
    letterSpacing: inRange(src.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX)
      ? src.letterSpacing
      : PREF_DEFAULTS.letterSpacing,
    cursorStyle: oneOf(src.cursorStyle, CURSOR_STYLES)
      ? src.cursorStyle
      : PREF_DEFAULTS.cursorStyle,
    cursorBlink:
      typeof src.cursorBlink === "boolean" ? src.cursorBlink : PREF_DEFAULTS.cursorBlink,
    fontWeightBold: oneOf(src.fontWeightBold, BOLD_WEIGHTS)
      ? src.fontWeightBold
      : PREF_DEFAULTS.fontWeightBold,
    links: {
      copyChip:
        typeof links.copyChip === "boolean" ? links.copyChip : PREF_DEFAULTS.links.copyChip,
    },
    gestures: {
      wheelSmooth:
        typeof gestures.wheelSmooth === "boolean"
          ? gestures.wheelSmooth
          : PREF_DEFAULTS.gestures.wheelSmooth,
      wheelSpeed: oneOf(gestures.wheelSpeed, WHEEL_SPEEDS)
        ? gestures.wheelSpeed
        : PREF_DEFAULTS.gestures.wheelSpeed,
    },
    session: {
      newCommand: isNewCommand(session.newCommand)
        ? session.newCommand
        : DEFAULT_NEW_COMMAND,
    },
    notify: {
      onDone: typeof notify.onDone === "boolean" ? notify.onDone : true,
      onAwaiting:
        typeof notify.onAwaiting === "boolean" ? notify.onAwaiting : true,
    },
    sidebar: {
      // Anything that is not literally `true` is off — including a stored
      // "true" string. Every doc written before this pref existed lacks the
      // namespace entirely, which is what makes it off for everyone already.
      showLastActive: sidebar.showLastActive === true,
      // An absent key resolves to created-time, which is how the default
      // reaches the people who already have a hand-arranged layout saved: the
      // arrangement stays in the layout, waiting for them to ask for it back.
      order: isSessionOrder(sidebar.order) ? sidebar.order : DEFAULT_SESSION_ORDER,
    },
  };
}

/**
 * Write typed prefs back into a raw doc, PRESERVING every unknown top-level key
 * and every unknown subkey of the known namespaces (so a write from this SPA
 * never clobbers the vanilla terminal page's gestures/input namespaces or
 * session.reopenLast etc.). This is the whole-doc payload PUT + persisted.
 */
export function composeDoc(
  raw: unknown,
  prefs: Prefs,
): Record<string, unknown> {
  const base = isPlainObject(raw) ? { ...raw } : {};
  const session = isPlainObject(base.session) ? base.session : {};
  const notify = isPlainObject(base.notify) ? base.notify : {};
  const sidebar = isPlainObject(base.sidebar) ? base.sidebar : {};
  const links = isPlainObject(base.links) ? base.links : {};
  // Spread FIRST, then overwrite only what this panel edits: `gestures` holds
  // eight touch flags the terminal page owns, and losing them here would turn
  // off long-press, haptics and the rest on every device.
  const gestures = isPlainObject(base.gestures) ? base.gestures : {};
  return {
    ...base,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    letterSpacing: prefs.letterSpacing,
    cursorStyle: prefs.cursorStyle,
    cursorBlink: prefs.cursorBlink,
    fontWeightBold: prefs.fontWeightBold,
    links: { ...links, copyChip: prefs.links.copyChip },
    gestures: {
      ...gestures,
      wheelSmooth: prefs.gestures.wheelSmooth,
      wheelSpeed: prefs.gestures.wheelSpeed,
    },
    session: { ...session, newCommand: prefs.session.newCommand },
    notify: {
      ...notify,
      onDone: prefs.notify.onDone,
      onAwaiting: prefs.notify.onAwaiting,
    },
    sidebar: {
      ...sidebar,
      showLastActive: prefs.sidebar.showLastActive,
      order: prefs.sidebar.order,
    },
  };
}

/**
 * Adoption merge: server fields win, but a field the server never saw keeps its
 * local value, and unknown keys from BOTH sides survive. Known namespaces are
 * deep-merged one level (a server namespace missing a subkey must not reset the
 * local subkey — matches the vanilla adoptPrefs posture).
 */
export function mergeAdopt(
  localRaw: unknown,
  serverRaw: unknown,
): Record<string, unknown> {
  const local = isPlainObject(localRaw) ? localRaw : {};
  const server = isPlainObject(serverRaw) ? serverRaw : {};
  const merged: Record<string, unknown> = { ...local, ...server };
  for (const k of ["session", "notify", "sidebar", "links", "gestures"] as const) {
    const l = isPlainObject(local[k]) ? local[k] : {};
    const s = isPlainObject(server[k]) ? server[k] : {};
    merged[k] = { ...l, ...s };
  }
  return merged;
}

/**
 * The dotted paths whose value actually changed between two typed docs, each
 * with its NEW value — the shape telemetry/events.go documents for
 * prefs.changed ("tl.key = pref path, tl.to = new value").
 *
 * The old loop walked the PATCH instead: a nested patch reported the namespace
 * as the key and the sub-key NAMES as the value, so `session.newCommand`
 * codex→shell went out as {tl.key:"session", tl.to:"newCommand"} — the one thing
 * a reader needs (which value it moved to) was the one thing missing. Diffing
 * before-vs-after also drops the phantom events a re-picked <select> produced.
 */
export function changedPrefPaths(prev: Prefs, next: Prefs): [string, string][] {
  const out: [string, string][] = [];
  const diff = (path: string, a: unknown, b: unknown): void => {
    if (a !== b) out.push([path, String(b)]);
  };
  diff("fontSize", prev.fontSize, next.fontSize);
  diff("lineHeight", prev.lineHeight, next.lineHeight);
  diff("letterSpacing", prev.letterSpacing, next.letterSpacing);
  diff("cursorStyle", prev.cursorStyle, next.cursorStyle);
  diff("cursorBlink", prev.cursorBlink, next.cursorBlink);
  diff("fontWeightBold", prev.fontWeightBold, next.fontWeightBold);
  diff("links.copyChip", prev.links.copyChip, next.links.copyChip);
  diff("gestures.wheelSmooth", prev.gestures.wheelSmooth, next.gestures.wheelSmooth);
  diff("gestures.wheelSpeed", prev.gestures.wheelSpeed, next.gestures.wheelSpeed);
  diff("session.newCommand", prev.session.newCommand, next.session.newCommand);
  diff("notify.onDone", prev.notify.onDone, next.notify.onDone);
  diff("notify.onAwaiting", prev.notify.onAwaiting, next.notify.onAwaiting);
  diff(
    "sidebar.showLastActive",
    prev.sidebar.showLastActive,
    next.sidebar.showLastActive,
  );
  diff("sidebar.order", prev.sidebar.order, next.sidebar.order);
  return out;
}

/** Merge a typed patch into a typed Prefs (deep one level), returns the next. */
export function applyPatch(cur: Prefs, patch: PrefsPatch): Prefs {
  const pick = <K extends keyof Prefs>(k: K): Prefs[K] =>
    (patch as Partial<Prefs>)[k] !== undefined
      ? ((patch as Partial<Prefs>)[k] as Prefs[K])
      : cur[k];
  return {
    fontSize: patch.fontSize !== undefined ? patch.fontSize : cur.fontSize,
    lineHeight: pick("lineHeight"),
    letterSpacing: pick("letterSpacing"),
    cursorStyle: pick("cursorStyle"),
    cursorBlink: pick("cursorBlink"),
    fontWeightBold: pick("fontWeightBold"),
    links: { ...cur.links, ...(patch.links ?? {}) },
    gestures: { ...cur.gestures, ...(patch.gestures ?? {}) },
    session: { ...cur.session, ...(patch.session ?? {}) },
    notify: { ...cur.notify, ...(patch.notify ?? {}) },
    sidebar: { ...cur.sidebar, ...(patch.sidebar ?? {}) },
  };
}

// ---- store ----------------------------------------------------------------

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface PrefsStoreOptions {
  /** Injected for tests; defaults to same-origin global fetch. */
  fetchImpl?: FetchLike;
  /** Debounce window for the whole-doc PUT (ms). */
  putDebounceMs?: number;
}

export interface PrefsStore {
  prefs: Accessor<Prefs>;
  /** Merge a typed patch, persist, mark dirty, schedule a debounced PUT. */
  setPref(patch: PrefsPatch): void;
  /** Font-size convenience: clamps, then writes the roamed + legacy device key. */
  setFontSize(n: number): void;
  /** Fire the boot GET; adopts the server doc unless a local change is unacked. */
  bootSync(): Promise<void>;
  dispose(): void;
}

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / no storage */
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* no storage */
  }
}

function readRawDoc(): Record<string, unknown> {
  try {
    const raw = JSON.parse(lsGet(PREFS_KEY) ?? "null");
    return isPlainObject(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** fontSize seeded from the doc, else the legacy device key, else the default. */
function seedFontSize(doc: Record<string, unknown>): number {
  if (isValidFontSize(doc.fontSize)) return doc.fontSize;
  const legacy = Number(lsGet(FONT_SIZE_KEY));
  return isValidFontSize(legacy) ? legacy : FONT_SIZE_DEFAULT;
}

export function createPrefsStore(opts: PrefsStoreOptions = {}): PrefsStore {
  const putDebounceMs = opts.putDebounceMs ?? 400;
  const fetchImpl: FetchLike | undefined =
    opts.fetchImpl ??
    (typeof fetch !== "undefined"
      ? (input, init) => fetchWithDeadline(input, init)
      : undefined);

  // rawDoc is the canonical persisted document (unknown keys preserved). The
  // signal is the typed, validated VIEW derived from it.
  let rawDoc = readRawDoc();
  const seeded = seedFontSize(rawDoc);
  rawDoc = composeDoc(rawDoc, { ...coercePrefs(rawDoc), fontSize: seeded });
  const [prefs, setPrefsSignal] = createSignal<Prefs>(coercePrefs(rawDoc));


  let dirty = false;
  let putTimer: ReturnType<typeof setTimeout> | undefined;

  const isDirty = () => dirty || lsGet(PREFS_DIRTY_KEY) !== null;

  function markDirty(): void {
    dirty = true;
    lsSet(PREFS_DIRTY_KEY, String(Date.now()));
  }

  function persist(): void {
    lsSet(PREFS_KEY, JSON.stringify(rawDoc));
    lsSet(FONT_SIZE_KEY, String(prefs().fontSize)); // dual-write legacy device key
  }

  function schedulePut(): void {
    if (!fetchImpl) return;
    if (putTimer) clearTimeout(putTimer);
    putTimer = setTimeout(() => {
      putTimer = undefined;
      const sentMark = lsGet(PREFS_DIRTY_KEY);
      void fetchImpl(apiUrl(PREFS_PATH), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rawDoc),
      })
        .then((resp) => {
          // Server holds it now: retire the dirty marker unless a newer change
          // re-stamped it mid-flight (its own debounced PUT is coming).
          if (resp.ok && sentMark !== null && lsGet(PREFS_DIRTY_KEY) === sentMark) {
            dirty = false;
            lsRemove(PREFS_DIRTY_KEY);
          }
        })
        .catch(() => {
          /* offline / api down: localStorage + marker still hold the change */
        });
    }, putDebounceMs);
  }

  /**
   * Tell the attached terminal iframe about a change we have already persisted.
   * term.html reads localStorage as the truth and treats the payload as the
   * failed-write fallback, so this MUST run after persist().
   */
  function pushLive(next: Prefs): void {
    if (typeof window === "undefined") return;
    try {
      window.__tlPrefsLive?.(next);
    } catch {
      /* a detached frame must never break a pref write */
    }
  }

  function setPref(patch: PrefsPatch): void {
    const cur = prefs();
    const next = coercePrefs(composeDoc(rawDoc, applyPatch(cur, patch)));
    if (JSON.stringify(next) === JSON.stringify(cur)) return; // no-op
    // Which knobs people actually turn. Paths and scalar values only — a pref
    // value is a setting, never content. Emitted AFTER the no-op guard, so an
    // onChange that re-picks the current value records nothing.
    for (const [path, value] of changedPrefPaths(cur, next)) {
      track("prefs.changed", { "tl.key": path, "tl.to": value });
    }
    rawDoc = composeDoc(rawDoc, next);
    setPrefsSignal(next);
    markDirty();
    persist();
    pushLive(next);
    schedulePut();
  }

  function setFontSize(n: number): void {
    setPref({ fontSize: clampFontSize(n) });
  }

  function adopt(serverDoc: unknown): void {
    const merged = mergeAdopt(rawDoc, serverDoc);
    const next = { ...coercePrefs(merged), fontSize: seedFontSize(merged) };
    rawDoc = composeDoc(merged, next);
    setPrefsSignal(next);
    persist(); // NO schedulePut: adoption is not a user change (no PUT-back).
    // A roamed font size adopted at boot still has to reach the terminal — the
    // vanilla lobby pushes on adoption for the same reason.
    pushLive(next);
  }

  async function bootSync(): Promise<void> {
    if (!fetchImpl) return;
    let doc: unknown;
    try {
      const resp = await fetchImpl(apiUrl(PREFS_PATH), {
      });
      if (!resp.ok) return; // keep local; next boot retries
      doc = await resp.json();
    } catch {
      return;
    }
    // Local moved first — local wins; push it up instead of adopting.
    if (isDirty()) {
      schedulePut();
      return;
    }
    if (isPlainObject(doc) && Object.keys(doc).length > 0) {
      adopt(doc);
    } else if (Object.keys(readRawDoc()).length > 0) {
      schedulePut(); // seed a fresh server doc from our local one
    }
  }

  function dispose(): void {
    if (putTimer) clearTimeout(putTimer);
  }

  return { prefs, setPref, setFontSize, bootSync, dispose };
}
