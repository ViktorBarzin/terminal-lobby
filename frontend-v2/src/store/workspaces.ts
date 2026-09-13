import { type Accessor, createSignal } from "solid-js";
import { lsGet, lsSet } from "../lib/storage";
import type { SessionKey, TreeNode } from "./workspace-tree";

/**
 * The per-device half of a Workspace: which arrangement THIS BROWSER holds for
 * each workspace, and nothing about who belongs to one.
 *
 *   tl:workspaces:v2   workspace id → the serialised split tree, and when
 *                      the server last listed the workspace it belongs to
 *
 * ADR-0027 splits a workspace across two stores and this is the smaller half.
 * Membership — the id and its ordered members — lives in tmux-api beside
 * `layout/<user>.json`, because it is durable intent that changes what the
 * sidebar does and what a restore puts back, and because two tabs on one
 * machine have to agree about it. The tree and the tile sizes stay here,
 * because a four-column arrangement describes a 32-inch monitor, is meaningless
 * on a laptop and is unrenderable on a phone, which sees no workspaces at all.
 * A device with no entry for a workspace is not broken: it auto-arranges the
 * members evenly in the server's member order, and the first drag makes the
 * arrangement its own.
 *
 * So there is no membership here. Not a member list, not an ordering, not a
 * mirror of one kept "for offline". The server's document is the only answer to
 * which sessions belong together, and a copy of it under this key would be a
 * second answer that goes stale the first time another device writes.
 *
 * One JSON document under one key, read and written through `lsGet`/`lsSet` and
 * validated entry by entry, the way `store/drafts.ts` and `store/visits.ts` do.
 * The alternative — a key per workspace — spreads one consistency rule (a
 * session belongs to at most one workspace) across as many documents as there
 * are workspaces, with no way to write them together.
 *
 * VERSIONING IS THE KEY SUFFIX, NOT A FIELD IN THE DOCUMENT. `store/undo.ts:55`
 * states the rule as "Bump the suffix if the entry shape ever changes", and
 * `store/device-prefs.ts:23` says the consequence outright: nothing here had a
 * migration path, and no store in this codebase had ever had one. v2 is that
 * first migration, written on 2026-09-13 when the entry grew its timestamp: the
 * old key is read when the new one is absent, each tree adopted and stamped as
 * last listed now, and `tl:workspaces:v1` removed by the first write. The
 * alternative was the bare bump this paragraph used to describe, which
 * abandons every device's arrangements — the exact loss the timestamp is here
 * to prevent, so paying it to ship the prevention would have been an odd trade.
 *
 * WHAT THE TIMESTAMP IS FOR. `seen` is the last time the SERVER's membership
 * document listed this workspace, and {@link prune} deletes an entry only once
 * that is {@link ARRANGEMENT_TTL_MS} old. Before 2026-09-13 an id missing from
 * one answer was deleted on the spot, and Viktor lost a laptop's arrangement to
 * a five-minute window in which a verification run on the devvm had replaced
 * the document: the workspace came back, the arrangement could not, because the
 * server never had it. An id the server stops listing is ABSENT, and absence is
 * only conclusive after a month. The reason prune exists is still served — the
 * document cannot grow without bound — it just stops throwing away work to save
 * a few hundred bytes the same hour.
 *
 * THE SESSION-TO-WORKSPACE REVERSE LOOKUP IS DERIVED, NEVER STORED. It is what
 * makes clicking a sidebar member open its group, so it is read on every
 * sidebar paint and is tempting to keep beside the document as a second key. It
 * is not: two keys can disagree, and the disagreement surfaces as a click that
 * enters a workspace the session is no longer in. {@link load} builds the index
 * from the one document, and every write rebuilds the part of it that moved.
 *
 * THE TREE ARRIVES AS TWO INJECTED FUNCTIONS rather than as an import. This
 * module owns the DOCUMENT and never looks inside a node; what it needs to know
 * is whether a persisted value is a well-formed tree and which sessions are in
 * one, and both of those are the tree layer's knowledge. Injecting them keeps
 * the node shape out of this file entirely, so a change to rows, columns or
 * fractions costs nothing here, and it lets the whole store be tested with no
 * tree and no DOM. The TYPE is imported rather than restated, so the two halves
 * cannot drift and `tsc` says so if they try. App wires the real pair in one
 * line:
 *
 *     createWorkspacesStore({ parseTree, sessionsOf: leafKeys })
 *
 * `leafKeys` is `store/workspace-tree.ts`'s own reading-order walk. `parseTree`
 * is the one piece that module does not have yet: it builds and transforms
 * trees it already trusts, and nothing there takes an `unknown`. Until it grows
 * one, the only `unknown` a tree is ever read from is this store's document, so
 * the parser belongs beside `TreeNode` rather than here — restating the node
 * shape in this file is exactly the drift the injected type avoids.
 *
 * A session is identified by keepalive's key, `owner\0name` from `keyOf`, which
 * is what `SessionKey` is and why two people's `auth` are two sessions. Opaque
 * here: this store compares keys and never takes one apart.
 */

