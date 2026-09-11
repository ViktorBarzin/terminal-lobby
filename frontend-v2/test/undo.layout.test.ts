/**
 * Undoing the LAYOUT-shaped actions: a session dragged between groups or up
 * and down its own, a group reordered, a project created, renamed or deleted,
 * and the session-order mode.
 *
 * Every case here goes through the real handlers (`layoutUndoHandlers`) on the
 * real stack (`createUndoStore`), against a fake document and a fake PUT. What
 * the handlers are guarding is one thing, and it is the reason the entries
 * carry operations rather than documents:
 *
 *   PUT /api/layout replaces the WHOLE document and carries no version
 *   (src/store/lobby.ts:705). An undo that re-PUT the layout it captured when
 *   the action happened would erase whatever another device did in between, so
 *   these tests keep adding and removing sessions BEHIND the entry and then
 *   asserting that the undo still lands and keeps the newcomer.
 *
 * The other half is the precondition. `check` has to be tolerant of the whole
 * document changing around the entry and strict about the slice the entry
 * touched, and both halves are spelled out below: an unrelated session
 * appearing must not cost the user their undo, while the very session the entry
 * moved sitting somewhere else means somebody else has had hands on it and the
 * entry refuses rather than dragging it back.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  addProject,
  deleteProject,
  moveSession,
  renameProject,
  reorderGroups,
  groupSeqTokens,
} from "../src/components/lobby.logic";
import type { SessionOrder } from "../src/logic/order.logic";
import { layoutUndoHandlers, locate, type LayoutUndoPorts } from "../src/store/undo.layout";
import { createUndoStore, type UndoResult, type UndoStore } from "../src/store/undo";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import {
  LAYOUT_VERSION,
  emptyLayout,
  type Layout,
  type Session,
  type Snapshot,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

/**
 * The document every case starts from: two projects with the Ungrouped
 * sentinel wedged between them, so a group reorder and a project delete both
 * have a position that is not simply "first" or "last".
 *
 * Its token sequence is ["p:work", "u", "p:play", "s"] (groupSeqTokens). The
 * trailing "s" is the system group, which `deriveSidebar` materializes for the
 * sessions nobody made and `reorderGroups` pins last: it treats the final token
 * as immovable, so no drag can leave it anywhere else. Every expectation below
 * carries it for that reason, and an undo that dropped it would be a bug rather
 * than a stale fixture.
 */
const doc = (): Layout => ({
  version: LAYOUT_VERSION,
  projects: [
    { name: "work", sessions: ["alpha", "beta"] },
    { name: "play", sessions: ["gamma"], dir: "/home/wizard/play" },
  ],
  ungrouped: ["delta"],
  ungroupedIndex: 1,
});

/** A group's members as the document holds them ("" = ungrouped). */
const members = (l: Layout, group: string): string[] =>
  group === "" ? l.ungrouped : (l.projects.find((p) => p.name === group)?.sessions ?? []);

const projectNames = (l: Layout): string[] => l.projects.map((p) => p.name);

interface World {
  stack: UndoStore;
  ports: LayoutUndoPorts;
  doc(): Layout;
  order(): SessionOrder;
  /** Every document that reached the fake PUT, oldest first. */
  puts: Layout[];
  /** Make the next PUT fail, as a 500 from tmux-api does. */
  breakPut(): void;
  /** A session another device put somewhere, landing on the next poll. */
  arrive(name: string, group: string): void;
  /** A session that went away behind our back (killed on another device). */
  vanish(name: string): void;
  /** Rearrange the document the way another device would. */
  meddle(next: (l: Layout) => Layout): void;
  /** collapse-key bookkeeping, in the order the handlers asked for it. */
  collapse: string[];
}

/**
 * A document, an ordering mode and a PUT that all live in this test.
 *
 * `capture` stands in for store/lobby.ts's captureVisibleOrder over the live
 * model, which is what a switch into manual freezes. There is no sidebar here
 * to derive a model from, so a case that cares hands in the document it wants
 * the freeze to produce.
 */
