/**
 * Taking back a workspace edit: a tile added, a tile closed, a tile dragged
 * somewhere else, and a divider moved.
 *
 * Two things in this handler are worth a suite of their own, and neither is
 * about the tree arithmetic — `test/workspace-tree.test.ts` owns that.
 *
 * A TMUX RENAME LANDS SECONDS INTO A SESSION'S LIFE (ADR-0022), and quite
 * possibly while an entry about that session is sitting on the stack.
 * `UndoStore.carry` rewrites the name under it, and it can only rewrite what it
 * can SEE: `session` and `sessions`, the two flat fields store/undo.ts declares
 * as the only places a kind may keep one. A split tree keeps its tiles in nested
 * leaves, which carry walks straight past — so this entry stores INDICES in its
 * tree and every name in the flat array. The first case below is that, end to
 * end: record an entry, rename a session under it, undo, and check the tile that
 * comes back is the renamed session rather than a name nothing answers to.
 *
 * A DIVIDER DRAG REPORTS FORTY ROWS OF FRACTIONS A SECOND and the stack is 25
 * entries deep (UNDO_CAP), so one drag either coalesces into one entry or it IS
 * the whole history and Cmd+Z walks back through a hundred milliseconds of
 * pointer movement instead of undoing the close before it.
 *
 * Everything here goes through the real handler on the real stack, against a
 * fake pair of stores, because what the handler guards is what happens when the
 * world has moved on between the action and the press.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { createUndoStore, type UndoStore } from "../src/store/undo";
import {
  createWorkspaceUndo,
  freeze,
  namesOf,
  opOf,
  RESIZE_COALESCE_MS,
  thaw,
  tilingOf,
  workspaceEntry,
  workspaceUndoHandlers,
  type WorkspaceEntry,
  type WorkspaceUndoPorts,
} from "../src/store/undo.workspace";
import { keyOf } from "../src/store/keepalive";
import { leaf, leafKeys, split, type TreeNode } from "../src/store/workspace-tree";

/** A tile's key: what the slot layer and the tree are both keyed by. Workspace
 *  members are always the caller's own sessions, so there is no owner. */
const key = (name: string): string => keyOf({ name });

/** A row of tiles, left to right, evenly sized. */
const row = (...names: string[]): TreeNode => split("row", names.map(key).map(leaf));

/** The names of the tiles in a tree, in reading order — what an assertion about
 *  "which sessions came back" is written against. */
const tiles = (tree: TreeNode | null): string[] =>
  tree === null ? [] : leafKeys(tree).map((k) => k.slice(1));

/**
 * A fake pair of stores: one device's arrangements, and the server's membership.
 *
 * `apply` is the one write the shell makes, and it does here what App does
 * there — the arrangement and the membership together — so an assertion can be
 * written against either half.
 */
function world(): WorkspaceUndoPorts & {
  trees: Map<string, TreeNode>;
  members: Map<string, string[]>;
  writes: number;
  fail: string | null;
  rename: (from: string, to: string) => void;
} {
  const state = {
    trees: new Map<string, TreeNode>(),
    members: new Map<string, string[]>(),
    writes: 0,
    fail: null as string | null,
    tree: (id: string) => state.trees.get(id) ?? null,
    workspaceOf: (name: string) => {
      for (const [id, names] of state.members) if (names.includes(name)) return id;
      return null;
    },
    apply: async (id: string, tree: TreeNode | null) => {
      state.writes += 1;
      if (state.fail) throw new Error(state.fail);
      if (tree === null) {
        state.trees.delete(id);
        state.members.delete(id);
        return;
      }
      state.trees.set(id, tree);
      state.members.set(id, tiles(tree));
    },
    /**
     * A tmux rename, landing everywhere the app would have it land.
     *
     * tmux-api rewrites a workspace's members itself (workspaces.go
     * `renameSession`, driven by rename_cascade.go) and the shell re-derives the
     * arrangement around the new name, so the world a carried entry is checked
     * against has already moved. A fake that renamed only the entry would test
     * the carry against a world that never happens.
     */
    rename: (from: string, to: string) => {
      const swap = (tree: TreeNode): TreeNode =>
        tree.kind === "leaf"
          ? leaf(tree.key === key(from) ? key(to) : tree.key)
          : split(tree.dir, tree.children.map(swap), tree.fractions);
      for (const [id, tree] of state.trees) state.trees.set(id, swap(tree));
      for (const [id, names] of state.members) {
        state.members.set(
          id,
          names.map((n) => (n === from ? to : n)),
        );
      }
    },
  };
  return state;
}

