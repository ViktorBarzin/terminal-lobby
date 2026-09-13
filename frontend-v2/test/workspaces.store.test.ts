import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keyOf } from "../src/store/keepalive";
import { leaf, leafKeys, split, type TreeNode } from "../src/store/workspace-tree";
import {
  ARRANGEMENT_TTL_MS,
  WORKSPACES_KEY,
  WORKSPACES_KEY_V1,
  createWorkspacesStore,
  type WorkspacesDeps,
} from "../src/store/workspaces";

/**
 * The per-device half of a Workspace: the split tree and the tile sizes, for
 * this browser only (ADR-0027, "Workspace membership is server-side; geometry
 * is not"). Membership — which sessions belong together — is tmux-api's, and
 * deliberately absent from every case here.
 *
 * Every well-formed tree below is built by `store/workspace-tree.ts`'s own
 * `leaf` and `split`, and every session list comes from its `leafKeys`, so no
 * case here can pass against a shape that module has stopped writing. The
 * malformed documents are object literals on purpose: they are what a foreign
 * build or a half-finished write leaves behind, and no constructor would make
 * one.
 */

const tile = (name: string, owner?: string): TreeNode => leaf(keyOf({ name, owner }));
const row = (...children: TreeNode[]): TreeNode => split("row", children);
const column = (...children: TreeNode[]): TreeNode => split("column", children);

/**
 * The validator the store injects, standing in for the one
 * `store/workspace-tree.ts` does not export yet: that module builds and
 * transforms trees it already trusts, and nothing in it takes an `unknown`.
 * Written against `TreeNode` rather than against a private shape, so it stops
 * compiling if a node ever gains or loses a field.
 */
function parseTree(value: unknown): TreeNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") {
    return typeof node.key === "string" && node.key ? leaf(node.key) : null;
  }
  if (node.kind !== "split") return null;
  const { dir, children, fractions } = node;
  if (dir !== "row" && dir !== "column") return null;
  if (!Array.isArray(children) || children.length === 0) return null;
  if (!Array.isArray(fractions) || fractions.length !== children.length) return null;
  const kids: TreeNode[] = [];
  for (const child of children) {
    const parsed = parseTree(child);
    if (parsed === null) return null;
    kids.push(parsed);
  }
  const fracs: number[] = [];
  for (const f of fractions) {
    if (typeof f !== "number" || !(f > 0)) return null;
    fracs.push(f);
  }
  return split(dir, kids, fracs);
}

/**
 * Taking named sessions out of a tree, which is the third thing the store asks
 * of the tree layer. `removeAt` is the real one App wires in; this stands in
 * for it the way `parseTree` above stands in for the validator, and it is
 * written against `TreeNode` so it stops compiling if the node shape moves.
 */
function without(tree: TreeNode, sessions: readonly string[]): TreeNode | null {
  const gone = new Set(sessions);
  const walk = (node: TreeNode): TreeNode | null => {
    if (node.kind === "leaf") return gone.has(node.key) ? null : node;
    const kids: TreeNode[] = [];
    const fracs: number[] = [];
    node.children.forEach((child, i) => {
      const kept = walk(child);
      if (kept === null) return;
      kids.push(kept);
      fracs.push(node.fractions[i] ?? 1);
    });
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0]!;
    const total = fracs.reduce((a, b) => a + b, 0);
    return split(
      node.dir,
      kids,
      fracs.map((f) => f / total),
    );
  };
  return walk(tree);
}

const deps: WorkspacesDeps = { parseTree, sessionsOf: leafKeys, without };

const store = () => createWorkspacesStore(deps);
/** A session's identity as the slot layer knows it: owner and name. */
const key = (name: string, owner?: string) => keyOf({ name, owner });
/** The document as it actually sits in storage, for the shape assertions. */
const raw = (): unknown => JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? "null");
/** Just the trees, which is what most cases are about: the timestamp beside
 *  each one only decides when an unlisted workspace ages out. */