function world(
  initial: Layout,
  order: SessionOrder = "manual",
  capture?: (l: Layout) => Layout,
): World {
  let cur = initial;
  let mode = order;
  let broken = false;
  const puts: Layout[] = [];
  const collapse: string[] = [];
  const ports: LayoutUndoPorts = {
    layout: () => cur,
    save: async (next) => {
      if (broken) {
        broken = false;
        return false;
      }
      puts.push(next);
      cur = next;
      return true;
    },
    order: () => mode,
    setOrder: (next) => {
      mode = next;
    },
    capture: () => (capture ? capture(cur) : cur),
    renameCollapse: (from, to) => collapse.push(`rename ${from} ${to}`),
    removeCollapse: (name) => collapse.push(`remove ${name}`),
  };
  const stack = createUndoStore({
    storage: null,
    now: () => 1_700_000_000_000,
    handlers: layoutUndoHandlers(ports),
  });
  return {
    stack,
    ports,
    doc: () => cur,
    order: () => mode,
    puts,
    collapse,
    breakPut: () => {
      broken = true;
    },
    arrive: (name, group) => {
      cur =
        group === ""
          ? { ...cur, ungrouped: [...cur.ungrouped, name] }
          : {
              ...cur,
              projects: cur.projects.map((p) =>
                p.name === group ? { ...p, sessions: [...p.sessions, name] } : p,
              ),
            };
    },
    vanish: (name) => {
      cur = {
        ...cur,
        projects: cur.projects.map((p) => ({
          ...p,
          sessions: p.sessions.filter((s) => s !== name),
        })),
        ungrouped: cur.ungrouped.filter((s) => s !== name),
      };
    },
    meddle: (next) => {
      cur = next(cur);
    },
  };
}

const expectOk = async (r: Promise<UndoResult>): Promise<void> => {
  expect(await r).toEqual({ ok: true });
};

const expectRefusal = async (r: Promise<UndoResult>, why: RegExp): Promise<void> => {
  const out = await r;
  expect(out.ok).toBe(false);
  expect(out.ok === false ? out.reason : null).toMatch(why);
};

// ---- the actions, performed exactly as store/lobby.ts performs them --------
// Each helper writes the document through the same pure transform the store
// uses and then pushes the same entry the store pushes, so a divergence
// between these and the store shows up as a wiring bug rather than being
// papered over here.

async function drag(
  w: World,
  session: string,
  group: string,
  index: number,
  flipsToManual = false,
): Promise<void> {
  const from = locate(w.doc(), session);
  const before = w.order();
  const next = moveSession(w.doc(), session, group, index);
  if (flipsToManual) w.ports.setOrder("manual");
  await w.ports.save(next);
  const to = locate(next, session);
  w.stack.push({
    kind: "move",
    session,
    ...(from ? { fromGroup: from.group } : null),
    fromIndex: from?.index ?? -1,
    toGroup: group,
    toIndex: to?.index ?? -1,
    ...(flipsToManual ? { orderBefore: before } : null),
  });
}

async function dragGroup(w: World, from: number, to: number): Promise<void> {
  const token = groupSeqTokens(w.doc())[from]!;
  await w.ports.save(reorderGroups(w.doc(), from, to));
  w.stack.push({ kind: "reorderGroups", from, to, group: token });
}

async function makeProject(w: World, name: string, dir?: string): Promise<void> {
  await w.ports.save(addProject(w.doc(), name, dir));
  w.stack.push({ kind: "projectCreate", name, ...(dir ? { dir } : null) });
}

async function retitleProject(w: World, from: string, to: string): Promise<void> {
  await w.ports.save(renameProject(w.doc(), from, to));
  w.stack.push({ kind: "projectRename", from, to });
}

async function dropProject(w: World, name: string): Promise<void> {
  const cur = w.doc();
  const doomed = cur.projects.find((p) => p.name === name)!;
  const index = groupSeqTokens(cur).indexOf("p:" + name);
  await w.ports.save(deleteProject(cur, name));
  w.stack.push({
    kind: "projectDelete",
    name,
    ...(doomed.dir ? { dir: doomed.dir } : null),
    index,
    sessions: [...doomed.sessions],
  });
}

async function pickManual(w: World): Promise<void> {
  const before = w.order();
  const over = w.doc();
  const wrote = w.ports.capture();
  await w.ports.save(wrote);
  w.ports.setOrder("manual");
  w.stack.push({
    kind: "orderMode",
    before,
    after: "manual",
    capturedLayout: { over, wrote },
  });
}

