import { createSignal, type Accessor } from "solid-js";
import { apiUrl, PREFS_PATH } from "../lib/config";

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

export interface Prefs {
  fontSize: number;
  session: { newCommand: NewCommand };
  notify: { onDone: boolean; onAwaiting: boolean };
}

export interface PrefsPatch {
  fontSize?: number;
  session?: Partial<Prefs["session"]>;
  notify?: Partial<Prefs["notify"]>;
}

// Device-local + roamed keys — the exact names the vanilla app uses, so the two
// frontends stay byte-compatible on the same origin (feature-inventory §6).
export const PREFS_KEY = "tl:prefs:v1";
export const PREFS_DIRTY_KEY = "tl:prefs-dirty:v1";
export const FONT_SIZE_KEY = "tl-font-size";

export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 15;

export const PREF_DEFAULTS: Prefs = {
  fontSize: FONT_SIZE_DEFAULT,
  session: { newCommand: DEFAULT_NEW_COMMAND },
  notify: { onDone: true, onAwaiting: true },
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
  return {
    fontSize: isValidFontSize(src.fontSize) ? src.fontSize : FONT_SIZE_DEFAULT,
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
  return {
    ...base,
    fontSize: prefs.fontSize,
    session: { ...session, newCommand: prefs.session.newCommand },
    notify: {
      ...notify,
      onDone: prefs.notify.onDone,
      onAwaiting: prefs.notify.onAwaiting,
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
  for (const k of ["session", "notify"] as const) {
    const l = isPlainObject(local[k]) ? local[k] : {};
    const s = isPlainObject(server[k]) ? server[k] : {};
    merged[k] = { ...l, ...s };
  }
  return merged;
}

/** Merge a typed patch into a typed Prefs (deep one level), returns the next. */
export function applyPatch(cur: Prefs, patch: PrefsPatch): Prefs {
  return {
    fontSize: patch.fontSize !== undefined ? patch.fontSize : cur.fontSize,
    session: { ...cur.session, ...(patch.session ?? {}) },
    notify: { ...cur.notify, ...(patch.notify ?? {}) },
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
      ? (input, init) => fetch(input, init)
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
        credentials: "same-origin",
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

  function setPref(patch: PrefsPatch): void {
    const cur = prefs();
    const next = coercePrefs(composeDoc(rawDoc, applyPatch(cur, patch)));
    if (JSON.stringify(next) === JSON.stringify(cur)) return; // no-op
    rawDoc = composeDoc(rawDoc, next);
    setPrefsSignal(next);
    markDirty();
    persist();
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
  }

  async function bootSync(): Promise<void> {
    if (!fetchImpl) return;
    let doc: unknown;
    try {
      const resp = await fetchImpl(apiUrl(PREFS_PATH), {
        credentials: "same-origin",
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
