import { createSignal, type Accessor } from "solid-js";
import {
  DEFAULT_SESSION_ORDER,
  isSessionOrder,
  type SessionOrder,
} from "../components/order.logic";
import { apiUrl, PREFS_PATH } from "../lib/config";
import { track } from "../telemetry/track";
import { fetchWithDeadline } from "../lib/http";
import { isNewModel, type NewModel } from "../lib/models";

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
/**
 * Wheels emitted per row-height. An enumeration, not a range.
 *
 * One type for BOTH speed prefs, because they are the same quantity for two
 * input devices: `gestures.wheelSpeed` counts LINE wheels per notch or trackpad
 * row-height and `gestures.scrollSpeedV2` counts them per FINGER row-height,
 * and term.html validates the two with the identical predicate
 * (`PREF_VALID.gestures.wheelSpeed` :2890, `.scrollSpeedV2` :2885). A second
 * name for the same four values would only give them room to drift apart.
 */
export type WheelSpeed = 1 | 1.5 | 2 | 3;

/**
 * Where a terminal tap puts the caret while the mobile input bar is up: the
 * compose mirror's field, or xterm's own helper textarea.
 *
 * `PREF_VALID.input.tapFocus` (term.html:2894), read by that page's `tapFocus`
 * once the bar has mounted (:7459-7460).
 */
export type TapFocus = "field" | "terminal";

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
   * The wheel and the finger. `wheelSmooth` and `wheelSpeed` are the desktop
   * smooth-wheel pair, edited by the settings panel and read by
   * `terminal/wheel.ts`; `scrollSpeedV2` and `scrollMomentum` are the touch
   * scroller's (`terminal/touchscroll.ts`) and have no editing UI on this side
   * yet.
   *
   * Seven TOUCH flags in the same namespace stay untyped: keyRepeat,
   * cardLongPress, overlaySwipe, bottomSheet, swipeSessionOptIn, twoFingerTap,
   * haptics. They belong to the terminal page and `composeDoc` carries them
   * through every write from here. So does the burned v1 `gestures.scrollSpeed`,
   * which `scrollSpeedV2` re-keyed (term.html:2881-2884) and which nothing on
   * this side may bring back.
   */
  gestures: {
    wheelSmooth: boolean;
    wheelSpeed: WheelSpeed;
    scrollSpeedV2: WheelSpeed;
    scrollMomentum: boolean;
  };
  /**
   * The mobile input bar. `tapFocus` is where a terminal tap puts the caret,
   * and `terminal/touchscroll.ts` and `terminal/dragselect.ts` both route one
   * through it: since the compose mirror landed, a tap on a phone reaches that
   * field rather than xterm's hardened helper textarea.
   *
   * `input.bar` stays an untyped-but-preserved subkey, and this is why:
   * its default `'auto'` is a never-touched marker that resolves per DEVICE at
   * apply time, coarse pointers engaging the bar and fine pointers ignoring it
   * (term.html:2798-2802), so a value written from here would answer a question
   * the roamed doc is meant to leave open. Reading it is a different matter and
   * `TerminalNative`'s `bootInputBar` does exactly that, off the raw document
   * with its own validator, the way `bootPrefs` reads the legacy font key.
   * Nothing on this side writes it.
   */
  input: { tapFocus: TapFocus };
  /**
   * What the new-session composer starts with. `newCommand` is which tool runs
   * (it is also the one the terminal attach reads); `newProject` is the project
   * a create lands in, "" for Ungrouped; `newModel` is the model injected as
   * `/model <name>` ahead of the first prompt (lib/models.ts). All three roam,
   * because none of them changes when a person picks up a different device.
   */
  session: { newCommand: NewCommand; newProject: string; newModel: NewModel };
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
  input?: Partial<Prefs["input"]>;
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
export const TAP_FOCUS_TARGETS: readonly TapFocus[] = ["field", "terminal"];