// ---- round trips ----------------------------------------------------------

describe("moving a session — round trip", () => {
  it("puts the session back in the group and the seat it came from", async () => {
    const w = world(doc());
    await drag(w, "delta", "work", 1);
    expect(members(w.doc(), "work")).toEqual(["alpha", "delta", "beta"]);
    expect(members(w.doc(), "")).toEqual([]);

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "work")).toEqual(["alpha", "beta"]);
    expect(members(w.doc(), "")).toEqual(["delta"]);

    await expectOk(w.stack.redo());
    expect(members(w.doc(), "work")).toEqual(["alpha", "delta", "beta"]);
    expect(members(w.doc(), "")).toEqual([]);
  });

  it("puts a reorder inside one group back in its old seat", async () => {
    // The same entry covers both: a drag that names a position within the
    // group it is already in is a move whose fromGroup and toGroup agree.
    const w = world(doc());
    await drag(w, "beta", "work", 0);
    expect(members(w.doc(), "work")).toEqual(["beta", "alpha"]);
    await expectOk(w.stack.undo());
    expect(members(w.doc(), "work")).toEqual(["alpha", "beta"]);
  });

  it("takes a session the layout had never placed back out of the document", async () => {
    // A session the layout does not name renders as a swept-in leftover
    // (components/lobby.logic.ts deriveSidebar). Dragging one is the first time
    // it acquires a raw entry, so its inverse is a REMOVAL: putting it back
    // where it was means the document not naming it, which is what leaves the
    // sweep free to place it again.
    // epsilon is on screen and in nobody's list, which is the state the
    // document describes by not mentioning it at all.
    const w = world({ ...doc(), ungrouped: [] });
    await drag(w, "epsilon", "play", 0);
    expect(members(w.doc(), "play")).toEqual(["epsilon", "gamma"]);

    await expectOk(w.stack.undo());
    expect(locate(w.doc(), "epsilon")).toBeNull();

    await expectOk(w.stack.redo());
    expect(members(w.doc(), "play")).toEqual(["epsilon", "gamma"]);
  });
});

describe("moving a session — the precondition", () => {
  it("still undoes when an unrelated session has appeared since", async () => {
    // Another device created a session and the poll has landed. It shifts every
    // index below it, and it has nothing to do with this entry: refusing here
    // would cost the user their undo for somebody else's create.
    const w = world(doc());
    await drag(w, "delta", "work", 0);
    w.arrive("epsilon", "work");
    w.arrive("zeta", "play");

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "work")).toEqual(["alpha", "beta", "epsilon"]);
    expect(members(w.doc(), "")).toEqual(["delta"]);
    // and the newcomer survived the write, which is the whole reason an entry
    // holds an operation rather than the document it was looking at
    expect(members(w.doc(), "play")).toEqual(["gamma", "zeta"]);
  });

  it("still undoes when an unrelated session has vanished since", async () => {
    const w = world(doc());
    await drag(w, "delta", "play", 0);
    w.vanish("alpha"); // killed on another device

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "")).toEqual(["delta"]);
    expect(members(w.doc(), "work")).toEqual(["beta"]);
  });

  it("refuses when the session it moved has been moved again by somebody else", async () => {
    const w = world(doc());
    await drag(w, "delta", "work", 0);
    w.meddle((l) => moveSession(l, "delta", "play", 0));

    await expectRefusal(w.stack.undo(), /moved/);
    // and the meddling stands: a refusal writes nothing
    expect(members(w.doc(), "play")).toEqual(["delta", "gamma"]);
    expect(w.puts).toHaveLength(1);
  });

  it("refuses when the session it moved is gone", async () => {
    const w = world(doc());
    await drag(w, "delta", "work", 0);
    w.vanish("delta");
    await expectRefusal(w.stack.undo(), /gone/);
  });

  it("refuses when the PUT does not land, and leaves the ordering alone", async () => {
    const w = world(doc(), "created");
    await drag(w, "delta", "work", 0, true);
    expect(w.order()).toBe("manual");
    w.breakPut();
    await expectRefusal(w.stack.undo(), /did not go through/);
    // the mode it changed on the way in has to come back with the rolled-back
    // write, or the sidebar is left in an order the server never took
    expect(w.order()).toBe("manual");
  });
});