/** Where the arrangements live. Bump the suffix if the entry's shape changes,
 *  and read what that costs — and what it takes to not pay it — above. */
export const WORKSPACES_KEY = "tl:workspaces:v2";

/** The shape v2 replaced: `id → tree`, with no record of when the workspace was
 *  last seen. Read once, when v2 is absent; removed by the first write. */
export const WORKSPACES_KEY_V1 = "tl:workspaces:v1";

/**
 * How long this device keeps an arrangement for a workspace the server has
 * stopped listing.
 *
 * A month, and the number is chosen from what it protects rather than from what
 * it costs. An id vanishes from the document for two reasons: somebody closed
 * the workspace back to a single tile on another device, which is permanent and
 * only wants the entry gone eventually; or the document was briefly wrong — a
 * write from another tab, a restore, a script on the box — which is transient
 * and wants the arrangement back. The first is indifferent to the wait. The
 * second is not, and a person notices a lost arrangement immediately and comes
 * back to it days later, so the window has to cover a weekend and a holiday
 * rather than a poll.
 *
 * An entry is a few hundred bytes, so a month of them is not a quota concern on
 * any browser this app runs in.
 */
export const ARRANGEMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale a stamp gets before {@link prune} writes a fresher one.
 *
 * The effect that calls prune runs on every change to the membership document,
 * so stamping on each would put a `localStorage` write behind every poll to buy
 * an hour of precision on a month-long window. An hour of slack costs nothing
 * an entry's lifetime can notice.
 */
const STAMP_EVERY_MS = 60 * 60 * 1000;

/**
 * The two questions this store asks `store/workspace-tree.ts`.
 *
 * `parseTree` is the gate on everything read back from storage: a value it
 * refuses is dropped rather than handed on, so a half-written document costs
 * one arrangement instead of taking the workspace down. `sessionsOf` is how the
 * reverse lookup and the exclusivity rule see a tree at all — order does not
 * matter here, and a session is an opaque string, so this file never learns
 * what a tile is.
 *
 * Both are required rather than defaulted. A default `parseTree` would have to
 * be either the real validator, which is the import this injection exists to
 * avoid, or a permissive stand-in that accepts malformed documents — and a
 * validator that says yes to everything is worse than none, because it puts the
 * corruption on screen instead of dropping it.
 */
export interface WorkspacesDeps {
  /** A persisted value read back as a tree, or null for anything else. */
  parseTree(value: unknown): TreeNode | null;
  /** `leafKeys`: one keepalive key per tile in the tree. */
  sessionsOf(tree: TreeNode): readonly SessionKey[];
  /**
   * The same tree without those sessions' tiles, or null when none are left.
   *
   * `removeAt` applied once per session, which is what App wires in. It is here
   * for one job: a session dragged into workspace B has to stop being a tile in
   * workspace A, and until 2026-09-13 this store answered that by throwing A's
   * whole arrangement away — it could not edit a tree out without learning the
   * node shape it deliberately does not know, and leaving A claiming the session
   * would put the document in the state `load()` has to drop both entries to
   * resolve. Injected, that third option exists: A loses the tile and keeps
   * everything else, which is what it looks like on screen anyway.
   */
  without(tree: TreeNode, sessions: readonly SessionKey[]): TreeNode | null;
}