const trees = (): Record<string, unknown> => {
  const doc = raw();
  if (!doc || typeof doc !== "object") return {};
  return Object.fromEntries(
    Object.entries(doc as Record<string, { tree?: unknown }>).map(([id, e]) => [id, e?.tree]),
  );
};
/** Put a document in storage by hand — a foreign build, or a half-written write. */
const seed = (doc: unknown): void => localStorage.setItem(WORKSPACES_KEY, JSON.stringify(doc));
/** The same, given trees rather than entries: each is wrapped as this build
 *  writes it, stamped as last listed now. */
const seedTrees = (doc: Record<string, unknown>, seen = Date.now()): void =>
  seed(Object.fromEntries(Object.entries(doc).map(([id, tree]) => [id, { tree, seen }])));

/** jsdom's own descriptor, kept so the case that replaces the global with a
 *  throwing getter can hand it back. Same shape as test/storage.test.ts. */
const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function restoreLocalStorage(): void {
  if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("createWorkspacesStore — round trip", () => {
  it("hands back the arrangement it was given", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), column(tile("deploy"), tile("docs"))));
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), column(tile("deploy"), tile("docs"))));
    s.dispose();
  });

  it("survives a reload: a fresh store reads the same arrangement", () => {
    const first = store();
    first.setTree("w1", column(tile("auth"), tile("deploy")));
    first.dispose();

    const reloaded = store();
    expect(reloaded.treeFor("w1")).toEqual(column(tile("auth"), tile("deploy")));
    reloaded.dispose();
  });

  it("persists under tl:workspaces:v2 as workspace id to tree and stamp, and writes no second key", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    s.setTree("w2", row(tile("docs"), tile("logs")));
    expect(raw()).toEqual({
      w1: { tree: tile("auth"), seen: expect.any(Number) },
      w2: { tree: row(tile("docs"), tile("logs")), seen: expect.any(Number) },
    });
    // The reverse lookup is derived at load, never stored beside the trees,
    // because a second key can disagree with them (ADR-0027). Nor is the old
    // key left behind: this device has nothing to say under v1 any more.
    expect(Object.keys(localStorage)).toEqual([WORKSPACES_KEY]);
    s.dispose();
  });

  it("has nothing for a workspace this device has never seen", () => {
    // The caller's cue to auto-arrange evenly in the server's member order. An
    // empty answer is the normal first visit on a new device, not an error.
    const s = store();
    expect(s.treeFor("w1")).toBeNull();
    expect(s.ids()).toEqual([]);
    s.dispose();
  });

  it("keeps a workspace of one, because one session is a tree of one node", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    s.dispose();
  });

  it("keeps workspaces apart", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", column(tile("docs"), tile("logs")));
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    expect(s.treeFor("w2")).toEqual(column(tile("docs"), tile("logs")));
    expect(s.ids()).toEqual(["w1", "w2"]);
    s.dispose();
  });

  it("replaces an arrangement in place rather than merging into it", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w1", tile("auth"));
    expect(s.ids()).toEqual(["w1"]);
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    expect(s.workspaceOf(key("deploy"))).toBeNull();
    s.dispose();
  });

  it("forgets one workspace without touching its neighbours", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", row(tile("docs"), tile("logs")));
    s.forget("w1");
    expect(s.treeFor("w1")).toBeNull();
    expect(s.treeFor("w2")).toEqual(row(tile("docs"), tile("logs")));
    expect(trees()).toEqual({ w2: row(tile("docs"), tile("logs")) });
    s.dispose();
  });
});