describe("moving a session — the ordering mode rides along", () => {
  it("takes the sidebar out of manual when it undoes the drag that put it there", async () => {
    // A drag does not only reorder: a drop that names a position hands ordering
    // back to the user (store/lobby.ts:1009), because a timestamp sort would
    // put the card straight back. Undoing the drag without undoing that leaves
    // the list stuck in manual for good, with nothing on screen saying why.
    const w = world(doc(), "created");
    await drag(w, "delta", "work", 0, true);
    expect(w.order()).toBe("manual");

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
    expect(members(w.doc(), "")).toEqual(["delta"]);

    await expectOk(w.stack.redo());
    expect(w.order()).toBe("manual");
  });

  it("leaves the mode alone for a drag that never touched it", async () => {
    // "Move to…" from the card menu names a group and no position, so it asks
    // for no ordering change and its undo must not invent one.
    const w = world(doc(), "created");
    await drag(w, "delta", "work", -1);
    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
  });
});

describe("reordering the groups — round trip", () => {
  it("puts the group back in the slot it was dragged out of", async () => {
    const w = world(doc());
    await dragGroup(w, 2, 0); // play to the top
    expect(groupSeqTokens(w.doc())).toEqual(["p:play", "p:work", "u", "s"]);

    await expectOk(w.stack.undo());
    expect(groupSeqTokens(w.doc())).toEqual(["p:work", "u", "p:play", "s"]);

    await expectOk(w.stack.redo());
    expect(groupSeqTokens(w.doc())).toEqual(["p:play", "p:work", "u", "s"]);
  });

  it("moves the group it named, not whatever now sits at that index", async () => {
    // A project created since shifts every token below it. The entry knows
    // which token it moved, so the inverse still moves that one.
    const w = world(doc());
    await dragGroup(w, 2, 0);
    w.meddle((l) => addProject(l, "later"));

    await expectOk(w.stack.undo());
    expect(projectNames(w.doc())).toContain("later");
    expect(groupSeqTokens(w.doc()).indexOf("p:play")).toBeGreaterThan(
      groupSeqTokens(w.doc()).indexOf("p:work"),
    );
  });

  it("refuses when the group it moved has been deleted since", async () => {
    const w = world(doc());
    await dragGroup(w, 2, 0);
    w.meddle((l) => deleteProject(l, "play"));
    await expectRefusal(w.stack.undo(), /gone/);
  });

  it("does not touch the session ordering, because a group reorder never did", async () => {
    // Unlike a session drag, reorderGroupsTo writes the layout and nothing else
    // (store/lobby.ts:1017): `sidebar.order` orders sessions WITHIN a group, so
    // the group sequence is the same under all three orderings.
    const w = world(doc(), "created");
    await dragGroup(w, 2, 0);
    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
  });
});

describe("creating a project — round trip", () => {
  it("removes the project again, and puts it back on redo", async () => {
    const w = world(doc());
    await makeProject(w, "notes", "/home/wizard/notes");
    expect(projectNames(w.doc())).toEqual(["work", "notes", "play"]);

    await expectOk(w.stack.undo());
    expect(projectNames(w.doc())).toEqual(["work", "play"]);
    expect(w.collapse).toEqual(["remove notes"]);

    await expectOk(w.stack.redo());
    expect(w.doc().projects.find((p) => p.name === "notes")).toEqual({
      name: "notes",
      sessions: [],
      dir: "/home/wizard/notes",
    });
  });

  it("refuses to un-create a project somebody has since put sessions in", async () => {
    // Deleting it would tip those sessions into Ungrouped, which is not what
    // "undo my create" asked for. The drag that put them there is its own entry
    // and comes off the stack first, so the ordinary path never sees this.
    const w = world(doc());
    await makeProject(w, "notes");
    w.meddle((l) => moveSession(l, "delta", "notes", 0));
    await expectRefusal(w.stack.undo(), /sessions in it/);
    expect(projectNames(w.doc())).toContain("notes");
  });

  it("refuses to un-create a project somebody has already deleted", async () => {
    // `check` cannot answer this one: an absent project reads the same as the
    // ordinary state a redo starts from, so the guard lives in `undo`, where
    // the direction is known. Deleting nothing would still cost a PUT and
    // still say the undo worked.
    const w = world(doc());
    await makeProject(w, "notes");
    w.meddle((l) => deleteProject(l, "notes")); // deleted on another device

    await expectRefusal(w.stack.undo(), /already gone/);
    expect(w.collapse).toEqual([]);
  });

  it("refuses to re-create a project whose name has been taken since", async () => {
    const w = world(doc());
    await makeProject(w, "notes");
    await expectOk(w.stack.undo());
    w.meddle((l) => addProject(l, "notes"));
    await expectRefusal(w.stack.redo(), /exists/);
  });
});