/** The real stack with only this handler on it, so nothing else can absorb a
 *  press and the entries are the ones these cases pushed. */
function stack(ports: WorkspaceUndoPorts): UndoStore {
  return createUndoStore({ storage: null, handlers: workspaceUndoHandlers(ports) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a rename under an entry — the tree's names are carried, not stranded", () => {
  it("puts the RENAMED session back when a tile closed before the rename", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    void ports.apply("w1", before);
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));

    // The title lands and tmux-api renames the session under it, which is what
    // happens to every session within seconds of its first turn.
    undo.carry("deploy", "ship-the-thing");

    expect(await undo.undo()).toEqual({ ok: true });
    // The closed tile is back, under the name the session actually has now. The
    // failure this pins is the other one: a tree holding "deploy" in a nested
    // leaf comes back naming a session that no longer exists, so the tile is
    // blank and nothing on screen says why.
    expect(tiles(ports.tree("w1"))).toEqual(["auth", "ship-the-thing", "docs"]);
    expect(ports.members.get("w1")).toEqual(["auth", "ship-the-thing", "docs"]);
  });

  it("carries a rename of the tile that did NOT move either", async () => {
    const ports = world();
    const before = row("auth", "deploy");
    const after = row("auth", "deploy", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    // Every name in either tree is flat, so a rename of a bystander is carried
    // as readily as a rename of the subject. The world follows it too, which is
    // what tmux-api and the shell between them actually do.
    ports.rename("auth", "login-flow");
    undo.carry("auth", "login-flow");

    expect(await undo.undo()).toEqual({ ok: true });
    expect(tiles(ports.tree("w1"))).toEqual(["login-flow", "deploy"]);
  });

  it("keeps every name in the flat `sessions` field and none in the tree", () => {
    const entry = workspaceEntry("w1", row("auth", "deploy"), row("auth", "deploy", "docs"));
    expect(entry.sessions).toEqual(["auth", "deploy", "docs"]);
    // The one place `carry` cannot reach is the one place no name is kept: the
    // serialised tree is numbers all the way down.
    expect(JSON.stringify(entry.before)).not.toContain("auth");
    expect(JSON.stringify(entry.after)).not.toContain("docs");
    expect(entry.session).toBe("docs");
  });

  it("survives the round trip through sessionStorage that a reload is", () => {
    const entry = workspaceEntry("w1", row("auth", "deploy"), null);
    const back = JSON.parse(JSON.stringify(entry)) as WorkspaceEntry;
    expect(tiles(thaw(back.before!, back.sessions))).toEqual(["auth", "deploy"]);
  });
});

describe("freezing and thawing a tree", () => {
  it("round-trips a nested arrangement, sizes and all", () => {
    const tree = split(
      "row",
      [leaf(key("auth")), split("column", [leaf(key("a")), leaf(key("b"))])],
      [0.7, 0.3],
    );
    const names = namesOf(tree, null);
    const back = thaw(freeze(tree, names), names);
    expect(tilingOf(back)).toBe(tilingOf(tree));
    expect(back?.kind === "split" ? back.fractions : null).toEqual([0.7, 0.3]);
  });

  it("refuses a tree whose tiles point off the end of `sessions`", () => {
    // Reachable one way: a build whose `sessions` was shaped differently wrote
    // the entry, and this one read it back out of sessionStorage. Dropping one
    // tile would put an arrangement on screen that nobody ever made.
    expect(thaw({ dir: "row", children: [0, 9], fractions: [0.5, 0.5] }, ["auth"])).toBeNull();
  });

  it("refuses a direction it does not recognise", () => {
    const bad = { dir: "diagonal", children: [0, 1], fractions: [0.5, 0.5] };
    expect(thaw(bad as never, ["auth", "deploy"])).toBeNull();
  });

  it("refuses a split of fewer than two children", () => {
    expect(thaw({ dir: "row", children: [0], fractions: [1] }, ["auth"])).toBeNull();
  });
});

describe("which gesture an entry describes", () => {
  it("reads a missing before as the first split, which is what makes a workspace", () => {
    expect(opOf(null, row("auth", "deploy"))).toBe("add");
  });

  it("reads a missing after as the close that ended one", () => {
    expect(opOf(row("auth", "deploy"), null)).toBe("remove");
  });

  it("tells a resize from a move by the shape, since both keep every tile", () => {
    const before = split("row", [leaf(key("a")), leaf(key("b"))], [0.5, 0.5]);
    const resized = split("row", [leaf(key("a")), leaf(key("b"))], [0.7, 0.3]);
    const moved = split("column", [leaf(key("b")), leaf(key("a"))]);
    expect(opOf(before, resized)).toBe("resize");
    expect(opOf(before, moved)).toBe("move");
  });

  it("names the one session an add or a close is about, and none for a resize", () => {
    expect(workspaceEntry("w1", row("a", "b"), row("a", "b", "c")).session).toBe("c");
    expect(workspaceEntry("w1", row("a", "b", "c"), row("a", "b")).session).toBe("c");
    const wide = split("row", [leaf(key("a")), leaf(key("b"))], [0.8, 0.2]);
    expect(workspaceEntry("w1", row("a", "b"), wide).session).toBeUndefined();
  });
});

