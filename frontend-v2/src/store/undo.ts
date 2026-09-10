/**
 * The undo stack behind Cmd+Z / Ctrl+Z for the lobby's structural actions
 * (kill, create, retitle, reorder, move, project create/rename/delete, and the
 * per-browser toggles: collapse, watch, mark-seen).
 *
 * This file knows nothing about any of them. It holds a sequence of plain JSON
 * records and hands the top one to the code that knows how to invert it. Five
 * decisions shape everything below.
 *
 * AN ENTRY IS PLAIN JSON, no closures and no class instances. The stack
 * persists to sessionStorage, and a function does not survive
 * JSON.stringify, so the obvious design (an entry carrying its own `undo`
 * lambda) would work until the first reload and then silently hold a stack of
 * entries that cannot do anything. Behaviour therefore lives in a HANDLER,
 * looked up by `kind` at the moment of the press.
 *
 * HANDLERS REGISTER THEMSELVES, from the store that owns the action, via
 * {@link registerUndoHandler} at wiring time. So this module imports nothing
 * from store/lobby.ts and the dependency runs one way only, which is also what
 * keeps biome's `noImportCycles` happy about a store that has to reach back
 * into the lobby to undo a kill.
 *
 * AN ENTRY IS AN INVERSE OPERATION, never a copy of a document. PUT /layout
 * replaces the WHOLE layout and carries no etag or version (store/lobby.ts:705
 * saveLayout), so re-PUTting a layout captured before the action would erase
 * whatever another device did in the meantime. An entry says what to undo, and
 * its handler re-applies that against the layout as it is NOW, or refuses.
 *
 * A REFUSAL DROPS ITS ENTRY. `check` answers "does the world still look like
 * this entry expects", and an entry that says no is removed rather than left at
 * the top of the stack, where it would absorb every further press. The reason
 * travels back to the caller, which is the only thing that toasts: a store that
 * reached for showToast could not be tested without a DOM, and undo is
 * deliberately silent when it works.
 *
 * PER TAB, not per device. sessionStorage rather than localStorage: two tabs
 * hold separate histories (Cmd+Z in one must not undo what you did in the
 * other), a reload keeps yours, and closing the tab is the end of it.
 */
import { type Accessor, createSignal } from "solid-js";
import { type MinStorage, sessionStorageOrNull } from "../lib/storage";
import type {
  MoveEntry,
  OrderModeEntry,
  ProjectCreateEntry,
  ProjectDeleteEntry,
  ProjectRenameEntry,
  ReorderGroupsEntry,
} from "./undo.layout";

/** Where the stack lives. Bump the suffix if the entry shape ever changes. */
export const UNDO_KEY = "tl:undo:v1";

/**
 * How many actions back Cmd+Z reaches. 25 is deep enough to cover a session's
 * worth of tidying and shallow enough that the oldest entry is still about a
 * world the user recognises. The stack is capped on push AND on read, so a
 * document written by a build with a larger cap cannot smuggle in more.
 */
export const UNDO_CAP = 25;

/**
 * What every entry carries, whatever its kind.
 *
 * `session` and `sessions` are a CONVENTION, not decoration: they are the only
 * places a kind may keep a session NAME. tmux-api renames a session as soon as
 * its first title lands (ADR-0022), which happens seconds into the first turn
 * and quite possibly while an entry about that session is on the stack, so
 * {@link UndoStore.carry} rewrites the name under it. It can only rewrite what
 * it can see, and these two fields are what it can see. A kind that hides a
 * name inside a nested object gets a stale entry the first time a title lands.
 *
 * Prefer an `id` (tmux's own session_id, types/lobby.ts:48) for anything that
 * has to survive a rename regardless. `carry` exists for the fields that cannot
 * use one, such as a layout position that is keyed by name.
 */
export interface UndoEntryBase {
  /** Which handler owns this entry. */
  readonly kind: string;
  /** When the action happened, epoch ms from the store's clock. */
  readonly at: number;
  /** The one session this entry is about, where there is one. */
  readonly session?: string;
  /** Every session this entry names, where it names several (a reorder). */
  readonly sessions?: readonly string[];
}