export interface WorkspacesStore {
  /** Every workspace this device holds an arrangement for, oldest entry first. */
  ids(): readonly string[];
  /**
   * This device's arrangement for one workspace, or null when it has never seen
   * it — the signal to auto-arrange from the server's member order.
   *
   * The tree handed back is the stored one, not a copy. Every operation in
   * `store/workspace-tree.ts` is pure and returns a new tree, so nothing has a
   * reason to mutate this one, and cloning on every read would be paid on every
   * paint of a workspace to defend against a caller that does not exist.
   */
  treeFor(id: string): TreeNode | null;
  /** Which workspace holds this session, by keepalive key, or null. */
  workspaceOf(sessionKey: SessionKey): string | null;
  /**
   * Persist one workspace's arrangement, replacing whatever was there.
   *
   * A tree holding no sessions removes the entry instead, the way an empty
   * draft does in `store/drafts.ts`: a workspace of nothing cannot be entered
   * and cannot be looked up, so an entry for it is a row that only ever ages.
   */
  setTree(id: string, tree: TreeNode): void;
  /** Forget one workspace's arrangement (closed back to a single tile). */
  forget(id: string): void;
  /**
   * Note which workspaces the server still lists, and drop the arrangements of
   * the ones it has not listed for {@link ARRANGEMENT_TTL_MS}.
   *
   * An EMPTY list is "I do not know yet", never "you have no workspaces" — the
   * same guard `store/drafts.ts` and `store/visits.ts` need. A poll in flight or
   * a briefly unreachable tmux-api would otherwise wipe every arrangement on the
   * device, and there is nowhere to recover them from.
   *
   * A SINGLE ANSWER IS NOT A DELETION either, which is the 2026-09-13 change:
   * an id missing from this list is stamped-nothing and kept, so a document that
   * is briefly wrong costs nothing. Only the calendar deletes.
   */
  prune(live: readonly string[]): void;
  /** Bumps on every change, so memos reading the three getters re-run. */
  version: Accessor<number>;
  /** Stop following the other tabs on this device. */
  dispose(): void;
}

/** One workspace's row on disk: the arrangement, and when the server last said
 *  the workspace it belongs to still exists. */
interface Entry {
  tree: TreeNode;
  seen: number;
}

/** A parsed object document, or {} for absent, corrupt or foreign-shaped
 *  storage. Shared by both key versions, which differ only in what the VALUES
 *  are. */
function readObject(key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(lsGet(key) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // private mode / corrupt entry
  }
}

/**
 * Every stored row as `[id, tree-shaped value, seen]`, in document order.
 *
 * Reads v2, or adopts v1 when v2 is absent. NOTHING IS WRITTEN HERE. A read
 * stays pure the way the rest of this store keeps it, so a tab that opens and
 * touches no workspace writes no storage; the promotion happens on the first
 * real write, which is where {@link persist} removes the old key. A device that
 * never writes keeps answering out of v1 forever, which is the same answer.
 *
 * A ROW WITH NO USABLE STAMP IS STAMPED NOW, never dropped and never treated as
 * ancient. The stamp only decides when an unlisted workspace ages out, so the
 * safe direction for a truncated write or a foreign build is the one that keeps
 * the arrangement and starts its clock again.
 */
function readRows(now: number): [string, unknown, number][] {
  const v2 = readObject(WORKSPACES_KEY);
  const rows: [string, unknown, number][] = [];
  if (Object.keys(v2).length > 0) {
    for (const [id, value] of Object.entries(v2)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as { tree?: unknown; seen?: unknown };
      const seen = typeof entry.seen === "number" && Number.isFinite(entry.seen) ? entry.seen : now;
      rows.push([id, entry.tree, seen]);
    }
    return rows;
  }
  for (const [id, tree] of Object.entries(readObject(WORKSPACES_KEY_V1))) {
    rows.push([id, tree, now]);
  }
  return rows;
}

/**
 * Reactive geometry store for this browser.
 *
 * The document is held in memory after the first read and written back on every
 * change, rather than re-read per call the way `store/drafts.ts` does it. The
 * reverse index decides that: rebuilding it per call would walk every tree on
 * every sidebar paint. What a per-call read buys instead is agreement between
 * two tabs, and the `storage` listener below buys that back without the walk.
 */