describe("a divider drag is one entry", () => {
  it("folds every frame of one drag into a single entry spanning the whole of it", () => {
    vi.useFakeTimers();
    const pushed: WorkspaceEntry[] = [];
    const recorder = createWorkspaceUndo({
      push: (e) => pushed.push({ ...e, at: 0 } as WorkspaceEntry),
    });

    const at = (left: number): TreeNode =>
      split("row", [leaf(key("auth")), leaf(key("deploy"))], [left, 1 - left]);

    // Forty frames, which is one second of a handle under a finger.
    let from = at(0.5);
    for (let i = 1; i <= 40; i++) {
      const to = at(0.5 + i * 0.005);
      recorder.record("w1", from, to);
      from = to;
      vi.advanceTimersByTime(16);
    }
    expect(pushed).toHaveLength(0);

    vi.advanceTimersByTime(RESIZE_COALESCE_MS);
    expect(pushed).toHaveLength(1);
    const entry = pushed[0]!;
    expect(entry.op).toBe("resize");
    // One entry, and its two ends are where the drag STARTED and where it
    // finished — not the last two frames of it.
    const before = thaw(entry.before!, entry.sessions);
    const after = thaw(entry.after!, entry.sessions);
    expect(before?.kind === "split" ? before.fractions[0] : null).toBeCloseTo(0.5, 6);
    expect(after?.kind === "split" ? after.fractions[0] : null).toBeCloseTo(0.7, 6);
  });

  it("records nothing for a drag that ended where it started", () => {
    vi.useFakeTimers();
    const pushed: WorkspaceEntry[] = [];
    const recorder = createWorkspaceUndo({ push: (e) => pushed.push(e as WorkspaceEntry) });
    const flat = split("row", [leaf(key("a")), leaf(key("b"))], [0.5, 0.5]);
    const wide = split("row", [leaf(key("a")), leaf(key("b"))], [0.7, 0.3]);

    recorder.record("w1", flat, wide);
    recorder.record("w1", wide, flat);
    vi.advanceTimersByTime(RESIZE_COALESCE_MS);
    // An entry here would make the next Cmd+Z look like it did nothing at all.
    expect(pushed).toHaveLength(0);
  });

  it("closes the held drag off before anything else lands on the stack", () => {
    vi.useFakeTimers();
    const pushed: WorkspaceEntry[] = [];
    const recorder = createWorkspaceUndo({ push: (e) => pushed.push(e as WorkspaceEntry) });
    const flat = split("row", [leaf(key("a")), leaf(key("b"))], [0.5, 0.5]);
    const wide = split("row", [leaf(key("a")), leaf(key("b"))], [0.7, 0.3]);

    recorder.record("w1", flat, wide);
    recorder.record("w1", wide, row("a", "b", "c"));
    // The order on the stack is the order the person did things in: the resize
    // underneath, the tile that arrived on top.
    expect(pushed.map((e) => e.op)).toEqual(["resize", "add"]);
  });

  it("does not fold two workspaces' drags together", () => {
    vi.useFakeTimers();
    const pushed: WorkspaceEntry[] = [];
    const recorder = createWorkspaceUndo({ push: (e) => pushed.push(e as WorkspaceEntry) });
    const wide = (id: string): [TreeNode, TreeNode] => [
      split("row", [leaf(key(`${id}a`)), leaf(key(`${id}b`))], [0.5, 0.5]),
      split("row", [leaf(key(`${id}a`)), leaf(key(`${id}b`))], [0.7, 0.3]),
    ];
    const [w1from, w1to] = wide("w1");
    const [w2from, w2to] = wide("w2");
    recorder.record("w1", w1from, w1to);
    recorder.record("w2", w2from, w2to);
    // Leaving one workspace and resizing another is two actions, however close
    // together they happened.
    expect(pushed).toHaveLength(1);
    vi.advanceTimersByTime(RESIZE_COALESCE_MS);
    expect(pushed).toHaveLength(2);
  });

  it("gives the timer back on dispose, so a drag in the air does not outlive the tab", () => {
    vi.useFakeTimers();
    const pushed: WorkspaceEntry[] = [];
    const recorder = createWorkspaceUndo({ push: (e) => pushed.push(e as WorkspaceEntry) });
    const flat = split("row", [leaf(key("a")), leaf(key("b"))], [0.5, 0.5]);
    recorder.record("w1", flat, split("row", [leaf(key("a")), leaf(key("b"))], [0.7, 0.3]));
    recorder.dispose();
    vi.advanceTimersByTime(RESIZE_COALESCE_MS * 4);
    expect(pushed).toHaveLength(0);
  });
});