describe("renaming a project — round trip", () => {
  it("puts the old name back, and carries the collapse key both ways", async () => {
    // Collapse is keyed on the project NAME (store/lobby.ts:1044), a
    // per-browser view preference rather than layout, so it has to travel with
    // the rename in both directions.
    const w = world(doc());
    await retitleProject(w, "work", "job");
    expect(projectNames(w.doc())).toEqual(["job", "play"]);

    await expectOk(w.stack.undo());
    expect(projectNames(w.doc())).toEqual(["work", "play"]);
    expect(members(w.doc(), "work")).toEqual(["alpha", "beta"]);

    await expectOk(w.stack.redo());
    expect(projectNames(w.doc())).toEqual(["job", "play"]);
    expect(w.collapse).toEqual(["rename job work", "rename work job"]);
  });

  it("refuses when the old name has been taken by a new project", async () => {
    const w = world(doc());
    await retitleProject(w, "work", "job");
    w.meddle((l) => addProject(l, "work"));
    await expectRefusal(w.stack.undo(), /exists/);
    expect(projectNames(w.doc())).toContain("job");
  });

  it("refuses when the project has gone away entirely", async () => {
    const w = world(doc());
    await retitleProject(w, "work", "job");
    w.meddle((l) => deleteProject(l, "job"));
    await expectRefusal(w.stack.undo(), /gone/);
  });
});

describe("deleting a project — round trip", () => {
  it("puts back its position, its directory and its members in order", async () => {
    // The delete tipped gamma into Ungrouped and took the slot with it, so all
    // three have to come back: the project in the same seat among the groups,
    // its dir, and its sessions in the order it held them.
    const w = world(doc());
    await dropProject(w, "play");
    expect(projectNames(w.doc())).toEqual(["work"]);
    expect(members(w.doc(), "")).toEqual(["delta", "gamma"]);

    await expectOk(w.stack.undo());
    expect(w.doc()).toEqual(doc());

    await expectOk(w.stack.redo());
    expect(projectNames(w.doc())).toEqual(["work"]);
    expect(members(w.doc(), "")).toEqual(["delta", "gamma"]);
  });

  it("restores a project that sat first among the groups", async () => {
    const w = world(doc());
    await dropProject(w, "work");
    expect(groupSeqTokens(w.doc())).toEqual(["u", "p:play", "s"]);

    await expectOk(w.stack.undo());
    expect(groupSeqTokens(w.doc())).toEqual(["p:work", "u", "p:play", "s"]);
    expect(members(w.doc(), "work")).toEqual(["alpha", "beta"]);
    expect(members(w.doc(), "")).toEqual(["delta"]);
  });

  it("leaves behind a member somebody has since filed somewhere else", async () => {
    // beta went to another project after the delete. It is not this entry's to
    // take back: restoring membership means the sessions still sitting where
    // the delete dropped them, and nothing else.
    const w = world(doc());
    await dropProject(w, "work");
    w.meddle((l) => moveSession(l, "beta", "play", 0));

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "work")).toEqual(["alpha"]);
    expect(members(w.doc(), "play")).toEqual(["beta", "gamma"]);
  });

  it("skips a member that was killed after the delete", async () => {
    const w = world(doc());
    await dropProject(w, "work");
    w.vanish("alpha");

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "work")).toEqual(["beta"]);
    expect(members(w.doc(), "")).toEqual(["delta"]);
  });

  it("keeps a session that arrived in Ungrouped meanwhile", async () => {
    const w = world(doc());
    await dropProject(w, "work");
    w.arrive("epsilon", "");

    await expectOk(w.stack.undo());
    expect(members(w.doc(), "")).toEqual(["delta", "epsilon"]);
  });

  it("refuses when the name has been taken by a new project", async () => {
    const w = world(doc());
    await dropProject(w, "work");
    w.meddle((l) => addProject(l, "work"));
    await expectRefusal(w.stack.undo(), /exists/);
    expect(members(w.doc(), "work")).toEqual([]);
  });

  it("refuses to delete it again once it is already gone", async () => {
    const w = world(doc());
    await dropProject(w, "work");
    await expectOk(w.stack.undo());
    w.meddle((l) => deleteProject(l, "work"));
    await expectRefusal(w.stack.redo(), /gone/);
  });
});