describe("createWorkspacesStore — a corrupt document is dropped, never thrown", () => {
  it("reads an empty document when the key holds something that is not JSON", () => {
    localStorage.setItem(WORKSPACES_KEY, "{ half a write");
    const s = store();
    expect(s.ids()).toEqual([]);
    expect(s.treeFor("w1")).toBeNull();
    s.dispose();
  });

  it.each([
    ["an array", [tile("auth")]],
    ["a string", "w1"],
    ["a number", 7],
    ["null", null],
  ])("reads an empty document when the key holds %s", (_label, doc) => {
    seed(doc);
    const s = store();
    expect(s.ids()).toEqual([]);
    s.dispose();
  });

  it("drops the entry the tree layer refuses and keeps its siblings", () => {
    seedTrees({
      w1: row(tile("auth"), tile("deploy")),
      broken: { kind: "split", dir: "diagonal", children: [], fractions: [] },
      w2: tile("docs"),
    });
    const s = store();
    expect(s.ids()).toEqual(["w1", "w2"]);
    expect(s.treeFor("broken")).toBeNull();
    expect(s.treeFor("w2")).toEqual(tile("docs"));
    s.dispose();
  });

  it.each([
    ["a number", 7],
    ["null", null],
    ["a bare string", "column"],
    ["an array", []],
  ])("drops an entry that is %s rather than a tree", (_label, entry) => {
    seedTrees({ w1: tile("auth"), bad: entry });
    const s = store();
    expect(s.ids()).toEqual(["w1"]);
    s.dispose();
  });

  it("drops a half-written split whose fractions do not match its children", () => {
    seedTrees({
      w1: { kind: "split", dir: "row", children: [tile("a"), tile("b")], fractions: [1] },
      w2: row(tile("c"), tile("d")),
    });
    const s = store();
    expect(s.ids()).toEqual(["w2"]);
    s.dispose();
  });

  it("drops an entry whose id is empty, because nothing could ever ask for it", () => {
    seedTrees({ "": tile("auth"), w1: tile("docs") });
    const s = store();
    expect(s.ids()).toEqual(["w1"]);
    expect(s.workspaceOf(key("auth"))).toBeNull();
    s.dispose();
  });

  it("does not rewrite storage just for having read it", () => {
    // A read stays pure, the way store/drafts.ts keeps it. A boot that rewrote
    // every document would put a storage write on every tab open, including the
    // tabs that have no workspaces at all.
    seed({ w1: { tree: 7, seen: 1 } });
    store().dispose();
    expect(raw()).toEqual({ w1: { tree: 7, seen: 1 } });
  });

  it("leaves the dropped entries behind on the next write", () => {
    seedTrees({ w1: tile("auth"), broken: { kind: "split", dir: "diagonal" } });
    const s = store();
    s.setTree("w2", tile("docs"));
    expect(trees()).toEqual({ w1: tile("auth"), w2: tile("docs") });
    s.dispose();
  });
});

describe("createWorkspacesStore — a refused write costs the arrangement and nothing else", () => {
  it("survives a blocked or full localStorage and still answers in this page life", () => {
    const s = store();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    expect(() => s.setTree("w1", row(tile("auth"), tile("deploy")))).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    // lib/storage.ts swallows the throw, so the in-memory half is untouched and
    // this tab keeps the arrangement the person is looking at.
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    setItem.mockRestore();

    // The next tab has nothing, which is the whole cost of a refused write.
    const next = store();
    expect(next.treeFor("w1")).toBeNull();
    next.dispose();
    s.dispose();
  });

  it("survives a store that cannot be read either", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    const s = store();
    expect(s.ids()).toEqual([]);
    expect(() => s.setTree("w1", tile("auth"))).not.toThrow();
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    s.dispose();
  });

  it("builds an empty store when the localStorage getter itself throws", () => {
    // Reading the property is what throws in a sandboxed frame or with cookies
    // blocked, which is why lib/storage.ts catches rather than tests.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      const s = store();
      expect(s.ids()).toEqual([]);
      expect(() => s.setTree("w1", tile("auth"))).not.toThrow();
      expect(s.treeFor("w1")).toEqual(tile("auth"));
      s.dispose();
    } finally {
      restoreLocalStorage();
    }
  });
});