/**
 * One undoable action.
 *
 * A union on `kind`: each batch adds its kind here as an interface extending
 * {@link UndoEntryBase} plus the fields its own handler reads. Keeping the
 * union in this file (rather than an augmentable registry interface) is what
 * makes a `push` of a kind nobody declared a type error.
 *
 * {@link UndoEntryBase} itself stays a member, so `kind` is a string rather
 * than a closed set of literals. That is honest about what the store holds: a
 * document read back from sessionStorage was written by whatever build was
 * running before the reload, and its kinds are not this build's to enumerate
 * (`step` hands one it does not recognise back as a refusal). The types below
 * are imported for their shape only. undo.layout.ts is what registers their
 * handlers, and nothing in this file runs any of them.
 */
export type UndoEntry =
  | UndoEntryBase
  | MoveEntry
  | ReorderGroupsEntry
  | ProjectCreateEntry
  | ProjectRenameEntry
  | ProjectDeleteEntry
  | OrderModeEntry;

/** `Omit` that stays a union as kinds are added, instead of collapsing to one. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry as the CALLER hands it over: everything but the stamp, which the
 *  store's clock owns, so no caller can forget it or disagree about the time. */
export type NewUndoEntry = DistributiveOmit<UndoEntry, "at">;

/**
 * What it takes to undo one kind of action.
 *
 * Declared with method syntax on purpose. TypeScript compares method
 * parameters bivariantly, which is what lets a `UndoHandler<KillEntry>` sit in
 * a registry of `UndoHandler<UndoEntry>` without a cast at either end.
 */
export interface UndoHandler<E extends UndoEntry = UndoEntry> {
  /**
   * null when the entry is still applicable, or a human sentence naming what
   * changed when it is not ("the order changed on another device"). It is asked
   * before an undo AND before a redo, so a handler that needs to tell the two
   * apart reads the live world, which differs at the two moments. The sentence
   * is toasted verbatim by the caller, so write it for a person and start it
   * lower case: it reads after a lead-in.
   */
  check(entry: E): string | null;
  /** Put the world back. Throwing refuses the entry, message and all. */
  undo(entry: E): Promise<void>;
  /** Do it again. Same contract as {@link UndoHandler.undo}. */
  redo(entry: E): Promise<void>;
}

/** kind → handler. A Map so a test can hand in its own and stay isolated. */
export type UndoHandlers = Map<string, UndoHandler>;

/** The app-wide registry, written at wiring time and read at press time. */
const handlers: UndoHandlers = new Map();

/**
 * Teach undo about one kind of action. Called by the store that OWNS the
 * action, at wiring time, so that store keeps its inverse next to its action
 * and this module keeps its ignorance of both.
 *
 * Last registration wins, which makes the call idempotent under a hot reload.
 */
export function registerUndoHandler<E extends UndoEntry>(
  kind: E["kind"],
  handler: UndoHandler<E>,
): void {
  handlers.set(kind, handler);
}

/**
 * What a press came to. `reason` is what the caller toasts; null means there is
 * nothing to say and the press was a no-op (an empty stack, or a lens tab),
 * which is what a browser does with Cmd+Z on an empty history.
 */
export type UndoResult = { ok: true } | { ok: false; reason: string | null };

/** The silent no-op: nothing on this side of the stack, or undo is off here. */
const NOTHING: UndoResult = { ok: false, reason: null };

/** An entry whose kind no longer has a handler. Reachable in one real way: the
 *  tab reloaded onto a build that dropped or renamed that kind, and the stack
 *  outlived it in sessionStorage. */
const STALE_KIND = "that action can no longer be undone";