describe("switching the session order mode — round trip", () => {
  /** What the freeze produces: the visible order folded into the layout. */
  const frozen = (l: Layout): Layout => ({
    ...l,
    projects: l.projects.map((p) => ({ ...p, sessions: [...p.sessions].reverse() })),
  });

  it("puts the arrangement the freeze wrote over back, and the mode with it", async () => {
    // Switching into manual freezes what is on screen into the layout, exactly
    // as a positioned drop does, so the list does not jump. That overwrites
    // whatever manual arrangement was saved before, which is what the undo has
    // to give back.
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    expect(members(w.doc(), "work")).toEqual(["beta", "alpha"]);
    expect(w.order()).toBe("manual");

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
    expect(w.doc()).toEqual(doc());

    await expectOk(w.stack.redo());
    expect(w.order()).toBe("manual");
    expect(members(w.doc(), "work")).toEqual(["beta", "alpha"]);
  });

  it("refuses once the arrangement it froze has been rearranged", async () => {
    // Restoring the old arrangement is the one inverse here that has to write a
    // whole document, so it only runs while the document is still the one the
    // freeze wrote. Anything else and the entry refuses rather than clobbering.
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    w.meddle((l) => moveSession(l, "delta", "work", 0));
    await expectRefusal(w.stack.undo(), /arrangement/);
    expect(w.order()).toBe("manual");
  });

  it("refuses when the mode is no longer either end of the switch", async () => {
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    w.ports.setOrder("active"); // picked on another device, roamed back
    await expectRefusal(w.stack.undo(), /order/);
  });

  /**
   * The mode ROAMS. It is the `sidebar.order` pref, so another device can move
   * it while this tab still holds the entry, and it can land back on the mode
   * the switch came FROM. `check` reads that as an ordinary starting point (it
   * cannot see which direction it is about to run), which used to skip the
   * arrangement guard entirely and leave the undo free to PUT a document
   * captured before the other device's session existed.
   */
  it("refuses the restore when the mode roamed back and the arrangement moved on", async () => {
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    w.ports.setOrder("created"); // picked on the phone, roamed back here
    w.meddle((l) => moveSession(l, "delta", "work", 0)); // and rearranged there

    await expectRefusal(w.stack.undo(), /arrangement/);

    // The freeze's own PUT and nothing after it: the phone's placement stands.
    expect(w.puts).toHaveLength(1);
    expect(members(w.doc(), "work")).toEqual(["delta", "beta", "alpha"]);
  });

  it("still restores when the mode roamed back but nobody touched the arrangement", async () => {
    // The guard is about the DOCUMENT, not about the mode: the restore is safe
    // exactly while the live document is still the one the freeze wrote, and
    // then it is a restore rather than a blind write.
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    w.ports.setOrder("created");

    await expectOk(w.stack.undo());
    expect(w.doc()).toEqual(doc());
  });

  it("keeps the mode it had when the restoring PUT fails", async () => {
    // Both halves have to move together. A mode left on `before` with the
    // frozen arrangement still in the document is a sidebar sorted by a rule
    // nobody picked.
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    w.breakPut();

    await expectRefusal(w.stack.undo(), /layout write/);
    expect(w.order()).toBe("manual");
    expect(members(w.doc(), "work")).toEqual(["beta", "alpha"]);
  });

  it("leaves the mode alone when the redo's freeze fails to write", async () => {
    const w = world(doc(), "created", frozen);
    await pickManual(w);
    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
    w.breakPut();

    await expectRefusal(w.stack.redo(), /layout write/);
    // Not switched into manual on a freeze that never landed: the list would
    // then be in manual order over the arrangement the undo restored.
    expect(w.order()).toBe("created");
    expect(w.doc()).toEqual(doc());
  });

  it("just flips the mode back when the switch froze nothing", async () => {
    // manual to created and back writes no layout at all: the arrangement is
    // still in the document, the sort is simply deciding the order instead.
    const w = world(doc(), "manual");
    w.ports.setOrder("created");
    w.stack.push({ kind: "orderMode", before: "manual", after: "created" });

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("manual");
    expect(w.puts).toHaveLength(0);

    await expectOk(w.stack.redo());
    expect(w.order()).toBe("created");
    expect(w.puts).toHaveLength(0);
  });
});