describe("createWorkspacesStore — the session-to-workspace reverse lookup", () => {
  it("answers for every member of a saved workspace", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), column(tile("deploy"), tile("docs"))));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    expect(s.workspaceOf(key("deploy"))).toBe("w1");
    expect(s.workspaceOf(key("docs"))).toBe("w1");
    expect(s.workspaceOf(key("stranger"))).toBeNull();
    expect(s.workspaceOf("")).toBeNull();
    s.dispose();
  });

  it("is derived at load, so a fresh store answers from the document alone", () => {
    seedTrees({ w1: row(tile("auth"), tile("deploy")), w2: tile("docs") });
    const s = store();
    expect(s.workspaceOf(key("deploy"))).toBe("w1");
    expect(s.workspaceOf(key("docs"))).toBe("w2");
    s.dispose();
  });

  it("counts the owner as part of the identity, so two people's `auth` differ", () => {
    // Two people can have a session of the same name, and a workspace may hold a
    // foreign one, so the key is keepalive's owner and name rather than a name.
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", row(tile("auth", "emo"), tile("docs")));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    expect(s.workspaceOf(key("auth", "emo"))).toBe("w2");
    expect(s.ids()).toEqual(["w1", "w2"]);
    s.dispose();
  });

  it("follows an add", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("docs"))).toBeNull();
    s.setTree("w1", row(tile("auth"), tile("deploy"), tile("docs")));
    expect(s.workspaceOf(key("docs"))).toBe("w1");
    s.dispose();
  });

  it("follows a remove", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w1", tile("auth"));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    expect(s.workspaceOf(key("deploy"))).toBeNull();
    s.dispose();
  });

  it("follows a move between workspaces, in either order the caller writes them", () => {
    // Dragging `docs` from w1 into w2 rewrites both trees. The lookup has to
    // land right whichever the caller writes first.
    const a = store();
    a.setTree("w1", row(tile("auth"), tile("docs")));
    a.setTree("w2", tile("logs"));
    a.setTree("w1", tile("auth")); // the losing workspace reflows first
    a.setTree("w2", row(tile("logs"), tile("docs")));
    expect(a.workspaceOf(key("docs"))).toBe("w2");
    expect(a.treeFor("w1")).toEqual(tile("auth"));
    a.dispose();

    localStorage.clear();
    const b = store();
    b.setTree("w1", row(tile("auth"), tile("docs")));
    b.setTree("w2", tile("logs"));
    b.setTree("w2", row(tile("logs"), tile("docs"))); // the winner first
    b.setTree("w1", tile("auth"));
    expect(b.workspaceOf(key("docs"))).toBe("w2");
    expect(b.treeFor("w1")).toEqual(tile("auth"));
    b.dispose();
  });

  it("forgets a workspace's sessions when its geometry is forgotten", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", tile("docs"));
    s.forget("w1");
    expect(s.workspaceOf(key("auth"))).toBeNull();
    expect(s.workspaceOf(key("deploy"))).toBeNull();
    expect(s.workspaceOf(key("docs"))).toBe("w2");
    s.dispose();
  });

  it("stays consistent through a long sequence of adds, moves and removes", () => {
    const s = store();
    s.setTree("w1", row(tile("a"), tile("b"), tile("c")));
    s.setTree("w2", row(tile("d"), tile("e")));
    s.setTree("w1", row(tile("a"), tile("c"))); // b dragged out
    s.setTree("w2", row(tile("d"), tile("e"), tile("b"))); // and into w2
    s.setTree("w3", tile("f"));
    s.forget("w1");
    s.setTree("w3", row(tile("f"), tile("a"))); // a was stranded by the forget

    const expected: Record<string, string | null> = {
      a: "w3",
      b: "w2",
      c: null,
      d: "w2",
      e: "w2",
      f: "w3",
    };
    for (const [name, id] of Object.entries(expected)) {
      expect([name, s.workspaceOf(key(name))]).toEqual([name, id]);
    }
    // and the index says nothing the document itself does not
    for (const [name, id] of Object.entries(expected)) {
      if (!id) continue;
      const held = s.treeFor(id);
      expect(held).not.toBeNull();
      expect(held ? deps.sessionsOf(held) : []).toContain(key(name));
    }
    s.dispose();
  });

  it("survives a reload with the same answers", () => {
    const first = store();
    first.setTree("w1", row(tile("auth"), column(tile("deploy"), tile("docs"))));
    first.dispose();
    const reloaded = store();
    expect(reloaded.workspaceOf(key("deploy"))).toBe("w1");
    expect(reloaded.workspaceOf(key("stranger"))).toBeNull();
    reloaded.dispose();
  });
});

