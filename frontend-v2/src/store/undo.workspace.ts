/**
 * The inverse of every structural change to a Workspace: a tile added, a tile
 * closed, a tile dragged somewhere else, and a divider moved.
 *
 * ONE KIND FOR ALL FOUR, which is not laziness. A Workspace is one object split
 * across two stores (ADR-0027) and every one of those four gestures writes to
 * BOTH halves in the same breath: this device's split tree, and the server's
 * ordered membership. An entry per gesture would be four copies of that pair of
 * writes, differing only in which tree they hand over — so the entry carries the
 * arrangement either side of the action and the four gestures collapse into
 * one. {@link opOf} recovers which gesture it was from the two trees, for the
 * refusal sentence, so no caller can classify its own action wrongly.
 *
 * THE MEMBERSHIP HALF IS A TRUE INVERSE, the geometry half is a restore, and the
 * two are not the same kind of thing:
 *
 *   - `PUT /api/workspaces` replaces the whole document and carries no version
 *     (lib/lobby-api.ts putWorkspaces), exactly like `PUT /layout`. So an undo
 *     that re-PUT a captured document would erase a workspace somebody made on
 *     their phone. {@link WorkspaceUndoPorts.apply} is handed ONE workspace's
 *     new state and folds it into the document as it is right now.
 *   - The split tree is this browser's alone, under `tl:workspaces:v1`, with no
 *     other writer than another tab on the same device — which re-reads on the
 *     `storage` event (store/workspaces.ts). Restoring it wholesale is the same
 *     move `undo.layout.ts`'s orderMode entry makes for a frozen layout, and is
 *     guarded the same way: {@link check} refuses unless the live arrangement is
 *     still one of the two ends this entry describes.
 *
 * NO NAME IS EVER BURIED IN A NESTED NODE, and that is the rule this file exists
 * to keep. store/undo.ts states it: `session` and `sessions` are the only two
 * places a kind may keep a session NAME, because tmux renames a session as soon
 * as its first title lands (ADR-0022) — seconds into the first turn, and quite
 * possibly while an entry about that session sits on the stack — and
 * `UndoStore.carry` can only rewrite what it can see. A split tree keeps its
 * tiles in nested leaves, which `carry` walks straight past. So the stored tree
 * holds INDICES and `sessions` holds the names, one flat array in reading order,
 * the way `ProjectDeleteEntry` keeps a project's members. A rename rewrites the
 * array; the indices go on pointing at the same tiles; nothing is stranded.
 *
 * RESIZE ENTRIES COALESCE, and the stack's depth is why. `UNDO_CAP` is 25, and a
 * divider dragged across a screen reports forty rows of fractions a second — so
 * one drag would fill the whole stack and Cmd+Z would walk back through a
 * hundred milliseconds of pointer movement instead of undoing the close before
 * it. {@link createWorkspaceUndo} holds a resize back for
 * {@link RESIZE_COALESCE_MS}, folds every further resize of the same workspace
 * into it, and pushes one entry spanning the whole drag. A drag at a junction
 * moves two axes and therefore two splits in the same frame; both land in that
 * one entry, because the entry carries the tree rather than a path.
 *
 * Refusal messages are sentences a person reads after a lead-in, so they start
 * lower case and name what changed rather than what the code found.
 */
import { keyOf } from "./keepalive";
import {
  type Direction,
  leafKeys,
  type SessionKey,
  sessionOf,
  split,
  type TreeNode,
} from "./workspace-tree";
import {
  registerUndoHandler,
  type UndoEntryBase,
  type UndoHandler,
  type UndoHandlers,
  type UndoStore,
} from "./undo";

/**
 * A tile, or a row or column of them, as an entry stores it.
 *
 * A number is a tile: an INDEX into the entry's `sessions` array, never a name.
 * See the file docblock — a name inside a nested node is a name `carry` cannot
 * follow across a rename, and every tile in this app is renamed within seconds
 * of being created.
 *
 * The split form mirrors `Split` minus the discriminant, which a shape this
 * small does not need: an array is a number or it is not.
 */