export interface UndoStore {
  /** Record an action that just happened. Clears the redo stack. */
  push(entry: NewUndoEntry): void;
  undo(): Promise<UndoResult>;
  redo(): Promise<UndoResult>;
  canUndo: Accessor<boolean>;
  canRedo: Accessor<boolean>;
  /** Forget everything, both halves. */
  clear(): void;
  /** Follow a rename: rewrite `fromName` to `toName` wherever an entry on
   *  either stack holds it. See {@link UndoEntryBase} for why. */
  carry(fromName: string, toName: string): void;
}

export interface UndoStoreOptions {
  /**
   * false switches push, undo and redo off, and leaves the stored document
   * untouched rather than clearing it.
   *
   * This is how a lens tab (`?as=bob`) gets no undo. Switching identity is a
   * NAVIGATION in the same tab (lib/act-as.ts), so the sessionStorage a lens
   * page reads was written by the previous identity in that tab: reading it
   * would offer to undo your own actions against somebody else's account, and
   * writing it would hand your next page life bob's history. Neither, so a
   * disabled store never touches the key. A boolean rather than an accessor
   * because ACT_AS is fixed for the page life, for the same reason.
   *
   * Default true.
   */
  enabled?: boolean;
  /** Where the stack persists. null = memory only. Default sessionStorage. */
  storage?: MinStorage | null;
  /** Default `Date.now`. */
  now?: () => number;
  /** Default the module registry {@link registerUndoHandler} writes to. */
  handlers?: UndoHandlers;
}

/** The persisted document: both halves, so a reload can still redo. */
interface Stacks {
  undo: UndoEntry[];
  redo: UndoEntry[];
}

const empty = (): Stacks => ({ undo: [], redo: [] });

/**
 * One stored record, or null when it is not one.
 *
 * Only the shape this module relies on is checked. A kind's own fields are the
 * handler's business, and it has to be ready for a document written by an older
 * build regardless, so validating them here would be a second, staler copy of
 * that check.
 */
function asEntry(v: unknown): UndoEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec.kind !== "string" || rec.kind === "") return null;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return null;
  if ("session" in rec && typeof rec.session !== "string") return null;
  if ("sessions" in rec) {
    if (!Array.isArray(rec.sessions)) return null;
    if (rec.sessions.some((s) => typeof s !== "string")) return null;
  }
  return rec as unknown as UndoEntry;
}

/**
 * One half of the document, or null when any entry in it is not an entry.
 *
 * ALL OR NOTHING per side, deliberately. Elsewhere in the app a corrupt record
 * is dropped and its neighbours kept (store/drafts.ts does exactly that), which
 * is right for a bag of independent values. A stack is not a bag: it is a
 * sequence of inverses, and one with a hole in the middle is not a shorter
 * history, it is a wrong one. An empty stack costs the user their undo depth
 * for this tab; a partial one silently undoes the wrong thing.
 *
 * A MISSING side reads as empty rather than as corruption, which leaves room
 * for a later format to write only what it has.
 */
function readSide(v: unknown): UndoEntry[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: UndoEntry[] = [];
  for (const item of v) {
    const e = asEntry(item);
    if (!e) return null;
    out.push(e);
  }
  return out.slice(-UNDO_CAP);
}

function readStacks(store: MinStorage | null): Stacks {
  if (!store) return empty();
  let raw: string | null = null;
  try {
    raw = store.getItem(UNDO_KEY);
  } catch {
    return empty(); // blocked or partitioned store: this page life has no history
  }
  if (!raw) return empty();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty();
    const doc = parsed as { undo?: unknown; redo?: unknown };
    const undo = readSide(doc.undo);
    const redo = readSide(doc.redo);
    return undo && redo ? { undo, redo } : empty();
  } catch {
    return empty(); // not JSON at all
  }
}

function writeStacks(store: MinStorage | null, stacks: Stacks): void {
  if (!store) return;
  try {
    store.setItem(UNDO_KEY, JSON.stringify(stacks));
  } catch {
    /* quota / private mode / blocked: the stack lives in memory for this page */
  }
}

/** The sentence for a handler that threw, since that is a refusal too. */
function reasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message.trim() : typeof e === "string" ? e.trim() : "";
  return msg || "the change did not go through";
}