describe("createWorkspacesStore — one session, at most one workspace", () => {
  /**
   * CONTEXT.md "Workspace", and the invariant behind it: keepalive mounts
   * exactly one live view per session, keyed owner and name, so two tiles of one
   * session is not something the DOM can express — and they would contend for
   * its Grid continuously if it were.
   */
  it("gives the session to the newer write and takes the tile out of the older one", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy"), tile("logs")));
    s.setTree("w2", row(tile("docs"), tile("deploy"))); // deploy dragged in, w1 not yet reflowed

    expect(s.workspaceOf(key("deploy"))).toBe("w2");
    // w1 keeps everything the move did not take. Before 2026-09-13 the whole
    // arrangement went here, which is how a briefly-wrong document cost Viktor
    // a laptop's panes — see the TTL describe below for the other half.
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("logs")));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    expect(s.ids()).toEqual(["w1", "w2"]);
    s.dispose();
  });

  it("keeps the emptied workspace out of the document when the move took its last tile", () => {
    const s = store();
    s.setTree("w1", tile("deploy"));
    s.setTree("w2", row(tile("docs"), tile("deploy")));
    expect(s.treeFor("w1")).toBeNull();
    expect(s.ids()).toEqual(["w2"]);
    s.dispose();
  });

  it("takes two tiles from one workspace in a single write", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy"), tile("logs")));
    s.setTree("w2", row(tile("docs"), tile("deploy"), tile("logs")));
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    expect(s.workspaceOf(key("logs"))).toBe("w2");
    s.dispose();
  });

  // Trimming edits the entry in place rather than removing and re-adding it, so
  // `ids()` still reads oldest first — the order the rest of the app shows
  // workspaces in.
  it("leaves the trimmed workspace where it was in the document", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", tile("docs"));
    s.setTree("w3", row(tile("build"), tile("deploy")));
    expect(s.ids()).toEqual(["w1", "w2", "w3"]);
    s.dispose();
  });

  it("leaves the other workspaces alone when there is no conflict", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", row(tile("docs"), tile("logs")));
    s.setTree("w3", row(tile("build"), tile("release")));
    expect(s.ids()).toEqual(["w1", "w2", "w3"]);
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    s.dispose();
  });

  it("lets a workspace keep the sessions it already holds", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w1", column(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    expect(s.treeFor("w1")).toEqual(column(tile("auth"), tile("deploy")));
    s.dispose();
  });

  it("refuses a tree that puts the same session in two tiles", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("auth")));
    expect(s.treeFor("w1")).toBeNull();
    expect(s.workspaceOf(key("auth"))).toBeNull();
    s.dispose();
  });

  it("keeps an earlier arrangement when a later write is refused", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w1", row(tile("auth"), tile("deploy"), tile("auth")));
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    s.dispose();
  });

  it("drops every entry of a stored document that claims one session twice", () => {
    // Order-independent on purpose: a half-written document has no newer entry
    // to prefer, and answering with either one would be a coin toss that a
    // reload could decide the other way.
    seedTrees({
      w1: row(tile("auth"), tile("deploy")),
      w2: tile("deploy"),
      w3: tile("docs"),
    });
    const s = store();
    expect(s.ids()).toEqual(["w3"]);
    expect(s.workspaceOf(key("deploy"))).toBeNull();
    expect(s.workspaceOf(key("auth"))).toBeNull();
    expect(s.workspaceOf(key("docs"))).toBe("w3");
    s.dispose();
  });

  it("drops a stored entry that names one session twice", () => {
    seedTrees({ w1: row(tile("auth"), tile("auth")), w2: tile("docs") });
    const s = store();
    expect(s.ids()).toEqual(["w2"]);
    s.dispose();
  });

  it("never holds one session in two trees, whatever sequence was written", () => {
    const s = store();
    // Three workspaces fighting over three sessions, then two of them shrinking
    // back to one tile each. Every intermediate state is checked, not just the
    // end, because the rule has to hold at each write rather than on average.
    const writes: Array<[string, TreeNode]> = [
      ["w1", row(tile("a"), tile("b"))],
      ["w2", row(tile("b"), tile("c"))],
      ["w3", row(tile("c"), tile("a"))],
      ["w1", tile("a")],
      ["w2", tile("b")],
    ];
    for (const [id, node] of writes) {
      s.setTree(id, node);
      for (const name of ["a", "b", "c"]) {
        const holders = s.ids().filter((w) => {
          const t = s.treeFor(w);
          return t !== null && deps.sessionsOf(t).includes(key(name));
        });
        // The DOCUMENT, not just the index: a session in two stored trees would
        // put one live terminal in two tiles the moment both were rendered.
        expect([name, holders]).toEqual([name, holders.slice(0, 1)]);
        expect(s.workspaceOf(key(name))).toBe(holders[0] ?? null);
      }
    }
    s.dispose();
  });
});