export const PREF_DEFAULTS: Prefs = {
  fontSize: FONT_SIZE_DEFAULT,
  lineHeight: 1, // xterm default
  letterSpacing: 0, // px; fractional ok (device-pixel rounding)
  cursorStyle: "block",
  cursorBlink: true, // the historical constructor value
  fontWeightBold: "700", // the real JBM 700 face
  links: { copyChip: true },
  // Every default below is term.html's own, cited by line, because that page
  // has been serving them to real devices for months: a different value here is
  // a silent behaviour change on every device that never set the pref.
  // wheelSmooth :2783, wheelSpeed :2784, scrollSpeedV2 :2766, scrollMomentum
  // :2767.
  //
  // scrollMomentum is TRUE, and term.html's reader looks like it says otherwise:
  // `scrollMomentumOn()` is `!!getPrefs().gestures.scrollMomentum` (:6093),
  // which would turn a missing key into FALSE. It never sees one. `getPrefs()`
  // runs `normalizePrefs`, which rebuilds each namespace from PREF_DEFAULTS
  // before any subkey is read (:2929), so the `!!` only ever narrows a boolean
  // that is already there.
  gestures: { wheelSmooth: true, wheelSpeed: 1, scrollSpeedV2: 1, scrollMomentum: true },
  input: { tapFocus: "field" }, // term.html:2811
  session: { newCommand: DEFAULT_NEW_COMMAND, newProject: "", newModel: "default" },
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
  const input = isPlainObject(src.input) ? src.input : {};
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
      // The touch scroller's two, on the same predicates term.html uses
      // (:2885, :2886). `touchscroll.ts` validates the speed AGAIN in its own
      // `scrollSpeedMult`, which is what term.html does too: :6089-6092
      // re-checks a value `getPrefs()` has already normalized, so the module
      // stays correct about a world it did not build.
      scrollSpeedV2: oneOf(gestures.scrollSpeedV2, WHEEL_SPEEDS)
        ? gestures.scrollSpeedV2
        : PREF_DEFAULTS.gestures.scrollSpeedV2,
      scrollMomentum:
        typeof gestures.scrollMomentum === "boolean"
          ? gestures.scrollMomentum
          : PREF_DEFAULTS.gestures.scrollMomentum,
    },
    input: {
      tapFocus: oneOf(input.tapFocus, TAP_FOCUS_TARGETS)
        ? input.tapFocus
        : PREF_DEFAULTS.input.tapFocus,
    },
    session: {
      newCommand: isNewCommand(session.newCommand)
        ? session.newCommand
        : DEFAULT_NEW_COMMAND,
      // A project is named by a person, so anything is a legal name; only the
      // TYPE is checked. A name whose project has since been deleted resolves
      // to Ungrouped in the composer rather than being rewritten here, so
      // recreating the project brings the choice back.
      newProject: typeof session.newProject === "string" ? session.newProject : "",
      newModel: isNewModel(session.newModel) ? session.newModel : "default",
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
 * never clobbers the terminal page's gestures touch flags, its `input.bar` or
 * `session.reopenLast`). This is the whole-doc payload PUT + persisted.
 *
 * Knowing MORE subkeys does not weaken that, which is the question typing
 * `gestures.scrollSpeedV2`, `gestures.scrollMomentum` and `input.tapFocus` for
 * the native terminal had to answer. It moved three keys from "spread through
 * untouched" to "written explicitly", and what a write puts there is the value
 * the doc already held: `coercePrefs` accepts exactly what term.html accepts,
 * so the round trip is a no-op. Where a key was ABSENT the write now
 * materialises term.html's own default, which is the value that page was
 * already serving for it anyway. The one thing that would break a device is a
 * subkey typed here whose default differs from term.html's, which is why every
 * default in PREF_DEFAULTS names its line.
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
  // Spread FIRST, then overwrite only the subkeys this side knows: `gestures`
  // holds seven touch flags the terminal page owns (keyRepeat, cardLongPress,
  // overlaySwipe, bottomSheet, swipeSessionOptIn, twoFingerTap, haptics) and
  // `input` holds `bar`. Losing them here would turn off long-press, haptics
  // and the input bar on every device.
  const gestures = isPlainObject(base.gestures) ? base.gestures : {};
  const input = isPlainObject(base.input) ? base.input : {};
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
      scrollSpeedV2: prefs.gestures.scrollSpeedV2,
      scrollMomentum: prefs.gestures.scrollMomentum,
    },
    input: { ...input, tapFocus: prefs.input.tapFocus },
    session: {
      ...session,
      newCommand: prefs.session.newCommand,
      newProject: prefs.session.newProject,
      newModel: prefs.session.newModel,
    },
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
  for (const k of [
    "session",
    "notify",
    "sidebar",
    "links",
    "gestures",
    "input",
  ] as const) {
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
  diff(
    "gestures.scrollSpeedV2",
    prev.gestures.scrollSpeedV2,
    next.gestures.scrollSpeedV2,
  );
  diff(
    "gestures.scrollMomentum",
    prev.gestures.scrollMomentum,
    next.gestures.scrollMomentum,
  );
  diff("input.tapFocus", prev.input.tapFocus, next.input.tapFocus);
  diff("session.newCommand", prev.session.newCommand, next.session.newCommand);
  diff("session.newProject", prev.session.newProject, next.session.newProject);
  diff("session.newModel", prev.session.newModel, next.session.newModel);
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
    input: { ...cur.input, ...(patch.input ?? {}) },
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

/**
 * The roamed prefs as the PERSISTED document holds them right now.
 *
 * term.html's `getPrefs()` (:2952-2958) to the letter: read `tl:prefs:v1`,
 * validate-or-default it, and seed `fontSize` from the legacy device key when
 * the doc carries no usable one. It computes the same thing as
 * `TerminalNative`'s private `bootPrefs`, which is the duplicate to collapse
 * when that component next needs touching.
 *
 * WHY A PULL RATHER THAN THE STORE'S SIGNAL. `terminal/touchscroll.ts` reads
 * `gestures.scrollSpeedV2` on EVERY feed (term.html re-reads it inside
 * `feedScroll`, :6119) and `gestures.scrollMomentum` at the lift (:6543);
 * `terminal/wheel.ts` reads `gestures.wheelSmooth` on every wheel (:6238, via
 * `wheelSmoothOn`). Two facts rule the signal out for those reads. The
 * component is not given the store: App.tsx creates it and passes it by prop,
 * which is why `TerminalNative` already reads the document directly rather than
 * threading one more prop through `SessionView`. And the signal only ever sees
 * writes made in THIS document, while term.html is still the shipped terminal
 * on the same origin and the same doc, so a change made in the vanilla settings
 * panel reaches localStorage and never this signal (that page listens for the
 * `storage` event for the mirror-image reason, :7585-7586). The document is
 * never staler than the signal either, because `setPref` persists before it
 * pushes.
 *
 * WHAT IT COSTS, since a touchmove path calls it. The parse plus the coerce
 * measured 6.2 us per call on a 590-byte doc carrying every namespace (node 22
 * on the devvm, 200k iterations): 0.7 ms per second of dragging at 120 Hz, under
 * 0.1% of a frame. The `localStorage.getItem` half is not measured here and does
 * not need to be, because term.html pays the identical read on every touchmove
 * and every wheel already, on the phones the touch scroller was tuned on.
 * Nothing is cached, deliberately: a memo keyed on the raw string would be
 * sound, and it would be optimising 6 us.
 *
 * WHAT A CALLER GIVES UP against term.html: nothing, for these three prefs.
 * This is a pull, so it reflects a change only when someone calls it, and all
 * three are read at the moment they are used. A pref that has to PUSH into a
 * mounted terminal (a font change refitting a live grid) still has no route in,
 * which is what `bootPrefs`' own comment says.
 */
export function readPersistedPrefs(): Prefs {
  const doc = readRawDoc();
  return { ...coercePrefs(doc), fontSize: seedFontSize(doc) };
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