export function createUndoStore(opts: UndoStoreOptions = {}): UndoStore {
  const enabled = opts.enabled ?? true;
  // `undefined` means "no opinion" and takes the real store; an explicit null
  // means memory only, which is what a test that cares about nothing else asks
  // for. `??` alone would turn that null back into sessionStorage.
  const store = opts.storage !== undefined ? opts.storage : sessionStorageOrNull();
  const now = opts.now ?? (() => Date.now());
  const registry = opts.handlers ?? handlers;

  const loaded = enabled ? readStacks(store) : empty();
  const [undoable, setUndoable] = createSignal<readonly UndoEntry[]>(loaded.undo);
  const [redoable, setRedoable] = createSignal<readonly UndoEntry[]>(loaded.redo);

  function persist(): void {
    writeStacks(store, { undo: [...undoable()], redo: [...redoable()] });
  }

  function push(entry: NewUndoEntry): void {
    if (!enabled) return;
    setUndoable((cur) => [...cur, { ...entry, at: now() }].slice(-UNDO_CAP));
    // Any new action invalidates the forward history, exactly as a text editor
    // does: what the redo entries describe is no longer the world they left.
    setRedoable([]);
    persist();
  }

  /**
   * One press, either direction. The two are mirror images (pop one side, apply
   * the entry, land it on the other), and writing them twice is how the two
   * halves of an undo/redo pair drift apart.
   */
  async function step(dir: "undo" | "redo"): Promise<UndoResult> {
    if (!enabled) return NOTHING;
    const from = dir === "undo" ? undoable : redoable;
    const setFrom = dir === "undo" ? setUndoable : setRedoable;
    const setTo = dir === "undo" ? setRedoable : setUndoable;
    const stack = from();
    const entry = stack[stack.length - 1];
    if (!entry) return NOTHING;
    // Off the stack FIRST, whatever happens next. A refused entry that stayed
    // on top would swallow every further press, and the whole point of dropping
    // it is that the next press reaches the entry below.
    //
    // Popping before the first `await` is also what makes two fast presses
    // safe: the second one reads a stack the first has already shortened, so it
    // takes the entry below rather than applying the same one twice.
    setFrom(stack.slice(0, -1));
    const handler = registry.get(entry.kind);
    if (!handler) {
      persist();
      return { ok: false, reason: STALE_KIND };
    }
    try {
      const blocked = handler.check(entry);
      if (blocked) {
        persist();
        return { ok: false, reason: blocked };
      }
      await (dir === "undo" ? handler.undo(entry) : handler.redo(entry));
    } catch (e) {
      persist();
      return { ok: false, reason: reasonOf(e) };
    }
    setTo((cur) => [...cur, entry].slice(-UNDO_CAP));
    persist();
    return { ok: true };
  }

  function clear(): void {
    if (!enabled) return;
    setUndoable([]);
    setRedoable([]);
    persist();
  }

  function carry(fromName: string, toName: string): void {
    if (!enabled || fromName === toName) return;
    let touched = false;
    const rewrite = (list: readonly UndoEntry[]): readonly UndoEntry[] =>
      list.map((e) => {
        const one = e.session === fromName;
        const many = e.sessions?.includes(fromName) ?? false;
        if (!one && !many) return e;
        touched = true;
        return {
          ...e,
          ...(one ? { session: toName } : null),
          ...(many ? { sessions: e.sessions?.map((s) => (s === fromName ? toName : s)) } : null),
        };
      });
    const nextUndo = rewrite(undoable());
    const nextRedo = rewrite(redoable());
    // Nothing named that session, so nothing is written: a poll that carries a
    // rename runs on every list change, and a setter that fires regardless
    // would repaint the undo affordance for every one of them.
    if (!touched) return;
    setUndoable(nextUndo);
    setRedoable(nextRedo);
    persist();
  }

  return {
    push,
    undo: () => step("undo"),
    redo: () => step("redo"),
    canUndo: () => undoable().length > 0,
    canRedo: () => redoable().length > 0,
    clear,
    carry,
  };
}