describe("createWorkspacesStore — an arrangement holding no session is not an arrangement", () => {
  /**
   * Out of reach of the real tree, where every leaf carries a key, so `leafKeys`
   * comes back empty only for a split with no children — which `normalize`
   * turns into no tree at all rather than into an empty one. Kept as
   * document-level defence and pinned here with a tree layer that does report
   * none: an entry claiming no session can never be found by the reverse lookup
   * and never dropped by a membership prune, so it would sit in storage for as
   * long as the browser profile lives.
   */
  const blankDeps: WorkspacesDeps = {
    parseTree: deps.parseTree,
    sessionsOf: (t) => (t.kind === "leaf" && t.key === key("blank") ? [] : deps.sessionsOf(t)),
    without: deps.without,
  };

  it("removes the entry when a write holds no sessions at all", () => {
    const s = createWorkspacesStore(blankDeps);
    s.setTree("w1", tile("auth"));
    s.setTree("w1", tile("blank"));
    expect(s.treeFor("w1")).toBeNull();
    expect(s.ids()).toEqual([]);
    expect(raw()).toEqual({});
    s.dispose();
  });

  it("drops a stored entry that holds no sessions", () => {
    seedTrees({ w1: tile("blank"), w2: tile("docs") });
    const s = createWorkspacesStore(blankDeps);
    expect(s.ids()).toEqual(["w2"]);
    s.dispose();
  });
});

/**
 * WHAT THIS DEVICE ARRANGED STAYS ARRANGED, even while the server is not
 * listing the workspace.
 *
 * Viktor, 2026-09-13: *"something happened and my panes got lost on my laptop
 * ... i want splits to persist for the same device"*. What happened was that
 * the membership document briefly did not list his workspace — a verification
 * run on this box replaced it for about five minutes — and the eager prune this
 * replaces deleted the arrangement from the laptop the moment it read that
 * document. The workspace came back; the arrangement could not, because the
 * server never had it.
 *
 * So an id the server stops listing is now treated as ABSENT rather than as
 * DELETED, and absence is only conclusive after {@link ARRANGEMENT_TTL_MS}.
 * The reason prune exists at all is still served: the document cannot grow
 * without bound, it just stops throwing away work to save a few hundred bytes
 * the same hour.
 */