export type StoredNode =
  | number
  | {
      readonly dir: Direction;
      readonly children: readonly StoredNode[];
      readonly fractions: readonly number[];
    };

/** Which of the four gestures an entry describes. Derived from its two trees
 *  ({@link opOf}), so it is a reading of the entry rather than a second claim
 *  about it that could disagree. */
export type WorkspaceOp = "add" | "remove" | "move" | "resize";

/**
 * One structural change to one Workspace.
 *
 * `before` and `after` are the arrangement either side of the action, and null
 * at either end is a real state rather than a missing value: `before: null` is
 * the first split, which is how a workspace comes into existence at all, and
 * `after: null` is the close that took it back down to a single tile, which is
 * how one ends. Undo hands `before` back, redo hands `after` back, and the
 * handler makes both writes for whichever it is given.
 */
export interface WorkspaceEntry extends UndoEntryBase {
  readonly kind: "workspace";
  /** Which gesture this was, for the refusal sentence alone. */
  readonly op: WorkspaceOp;
  /** The workspace's id. Minted by the client at the first split and kept for
   *  the life of the group, so an undo re-creates the SAME workspace rather
   *  than a look-alike with a new id. */
  readonly id: string;
  /**
   * Every session name either tree holds, in `before`'s reading order with
   * anything only `after` has appended.
   *
   * FLAT, and the one place a name lives. `StoredNode`'s tiles index into this
   * array, so `UndoStore.carry` rewriting an entry here moves every tile that
   * names that session at once.
   */
  readonly sessions: readonly string[];
  /** The arrangement before the action; null when there was no workspace. */
  readonly before: StoredNode | null;
  /** The arrangement after it; null when the workspace ended. */
  readonly after: StoredNode | null;
}

/** What the inverses need from the shell that owns the two stores. */
export interface WorkspaceUndoPorts {
  /** This device's arrangement for one workspace, or null when it holds none
   *  — which is also the answer for a workspace that has ended. */
  tree(id: string): TreeNode | null;
  /**
   * Which workspace the SERVER says holds this session, or null for none.
   *
   * The server's document rather than this device's geometry, because a session
   * can be a member of a workspace this browser has never arranged. It is what
   * the exclusivity rule is written against: a session belongs to at most one
   * workspace, so an entry naming a session that has since been dragged into
   * another one is describing a world that has moved on.
   */
  workspaceOf(session: string): string | null;
  /**
   * THE ONE WRITE, both halves of a Workspace together: this device's
   * arrangement, and the ordered membership the server keeps. `null` ends the
   * workspace — forget the arrangement here, delete the group there.
   *
   * Rejects with a sentence when the server refuses, which the stack toasts
   * verbatim.
   */
  apply(id: string, tree: TreeNode | null): Promise<void>;
}

/** How long a divider drag may pause before the next move counts as a new
 *  action. 600 ms is long enough to cover a hand repositioning mid-drag and
 *  short enough that two deliberate resizes a second apart stay two entries. */
export const RESIZE_COALESCE_MS = 600;

const WORKSPACE_MOVED = "the tiles have moved since";
const SESSION_ELSEWHERE = "that session is in another workspace now";

/** What a refused server write says. Exported so the shell's `apply` rejects
 *  with the same words the handler would have, and there is one sentence for
 *  one failure rather than two that drift. */
export const WORKSPACE_SAVE_FAILED = "the workspace write did not go through";

// ---------------------------------------------------------------------------
// Freezing a tree into an entry, and thawing it back out
// ---------------------------------------------------------------------------

/** A session's keepalive key from the name an entry stores. Workspace members
 *  are always the caller's own sessions (types/lobby.ts `Workspace.members`),
 *  so there is no owner to carry and `keyOf` composes the same string the slot
 *  layer and the tree are both keyed by. */