// ---- the store records them ------------------------------------------------
// The handlers above are exercised against fake ports. These cases run the
// REAL store actions against a fake api, because the entry has to describe what
// the action actually did: a fromIndex read after the write, or a mode flip the
// entry did not carry, is a bug no handler test can see.

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  putError = false;

  async whoami() {
    return this.whoamiVal;
  }
  async listSessions() {
    return this.sessionsVal;
  }
  async getLayout() {
    return this.layoutVal;
  }
  async putLayout(l: Layout) {
    if (this.putError) throw new ApiError(500, "nope");
    this.puts.push(l);
    this.layoutVal = l;
  }
  async killSession(_name: string) {}
  async setSessionOrigin() {}
  async setSessionTitle(_name: string, _title: string) {}
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
  async restoreSessions(_sel?: { snapshot: string; sessions: string[] }) {}
  async listSnapshots() {
    return { snapshots: [] as Snapshot[], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot(_ts: string) {
    return [] as SnapshotRow[];
  }
}

const sess = (name: string, created: number): Session => ({
  name,
  attached: 0,
  lastActivity: created,
  created,
  owner: "wizard",
});

interface Wired {
  store: LobbyStore;
  stack: UndoStore;
  api: FakeApi;
  order(): SessionOrder;
}

/** The store as App wires it, with a stack and the ordering pref behind it. */
async function wire(initial: Layout, sessions: Session[], mode: SessionOrder): Promise<Wired> {
  const api = new FakeApi();
  api.layoutVal = initial;
  api.sessionsVal = sessions;
  const stack = createUndoStore({ storage: null });
  let store!: LobbyStore;
  let order!: () => SessionOrder;
  const dispose = createRoot((d) => {
    const [get, set] = createSignal<SessionOrder>(mode);
    order = get;
    store = createLobbyStore({
      api,
      autoStart: false,
      syncHash: false,
      sessionOrder: get,
      setSessionOrder: set,
      undo: stack,
    });
    return d;
  });
  onTestFinished(() => {
    store.dispose();
    dispose();
  });
  await store.refresh();
  return { store, stack, api, order };
}

describe("the store records what it did", () => {
  const two = (): Session[] => [sess("alpha", 100), sess("beta", 500)];
  const oneProject = (): Layout => ({
    ...emptyLayout(),
    projects: [{ name: "work", sessions: ["alpha", "beta"] }],
    ungroupedIndex: 1,
  });

  it("undoes a drag, and takes the ordering mode back with it", async () => {
    // The drop names a position, so the store freezes what is on screen and
    // hands ordering back to the user on the way in. Undoing the drag has to
    // hand it back again, and this is the case that catches an entry that
    // forgot to carry the mode: without it the sidebar stays in manual for
    // good, with nothing on screen saying why.
    const w = await wire(
      { ...oneProject(), projects: [{ name: "work", sessions: ["alpha", "beta", "gamma"] }] },
      [...two(), sess("gamma", 900)],
      "created",
    );
    await w.store.move("alpha", "work", { name: "gamma", side: "above" });
    expect(w.order()).toBe("manual");
    expect(members(w.api.layoutVal, "work")).toEqual(["alpha", "gamma", "beta"]);

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
    // The seat the card came from, in the arrangement the drag started from,
    // which is the frozen one and so newest first. What the freeze wrote over is NOT
    // restored: under a timestamp ordering the layout's arrangement is not on
    // screen at all, and putting the old document back is the blind
    // whole-document write these entries exist to avoid.
    expect(members(w.api.layoutVal, "work")).toEqual(["gamma", "beta", "alpha"]);
  });

  it("records nothing when the PUT fails", async () => {
    const w = await wire(oneProject(), two(), "manual");
    w.api.putError = true;
    await w.store.move("beta", "", undefined);
    expect(w.stack.canUndo()).toBe(false);
  });

  it("records nothing for a drop that moved no card", async () => {
    // The card was dropped back above the one it already sat above. A Cmd+Z
    // press has better things to spend itself on.
    const w = await wire(oneProject(), two(), "manual");
    await w.store.move("alpha", "work", { name: "beta", side: "above" });
    expect(w.stack.canUndo()).toBe(false);
  });

  it("undoes a project create, a rename and a delete", async () => {
    const w = await wire(oneProject(), two(), "manual");
    await w.store.createProject("notes", "/home/wizard/notes");
    await w.store.renameProjectAction("notes", "ideas");
    await w.store.deleteProjectAction("ideas");
    expect(projectNames(w.api.layoutVal)).toEqual(["work"]);

    await expectOk(w.stack.undo()); // the delete
    expect(w.api.layoutVal.projects.find((p) => p.name === "ideas")).toEqual({
      name: "ideas",
      sessions: [],
      dir: "/home/wizard/notes",
    });
    await expectOk(w.stack.undo()); // the rename
    expect(projectNames(w.api.layoutVal)).toEqual(["work", "notes"]);
    await expectOk(w.stack.undo()); // the create
    expect(projectNames(w.api.layoutVal)).toEqual(["work"]);
  });

  it("undoes a group reorder", async () => {
    const w = await wire(
      {
        ...oneProject(),
        projects: [
          { name: "work", sessions: ["alpha"] },
          { name: "play", sessions: ["beta"] },
        ],
      },
      two(),
      "manual",
    );
    await w.store.reorderGroupsTo(2, 0);
    expect(groupSeqTokens(w.api.layoutVal)).toEqual(["p:play", "p:work", "u", "s"]);
    await expectOk(w.stack.undo());
    expect(groupSeqTokens(w.api.layoutVal)).toEqual(["p:work", "u", "p:play", "s"]);
  });

  it("freezes the visible order when the picker goes manual, and undoes the freeze", async () => {
    // Newest-first has beta above alpha on screen while the layout says the
    // opposite. Switching to manual writes what is on screen, so no card moves
    // under the user; undoing it gives the old arrangement back along with the
    // ordering that was hiding it.
    const w = await wire(oneProject(), two(), "created");
    await w.store.setSessionOrderMode("manual");
    expect(w.order()).toBe("manual");
    expect(members(w.api.layoutVal, "work")).toEqual(["beta", "alpha"]);

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("created");
    expect(members(w.api.layoutVal, "work")).toEqual(["alpha", "beta"]);
  });

  it("writes no layout for a switch out of manual", async () => {
    const w = await wire(oneProject(), two(), "manual");
    const puts = w.api.puts.length;
    await w.store.setSessionOrderMode("active");
    expect(w.order()).toBe("active");
    expect(w.api.puts.length).toBe(puts);

    await expectOk(w.stack.undo());
    expect(w.order()).toBe("manual");
  });

  it("records nothing when the same ordering is picked again", async () => {
    const w = await wire(oneProject(), two(), "created");
    await w.store.setSessionOrderMode("created");
    expect(w.stack.canUndo()).toBe(false);
  });
});

describe("every kind, back to front", () => {
  /**
   * The stack is one sequence, and the actions in it interleave in real use.
   * This walks six actions in and six presses back out, which is the case that
   * catches a handler whose undo depends on the world having stood still since
   * its own action.
   */
  it("unwinds six mixed actions in reverse and lands on the document it started from", async () => {
    const w = world(doc());
    const before = doc();

    await drag(w, "delta", "work", 0);
    await dragGroup(w, 2, 0);
    await makeProject(w, "notes");
    await retitleProject(w, "notes", "ideas");
    await drag(w, "gamma", "ideas", 0);
    await dropProject(w, "work");
    const after = w.doc();

    for (let i = 0; i < 6; i++) await expectOk(w.stack.undo());
    expect(w.doc()).toEqual(before);
    expect(w.stack.canUndo()).toBe(false);

    for (let i = 0; i < 6; i++) await expectOk(w.stack.redo());
    expect(w.doc()).toEqual(after);
    expect(members(w.doc(), "ideas")).toEqual(["gamma"]);
    expect(members(w.doc(), "")).toEqual(["delta", "alpha", "beta"]);
  });
});