describe("createWorkspacesStore — an arrangement outlives a workspace going missing", () => {
  /** The store reads Date.now() and nothing else, so one spy is the whole clock. */
  let now = 1_700_000_000_000;
  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  const after = (ms: number) => {
    now += ms;
  };

  it("keeps an arrangement the server's answer did not mention", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.prune(["w2"]);
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("auth"))).toBe("w1");
    s.dispose();
  });

  // The case that cost Viktor his panes: gone from one answer, back in the next.
  it("hands it back unchanged when the workspace reappears", () => {
    const s = store();
    const arranged = row(column(tile("auth"), tile("deploy")), tile("docs"));
    s.setTree("w1", arranged);
    s.prune(["w2"]);
    after(4 * 60_000);
    s.prune(["w1", "w2"]);
    expect(s.treeFor("w1")).toEqual(arranged);
    s.dispose();
  });

  it("survives a reload while the workspace is still missing", () => {
    const first = store();
    first.setTree("w1", row(tile("auth"), tile("deploy")));
    first.prune(["w2"]);
    first.dispose();
    const second = store();
    expect(second.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    second.dispose();
  });

  it("drops it once it has gone unlisted for the whole window", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    s.setTree("w2", tile("docs"));
    after(ARRANGEMENT_TTL_MS + 1);
    s.prune(["w2"]);
    expect(s.ids()).toEqual(["w2"]);
    expect(s.workspaceOf(key("auth"))).toBeNull();
    expect(trees()).toEqual({ w2: tile("docs") });
    s.dispose();
  });

  // The clock runs from the last time the SERVER listed it, not from the last
  // time this device wrote it — otherwise a workspace nobody rearranges for a
  // month would age out while it is on screen.
  it("counts from the last answer that listed it, not from the last write", () => {
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    for (let i = 0; i < 40; i++) {
      after(ARRANGEMENT_TTL_MS / 4);
      s.prune(["w1"]);
    }
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    after(ARRANGEMENT_TTL_MS + 1);
    s.prune(["w2"]);
    expect(s.treeFor("w1")).toBeNull();
    s.dispose();
  });

  it("treats an EMPTY list as no information, never as 'you have no workspaces'", () => {
    // The workspaces GET has not answered yet on a cold tab. Folding that in
    // would wipe every arrangement on the device before the first paint — the
    // guard store/drafts.ts and store/visits.ts both carry, written there after
    // exactly that happened to the visit store on every app open.
    const s = store();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    after(ARRANGEMENT_TTL_MS + 1);
    s.prune([]);
    expect(s.ids()).toEqual(["w1"]);
    s.dispose();
  });

  // The effect behind this runs on every change to the membership document, so
  // a stamp that wrote and bumped every time would put a storage write and a
  // re-render behind every poll.
  it("does not bump version for a stamp nobody can read", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    const before = s.version();
    after(2 * 60 * 60_000);
    s.prune(["w1"]);
    s.prune(["w1"]);
    expect(s.version()).toBe(before);
    s.dispose();
  });

  it("writes nothing at all when the stamp is still fresh", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    const write = vi.spyOn(Storage.prototype, "setItem");
    after(60_000);
    s.prune(["w1"]);
    expect(write).not.toHaveBeenCalled();
    s.dispose();
  });
});

/**
 * The upgrade that carries this change must not do the thing the change exists
 * to prevent. `tl:workspaces:v1` held the tree alone; v2 holds it beside the
 * timestamp, so the key suffix moves — and this store's own docblock says a
 * bare suffix bump abandons every device's arrangements. That is the cost this
 * migration is here to refuse to pay.
 */