describe("undo and redo, both halves of a workspace", () => {
  it("takes a closed tile back and puts it again", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    void ports.apply("w1", before);
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));

    expect(await undo.undo()).toEqual({ ok: true });
    expect(tiles(ports.tree("w1"))).toEqual(["auth", "deploy", "docs"]);
    expect(await undo.redo()).toEqual({ ok: true });
    expect(tiles(ports.tree("w1"))).toEqual(["auth", "docs"]);
  });

  it("deletes the workspace the first split created, and re-creates it on redo", async () => {
    const ports = world();
    const after = row("auth", "deploy");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", null, after));

    expect(await undo.undo()).toEqual({ ok: true });
    // A workspace created implicitly by a split is un-created by undoing it:
    // one session on screen again, and nothing in the server's document.
    expect(ports.tree("w1")).toBeNull();
    expect(ports.members.has("w1")).toBe(false);

    expect(await undo.redo()).toEqual({ ok: true });
    expect(ports.members.get("w1")).toEqual(["auth", "deploy"]);
  });

  it("re-creates the workspace a close down to one tile ended, under the SAME id", async () => {
    const ports = world();
    const before = row("auth", "deploy");
    void ports.apply("w1", before);
    void ports.apply("w1", null);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, null));

    expect(await undo.undo()).toEqual({ ok: true });
    // The id matters: a look-alike with a fresh id would leave every device's
    // stored arrangement pointing at a workspace that no longer exists.
    expect(ports.members.get("w1")).toEqual(["auth", "deploy"]);
  });

  it("hands a refused write back as the sentence the caller toasts", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    void ports.apply("w1", before);
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    ports.fail = "the workspace write did not go through";

    expect(await undo.undo()).toEqual({
      ok: false,
      reason: "the workspace write did not go through",
    });
  });
});

describe("the precondition, which has to read the same in both directions", () => {
  it("accepts the arrangement at either end of the entry", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    // `after` is what is on screen while the undo is pending; `before` is what
    // is on screen once it has run and a redo is pending. `check` cannot see
    // which way it is about to go, so both have to pass.
    expect(await undo.undo()).toEqual({ ok: true });
    expect(await undo.redo()).toEqual({ ok: true });
  });

  it("refuses when the tiles have been rearranged since", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    // Another tile arrived, so neither end of this entry describes the screen
    // and putting `before` back would take that tile away with it.
    void ports.apply("w1", row("auth", "docs", "logs"));

    expect(await undo.undo()).toEqual({ ok: false, reason: "the tiles have moved since" });
  });

  it("tolerates a divider dragged since, because sizes are not the shape", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    const after = split("row", [leaf(key("auth")), leaf(key("docs"))], [0.5, 0.5]);
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    void ports.apply("w1", split("row", [leaf(key("auth")), leaf(key("docs"))], [0.8, 0.2]));

    // Refusing here would make the stack useless in exactly the workspace
    // somebody is working in. What the restore costs is the drag, which has an
    // entry of its own one press further down.
    expect(await undo.undo()).toEqual({ ok: true });
    expect(tiles(ports.tree("w1"))).toEqual(["auth", "deploy", "docs"]);
  });

  it("refuses when a session it names has been dragged into another workspace", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    const after = row("auth", "docs");
    void ports.apply("w1", after);
    void ports.apply("w2", row("deploy", "logs"));

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));

    // A session belongs to at most one workspace, and tmux-api refuses a
    // document that says otherwise — so this is the server's refusal said early
    // and in words somebody can act on.
    expect(await undo.undo()).toEqual({
      ok: false,
      reason: "that session is in another workspace now",
    });
  });

  it("refuses once the workspace has gone, rather than re-creating it sideways", async () => {
    const ports = world();
    const before = row("auth", "deploy", "docs");
    const after = row("auth", "docs");
    void ports.apply("w1", after);

    const undo = stack(ports);
    undo.push(workspaceEntry("w1", before, after));
    void ports.apply("w1", null);

    expect(await undo.undo()).toEqual({ ok: false, reason: "the tiles have moved since" });
  });
});
