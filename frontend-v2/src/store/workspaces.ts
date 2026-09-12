import { type Accessor, createSignal } from "solid-js";
import { lsGet, lsSet } from "../lib/storage";
import type { SessionKey, TreeNode } from "./workspace-tree";

/**
 * The per-device half of a Workspace: which arrangement THIS BROWSER holds for
 * each workspace, and nothing about who belongs to one.
 *
 *   tl:workspaces:v1   workspace id → the serialised split tree
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
 * `store/device-prefs.ts:23` says the consequence outright: nothing here has a
 * migration path, and no store in this codebase has ever had one. So the day
 * the tree's serialised shape changes, this key becomes `tl:workspaces:v2` and
 * every device's arrangements are abandoned — each workspace re-derives from
 * its server-side member order on the next entry, and the first drag rebuilds
 * it. That is the cost, and it is payable: an arrangement is one screen's
 * geometry, not the work. Membership is untouched, because it is on the server.
 * A v2 that wants to keep v1's arrangements has to carry the first migration
 * this codebase has written — read the old key, convert each tree, delete it.
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

/** Where the arrangements live. Bump the suffix if the tree's shape changes,
 *  and read what that costs in the docblock above. */
export const WORKSPACES_KEY = "tl:workspaces:v1";

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
   * Drop the arrangements of workspaces the server no longer lists.
   *
   * An EMPTY list is "I do not know yet", never "you have no workspaces" — the
   * same guard `store/drafts.ts` and `store/visits.ts` need. A poll in flight or
   * a briefly unreachable tmux-api would otherwise wipe every arrangement on the
   * device, and there is nowhere to recover them from.
   */
  prune(live: readonly string[]): void;
  /** Bumps on every change, so memos reading the three getters re-run. */
  version: Accessor<number>;
  /** Stop following the other tabs on this device. */
  dispose(): void;
}

/** The whole document, or {} for absent, corrupt or foreign-shaped storage. */
function readDocument(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(lsGet(WORKSPACES_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // private mode / corrupt entry
  }
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
  /** id → arrangement, in the order the entries were first seen. */
  let doc = new Map<string, TreeNode>();
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
    const kept = new Map<string, { tree: TreeNode; sessions: readonly SessionKey[] }>();
    /** how many surviving entries claim each session. */
    const claims = new Map<SessionKey, number>();
    for (const [id, value] of Object.entries(readDocument())) {
      if (!id) continue; // an entry nothing could ever ask for
      const parsed = deps.parseTree(value);
      if (parsed === null) continue;
      const sessions = deps.sessionsOf(parsed);
      if (sessions.length === 0) continue;
      if (new Set(sessions).size !== sessions.length) continue;
      kept.set(id, { tree: parsed, sessions });
      for (const session of sessions) claims.set(session, (claims.get(session) ?? 0) + 1);
    }
    for (const [id, entry] of kept) {
      if (entry.sessions.some((s) => (claims.get(s) ?? 0) > 1)) continue;
      doc.set(id, entry.tree);
      for (const session of entry.sessions) index.set(session, id);
    }
  }

  /** Mirror the in-memory document to storage. A refused write costs the
   *  arrangement and nothing else, so `lsSet` swallowing it is the behaviour
   *  this store wants: the tab keeps rendering what it already has. */
  function persist(): void {
    lsSet(WORKSPACES_KEY, JSON.stringify(Object.fromEntries(doc)));
  }

  /** Take one workspace out of both maps. True when there was one to take. */
  function drop(id: string): boolean {
    const held = doc.get(id);
    if (held === undefined) return false;
    for (const session of deps.sessionsOf(held)) {
      if (index.get(session) === id) index.delete(session);
    }
    doc.delete(id);
    return true;
  }

  function forget(id: string): void {
    if (!drop(id)) return;
    persist();
    setVersion((v) => v + 1);
  }

  /**
   * Write one arrangement, and make the document consistent around it.
   *
   * A session the incoming tree claims is taken away from whichever workspace
   * held it, and THAT WORKSPACE'S WHOLE ARRANGEMENT GOES WITH IT. Editing its
   * tree to remove the tile is not an option here — surgery on a tree belongs to
   * the tree layer, and this store cannot do it without learning the node shape
   * it deliberately does not know. Leaving it alone is worse: the document would
   * then claim one session for two workspaces, which is the state `load()` has
   * to throw both entries away to resolve.
   *
   * The normal path loses nothing either way round. Dragging a session from A
   * into B is two writes, and whichever lands first the other repairs: write the
   * reflowed A then B, and B finds no conflict; write B first and A is
   * discarded, then writing A puts it straight back. What the drop actually
   * covers is a crash between those two writes, where the device wakes up having
   * forgotten how A was arranged and auto-arranges it — the designed fallback
   * for a workspace this device has not seen.
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
    for (const session of sessions) {
      const holder = index.get(session);
      if (holder !== undefined && holder !== id) drop(holder);
    }
    // Clear what this workspace used to hold before claiming what it holds now,
    // so a session dragged out of it stops answering the reverse lookup.
    drop(id);
    doc.set(id, next);
    for (const session of sessions) index.set(session, id);
    persist();
    setVersion((v) => v + 1);
  }

  function prune(live: readonly string[]): void {
    if (live.length === 0) return;
    const keep = new Set(live);
    let changed = false;
    for (const id of [...doc.keys()]) {
      if (!keep.has(id)) changed = drop(id) || changed;
    }
    if (!changed) return;
    persist();
    setVersion((v) => v + 1);
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
      return doc.get(id) ?? null;
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