describe("createWorkspacesStore — adopting an older build's document", () => {
  it("reads arrangements written under the v1 key", () => {
    localStorage.setItem(
      WORKSPACES_KEY_V1,
      JSON.stringify({ w1: row(tile("auth"), tile("deploy")), w2: tile("docs") }),
    );
    const s = store();
    expect(s.ids()).toEqual(["w1", "w2"]);
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("docs"))).toBe("w2");
    s.dispose();
  });

  it("leaves both keys alone until something is written", () => {
    // A read stays pure here as it does everywhere else in this store, so a tab
    // that opens and touches no workspace writes no storage at all.
    const v1 = JSON.stringify({ w1: tile("auth") });
    localStorage.setItem(WORKSPACES_KEY_V1, v1);
    store().dispose();
    expect(localStorage.getItem(WORKSPACES_KEY_V1)).toBe(v1);
    expect(localStorage.getItem(WORKSPACES_KEY)).toBeNull();
  });

  it("promotes to v2 on the first write and takes the old key away", () => {
    localStorage.setItem(WORKSPACES_KEY_V1, JSON.stringify({ w1: tile("auth") }));
    const s = store();
    s.setTree("w2", tile("docs"));
    expect(trees()).toEqual({ w1: tile("auth"), w2: tile("docs") });
    expect(localStorage.getItem(WORKSPACES_KEY_V1)).toBeNull();
    s.dispose();
  });

  it("ignores v1 once v2 exists, so a stale old key cannot resurrect anything", () => {
    localStorage.setItem(WORKSPACES_KEY_V1, JSON.stringify({ old: tile("gone") }));
    seedTrees({ w1: tile("auth") });
    const s = store();
    expect(s.ids()).toEqual(["w1"]);
    s.dispose();
  });

  it("gives a migrated arrangement the full window before it can age out", () => {
    // Stamping them as last listed at the moment of the upgrade is the only
    // honest answer: v1 recorded no dates, so the alternative is inventing one
    // old enough to delete what it just adopted.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    localStorage.setItem(WORKSPACES_KEY_V1, JSON.stringify({ w1: tile("auth") }));
    const s = store();
    clock.mockReturnValue(1_700_000_000_000 + ARRANGEMENT_TTL_MS - 1);
    s.prune(["w2"]);
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    s.dispose();
  });
});

describe("createWorkspacesStore — version", () => {
  it("bumps on every change and on nothing else", () => {
    const s = store();
    const start = s.version();
    s.setTree("w1", row(tile("auth"), tile("deploy")));
    expect(s.version()).toBe(start + 1);
    s.forget("w1");
    expect(s.version()).toBe(start + 2);
    s.forget("w1"); // already gone
    expect(s.version()).toBe(start + 2);
    s.setTree("", tile("auth")); // no id, so no geometry to keep
    expect(s.version()).toBe(start + 2);
    s.setTree("w2", row(tile("auth"), tile("auth"))); // refused
    expect(s.version()).toBe(start + 2);
    s.dispose();
  });
});

describe("createWorkspacesStore — the other tab on this device", () => {
  /** A storage event carries a second tab's write. jsdom fires none of its own,
   *  and neither does a real browser in the tab that did the writing. */
  const fromOtherTab = (doc: Record<string, unknown>): void => {
    seedTrees(doc);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: WORKSPACES_KEY,
        newValue: localStorage.getItem(WORKSPACES_KEY),
      }),
    );
  };

  it("re-reads the document a second tab wrote", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    fromOtherTab({ w1: row(tile("auth"), tile("deploy")) });
    expect(s.treeFor("w1")).toEqual(row(tile("auth"), tile("deploy")));
    expect(s.workspaceOf(key("deploy"))).toBe("w1");
    s.dispose();
  });

  it("bumps version so a memo re-reads", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    const before = s.version();
    fromOtherTab({ w2: tile("docs") });
    expect(s.version()).toBe(before + 1);
    expect(s.ids()).toEqual(["w2"]);
    s.dispose();
  });

  it("ignores a write to any other key", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    const before = s.version();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tl:session-drafts:v1", newValue: "{}" }),
    );
    expect(s.version()).toBe(before);
    expect(s.treeFor("w1")).toEqual(tile("auth"));
    s.dispose();
  });

  it("re-reads on a storage clear, which arrives with a null key", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    expect(s.ids()).toEqual([]);
    s.dispose();
  });

  it("stops listening once disposed", () => {
    const s = store();
    s.setTree("w1", tile("auth"));
    s.dispose();
    const before = s.version();
    fromOtherTab({ w1: row(tile("auth"), tile("deploy")) });
    expect(s.version()).toBe(before);
    expect(s.treeFor("w1")).toEqual(tile("auth"));
  });
});