export function createWorkspacesStore(deps: WorkspacesDeps): WorkspacesStore {
  const [version, setVersion] = createSignal(0);
  /** id → arrangement and its stamp, in the order the entries were first seen. */
  let doc = new Map<string, Entry>();
  /** session key → id. Rebuilt with `doc`, and written to by nothing else. */
  let index = new Map<SessionKey, string>();

  /**
   * Rebuild both maps from storage, dropping every entry that cannot be trusted.
   *
   * Three things get an entry dropped, and all three are cheap to pay because
   * the workspace itself survives on the server and re-arranges on next entry:
   *
   *   - the tree layer refuses it (a foreign build, a truncated write);
   *   - it names the same session twice, which no DOM can render — keepalive
   *     mounts exactly one live view per session, keyed owner and name;
   *   - it shares a session with ANOTHER entry, which breaks the rule that a
   *     session belongs to at most one workspace.
   *
   * The third case drops EVERY entry in the conflict rather than picking a
   * winner. A document written by this store never contains one, so reaching
   * here means a write interrupted part-way or a document edited by hand, and
   * neither leaves evidence of which claim was the newer intent. Preferring
   * whichever entry the key order happens to put first would answer
   * `workspaceOf` with a coin toss — and a coin toss is what a person sees when
   * a click opens the wrong group, differently after each reload.
   *
   * The repair is deliberately NOT written back here. A read stays pure, the
   * way `store/drafts.ts` keeps it, and the dropped entries leave storage with
   * the next write. Rewriting at construction would put a storage write on
   * every tab open, including the tabs that have no workspaces at all.
   */
  function load(): void {
    doc = new Map();
    index = new Map();
    const kept = new Map<string, { entry: Entry; sessions: readonly SessionKey[] }>();
    /** how many surviving entries claim each session. */
    const claims = new Map<SessionKey, number>();
    for (const [id, value, seen] of readRows(Date.now())) {
      if (!id) continue; // an entry nothing could ever ask for
      const parsed = deps.parseTree(value);
      if (parsed === null) continue;
      const sessions = deps.sessionsOf(parsed);
      if (sessions.length === 0) continue;
      if (new Set(sessions).size !== sessions.length) continue;
      kept.set(id, { entry: { tree: parsed, seen }, sessions });
      for (const session of sessions) claims.set(session, (claims.get(session) ?? 0) + 1);
    }
    for (const [id, held] of kept) {
      if (held.sessions.some((s) => (claims.get(s) ?? 0) > 1)) continue;
      doc.set(id, held.entry);
      for (const session of held.sessions) index.set(session, id);
    }
  }

  /** Mirror the in-memory document to storage, and retire the old key the first
   *  time a migrated document is written back. A refused write costs the
   *  arrangement and nothing else, so `lsSet` swallowing it is the behaviour
   *  this store wants: the tab keeps rendering what it already has. */
  function persist(): void {
    lsSet(WORKSPACES_KEY, JSON.stringify(Object.fromEntries(doc)));
    // AFTER the new key, never before: a write that fails on quota leaves v1
    // standing rather than leaving the device with neither.
    if (lsGet(WORKSPACES_KEY_V1) !== null) lsSet(WORKSPACES_KEY_V1, null);
  }

  /** Take one workspace out of both maps. True when there was one to take. */
  function drop(id: string): boolean {
    const held = doc.get(id);
    if (held === undefined) return false;
    for (const session of deps.sessionsOf(held.tree)) {
      if (index.get(session) === id) index.delete(session);
    }
    doc.delete(id);
    return true;
  }

  /**
   * Take named sessions out of a workspace that is about to lose them, keeping
   * the rest of its arrangement.
   *
   * The entry KEEPS ITS PLACE in the document: `Map.set` on a key that is
   * already there does not move it, so `ids()` still reads oldest first. That is
   * the whole reason this does not go through `drop` and a fresh `set`.
   *
   * It falls back to dropping the workspace whole if the trim gives back a tree
   * that still names one of the departing sessions. Nothing in the tree layer
   * does that today; the cost of being wrong is a document claiming one session
   * for two workspaces, which `load()` resolves by throwing BOTH entries away,
   * so the cheap guard is worth its three lines.
   */
  function trim(id: string, moved: readonly SessionKey[]): void {
    const held = doc.get(id);
    if (held === undefined) return;
    const left = deps.without(held.tree, moved);
    const gone = new Set(moved);
    if (left === null || deps.sessionsOf(left).some((s) => gone.has(s))) {
      drop(id);
      return;
    }
    for (const session of deps.sessionsOf(held.tree)) {
      if (index.get(session) === id) index.delete(session);
    }
    doc.set(id, { tree: left, seen: held.seen });
    for (const session of deps.sessionsOf(left)) index.set(session, id);
  }

  function forget(id: string): void {
    if (!drop(id)) return;
    persist();
    setVersion((v) => v + 1);
  }

  /**
   * Write one arrangement, and make the document consistent around it.
   *
   * A session the incoming tree claims is taken out of whichever workspace held
   * it, AND ONLY THAT SESSION. The surgery is `deps.without`, injected for this
   * one job, because a tree edit belongs to the tree layer and this store does
   * not know the node shape. Leaving the other entry alone is not an option: the
   * document would then claim one session for two workspaces, which is the state
   * `load()` has to throw both entries away to resolve.
   *
   * UNTIL 2026-09-13 THE WHOLE ARRANGEMENT WENT. The normal path lost nothing —
   * dragging a session from A into B is two writes and whichever lands first the
   * other repairs — so what it cost was the abnormal one: a crash between those
   * writes, or another tab writing a B that claims a member of A, and A woke up
   * auto-arranged. Viktor lost a laptop's arrangement that way (see
   * ARRANGEMENT_TTL_MS above for the other half of the same afternoon), and the
   * third option was there all along for the price of one more injected
   * function.
   */
  function setTree(id: string, next: TreeNode): void {
    if (!id) return;
    const sessions = deps.sessionsOf(next);
    if (sessions.length === 0) {
      forget(id);
      return;
    }
    // One session, one tile. A tree that breaks it would put two live views on
    // one session and make them contend for its Grid continuously, which is
    // what the grid pinning exists to prevent. Refused whole: this store cannot
    // edit the duplicate out, and half-applying it would be worse.
    if (new Set(sessions).size !== sessions.length) return;
    // Grouped before anything is edited, because one write can take two tiles
    // from the same workspace and trimming per session would read an index the
    // previous trim has already moved.
    const taken = new Map<string, SessionKey[]>();
    for (const session of sessions) {
      const holder = index.get(session);
      if (holder === undefined || holder === id) continue;
      const list = taken.get(holder);
      if (list) list.push(session);
      else taken.set(holder, [session]);
    }
    for (const [holder, moved] of taken) trim(holder, moved);
    // Clear what this workspace used to hold before claiming what it holds now,
    // so a session dragged out of it stops answering the reverse lookup.
    const was = doc.get(id);
    drop(id);
    // The stamp survives a rearrangement: it records when the SERVER last
    // listed this workspace, and moving a divider is not news about that.
    doc.set(id, { tree: next, seen: was?.seen ?? Date.now() });
    for (const session of sessions) index.set(session, id);
    persist();
    setVersion((v) => v + 1);
  }

  function prune(live: readonly string[]): void {
    if (live.length === 0) return;
    const keep = new Set(live);
    const now = Date.now();
    /** an entry went, so every reader has to look again. */
    let dropped = false;
    /** only a timestamp moved, which nothing can read — write, do not re-render. */
    let stamped = false;
    for (const [id, entry] of [...doc]) {
      if (keep.has(id)) {
        if (now - entry.seen < STAMP_EVERY_MS) continue;
        entry.seen = now; // in place: the entry keeps its position in the document
        stamped = true;
        continue;
      }
      // Missing from THIS answer is not gone. Only a month of answers is.
      if (now - entry.seen < ARRANGEMENT_TTL_MS) continue;
      dropped = drop(id) || dropped;
    }
    if (!dropped && !stamped) return;
    persist();
    if (dropped) setVersion((v) => v + 1);
  }

  /**
   * The other tab on this device wrote the document.
   *
   * localStorage is shared across a device's tabs while this store's copy is per
   * tab, so without this the second tab's reverse lookup keeps answering with a
   * workspace the first tab moved a session out of, and its next write puts that
   * stale arrangement back. A `storage` event fires only in the OTHER tabs,
   * never in the one that wrote, so re-reading here cannot loop. A whole-store
   * `clear()` — what Clear local data does — arrives with a null key and means
   * this document too.
   */
  function onStorage(event: StorageEvent): void {
    if (event.key !== null && event.key !== WORKSPACES_KEY) return;
    load();
    setVersion((v) => v + 1);
  }

  load();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

  return {
    ids: () => {
      version(); // track
      return [...doc.keys()];
    },
    treeFor: (id) => {
      version(); // track
      return doc.get(id)?.tree ?? null;
    },
    workspaceOf: (sessionKey) => {
      version(); // track
      return index.get(sessionKey) ?? null;
    },
    setTree,
    forget,
    prune,
    version,
    dispose: () => {
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    },
  };
}