const keyFor = (name: string): SessionKey => keyOf({ name });

/**
 * The names a pair of trees mentions, in a stable order: `before`'s tiles in
 * reading order, then anything only `after` holds.
 *
 * Deterministic on purpose. The indices stored in the trees are offsets into
 * this array, so the order is part of the entry's meaning and must not depend
 * on a Set's iteration order or on which tree was walked first.
 */
export function namesOf(before: TreeNode | null, after: TreeNode | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tree of [before, after]) {
    if (!tree) continue;
    for (const key of leafKeys(tree)) {
      const name = sessionOf(key).name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** A live tree as an entry stores it: tiles become indices into `names`. */
export function freeze(tree: TreeNode, names: readonly string[]): StoredNode {
  if (tree.kind === "leaf") return names.indexOf(sessionOf(tree.key).name);
  return {
    dir: tree.dir,
    children: tree.children.map((child) => freeze(child, names)),
    fractions: [...tree.fractions],
  };
}

/**
 * A stored tree back as a live one, or null when it cannot be trusted.
 *
 * Refused whole rather than repaired. An index outside the array means the
 * entry was written by a build whose `sessions` was shaped differently, and
 * dropping one tile out of an arrangement would put a workspace on screen that
 * nobody ever arranged — worse than refusing the press and saying so.
 */
export function thaw(node: StoredNode, names: readonly string[]): TreeNode | null {
  if (typeof node === "number") {
    const name = names[node];
    return name === undefined ? null : { kind: "leaf", key: keyFor(name) };
  }
  if (!node || typeof node !== "object" || !Array.isArray(node.children)) return null;
  if (node.dir !== "row" && node.dir !== "column") return null;
  if (!Array.isArray(node.fractions)) return null;
  const children: TreeNode[] = [];
  for (const child of node.children) {
    const kept = thaw(child, names);
    if (!kept) return null;
    children.push(kept);
  }
  if (children.length < 2) return null;
  return split(node.dir, children, node.fractions);
}

/**
 * The tiles and the shape, with the sizes left out — what {@link check}
 * compares the live arrangement against.
 *
 * SIZES ARE DELIBERATELY NOT IN IT. A divider dragged since a tile was closed is
 * not a reason to refuse the undo of that close, and refusing there would make
 * the stack useless in exactly the workspace somebody is working in. What the
 * restore then costs is the sizes: putting `before` back puts its fractions back
 * with it. That is what an undo of a structural change means, and the resize it
 * walks over has its own entry one press further down.
 */
export function tilingOf(tree: TreeNode | null): string {
  if (!tree) return "-";
  if (tree.kind === "leaf") return tree.key;
  const dir = tree.dir === "row" ? "r" : "c";
  return `${dir}(${tree.children.map(tilingOf).join(",")})`;
}

/**
 * Which gesture produced this pair of trees.
 *
 * Read off the trees rather than taken from the caller. A workspace edit is one
 * write with one before and one after, and a caller that labelled a drop
 * "add" when it had in fact moved a tile would put a sentence on screen that
 * contradicted what the person just did.
 *
 * A drop onto a tile's middle replaces what was there: one session arrives and
 * another leaves in the same gesture. It reads as `move` when the arriving
 * session already had a tile and as `add` when it came from the sidebar, which
 * is what the person did with the thing they were holding.
 */
export function opOf(before: TreeNode | null, after: TreeNode | null): WorkspaceOp {
  if (!before) return "add";
  if (!after) return "remove";
  const was = new Set(leafKeys(before));
  const now = new Set(leafKeys(after));
  const arrived = [...now].some((key) => !was.has(key));
  const left = [...was].some((key) => !now.has(key));
  if (arrived) return "add";
  if (left) return "remove";
  return tilingOf(before) === tilingOf(after) ? "resize" : "move";
}

/** The one session an action is about, or undefined when it is about several
 *  (a replace) or about none (a resize). Lives in the base `session` field, so
 *  a rename is carried under it like any other. */
function subjectOf(before: TreeNode | null, after: TreeNode | null): string | undefined {
  const was = before ? leafKeys(before) : [];
  const now = after ? leafKeys(after) : [];
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const changed = [...now.filter((k) => !wasSet.has(k)), ...was.filter((k) => !nowSet.has(k))];
  const [only] = changed;
  if (changed.length === 1 && only !== undefined) return sessionOf(only).name;
  // Neither set changed, so this is a move or a resize: a move names the tile
  // that travelled, which is the one whose PATH changed and whose neighbours
  // did not — not recoverable from the key sets, and not worth a second field.
  return undefined;
}

/** The entry a change would be recorded as. Exported for the recorder below and
 *  for tests that want the record without a stack to push it onto. */
export function workspaceEntry(
  id: string,
  before: TreeNode | null,
  after: TreeNode | null,
): Omit<WorkspaceEntry, "at"> {
  const sessions = namesOf(before, after);
  const subject = subjectOf(before, after);
  return {
    kind: "workspace",
    op: opOf(before, after),
    id,
    sessions,
    ...(subject === undefined ? null : { session: subject }),
    before: before ? freeze(before, sessions) : null,
    after: after ? freeze(after, sessions) : null,
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** The arrangement an entry's end describes, live: thawed, and clamped to the
 *  screen it is going back onto. Null for "there is no workspace at this end",
 *  and for a stored tree this build cannot read. */
function treeAt(entry: WorkspaceEntry, end: "before" | "after"): TreeNode | null {
  const stored = entry[end];
  return stored === null ? null : thaw(stored, entry.sessions);
}

/** Is the live arrangement still the one this end of the entry describes? */
function standsAt(
  ports: WorkspaceUndoPorts,
  entry: WorkspaceEntry,
  end: "before" | "after",
): boolean {
  const want = entry[end];
  const live = ports.tree(entry.id);
  // A null end means "no workspace here", which the live side answers with a
  // null tree. Comparing tilings would make those two agree for the wrong
  // reason, since `tilingOf(null)` is a sentinel rather than a shape.
  if (want === null || live === null) return want === null && live === null;
  return tilingOf(treeAt(entry, end)) === tilingOf(live);
}

function workspaceHandler(ports: WorkspaceUndoPorts): UndoHandler<WorkspaceEntry> {
  return {
    check(entry) {
      // BOTH ENDS PASS, because `check` is asked before an undo AND before a
      // redo and cannot see which way it is about to run (store/undo.ts
      // UndoHandler). The arrangement on screen is `after` while the undo is
      // pending and `before` once it has run, and either is a world this entry
      // still describes. Anything else — a tile closed since, a divider drag
      // that re-nested nothing but a device that re-entered the workspace and
      // auto-arranged it — is a world the restore would overwrite.
      if (!standsAt(ports, entry, "before") && !standsAt(ports, entry, "after")) {
        return WORKSPACE_MOVED;
      }
      // The exclusivity rule is the server's, and it is the one thing this
      // entry cannot put back by itself: a session dragged into another
      // workspace since belongs to that one, and restoring this arrangement
      // would ask tmux-api for a document where two workspaces claim it. The
      // server refuses such a document outright, so this is the same refusal
      // said early and in words a person can act on.
      for (const name of entry.sessions) {
        const holder = ports.workspaceOf(name);
        if (holder !== null && holder !== entry.id) return SESSION_ELSEWHERE;
      }
      return null;
    },
    async undo(entry) {
      await ports.apply(entry.id, treeAt(entry, "before"));
    },
    async redo(entry) {
      await ports.apply(entry.id, treeAt(entry, "after"));
    },
  };
}

/** The workspace inverse, keyed by kind. A Map so a test can hand its own
 *  registry to createUndoStore and stay isolated from the module-wide one. */
export function workspaceUndoHandlers(ports: WorkspaceUndoPorts): UndoHandlers {
  return new Map<string, UndoHandler>([["workspace", workspaceHandler(ports)]]);
}

/** Teach the app-wide registry about it. Called at wiring time from the shell,
 *  which is the only thing holding both halves of a Workspace. */
export function registerWorkspaceUndoHandler(ports: WorkspaceUndoPorts): void {
  for (const [kind, handler] of workspaceUndoHandlers(ports)) registerUndoHandler(kind, handler);
}

// ---------------------------------------------------------------------------
// Recording, and the coalescing a divider drag needs
// ---------------------------------------------------------------------------

export interface WorkspaceRecorder {
  /**
   * A workspace changed from `before` to `after`. Either may be null; both
   * being null, or the two describing the same arrangement, records nothing.
   *
   * A resize is held back and folded into whatever resize follows it, so one
   * divider drag is one entry. Everything else lands at once, after flushing
   * any resize still in the air — an action taken after a drag goes on the
   * stack above it, not underneath it.
   */
  record(id: string, before: TreeNode | null, after: TreeNode | null): void;
  /** Push a held-back resize now. Called by the shell before anything else a
   *  person does deliberately, and on the way out. */
  flush(): void;
  dispose(): void;
}

/**
 * Record workspace changes onto a stack, coalescing divider drags.
 *
 * `timers` is the pair the coalescing needs, injectable so a test can drive the
 * clock without waiting 600 ms of real time. The defaults are the window's.
 */
export function createWorkspaceUndo(
  undo: Pick<UndoStore, "push">,
  opts: {
    coalesceMs?: number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  } = {},
): WorkspaceRecorder {
  const quiet = opts.coalesceMs ?? RESIZE_COALESCE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));

  /** The resize being folded into, or null between drags. `before` is the
   *  arrangement the drag STARTED from and never moves; `after` is wherever the
   *  divider has reached. */
  let pending: { id: string; before: TreeNode; after: TreeNode } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const held = pending;
    pending = null;
    if (!held) return;
    // A drag that ended where it started asks for nothing, and an entry for it
    // would make the next Cmd+Z look like it did nothing at all.
    if (tilingOf(held.before) === tilingOf(held.after) && sameSizes(held.before, held.after))
      return;
    undo.push(workspaceEntry(held.id, held.before, held.after));
  }

  function record(id: string, before: TreeNode | null, after: TreeNode | null): void {
    if (!before && !after) return;
    if (before && after && opOf(before, after) === "resize") {
      // Same workspace, drag still warm: keep the `before` this drag started
      // from and move its far end. Different workspace means the person left
      // one and resized another, which is two actions.
      if (pending && pending.id === id) pending = { id, before: pending.before, after };
      else {
        flush();
        pending = { id, before, after };
      }
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, quiet);
      return;
    }
    flush();
    undo.push(workspaceEntry(id, before, after));
  }

  return {
    record,
    flush,
    dispose: () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Do two arrangements of the same shape also hold the same sizes? Only asked
 *  about a resize, where the shape is equal by definition and the fractions are
 *  the whole of what moved. The tolerance is corvu's rounding: it fixes every
 *  size it computes to six decimal places, so a row that made the round trip
 *  through it comes back a few times 1e-7 from the one we sent. */
function sameSizes(a: TreeNode, b: TreeNode): boolean {
  if (a.kind === "leaf" || b.kind === "leaf") return a.kind === b.kind;
  if (a.children.length !== b.children.length) return false;
  if (a.fractions.some((f, i) => Math.abs(f - (b.fractions[i] ?? 0)) > 1e-6)) return false;
  return a.children.every((child, i) => {
    const other = b.children[i];
    return other !== undefined && sameSizes(child, other);
  });
}
