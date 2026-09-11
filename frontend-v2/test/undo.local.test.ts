/**
 * Undoing the two pieces of per-browser VIEW state that a person changes on
 * purpose: a sidebar group collapsed or expanded, and watch mode switched on a
 * session.
 *
 * Neither touches the server, so there is no document to guard and no write
 * that can fail. What is left to get right is the value: a toggle whose
 * inverse is derived from the wrong end of the switch is silent and wrong, and
 * watch mode has THREE states rather than two (`true`, `false`, and "nobody
 * has said", store/watchmode.ts), so an entry that remembered only the old
 * value would redo a switch to watching after a person had chosen to drive.
 * Both directions are therefore written down, and both are asserted here.
 *
 * TWO, AND NOT FOUR. The batch this came from also named mark-seen and a pin.
 * Neither is here on purpose, and the reasons are in store/undo.local.ts: a
 * visit is stamped automatically rather than chosen, and no pin feature exists
 * in this tree at all. The last case in this file is what holds that line.
 */
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { UNGROUPED_KEY, createCollapseStore, type CollapseStore } from "../src/store/collapse";
import { createUndoStore, type UndoResult, type UndoStore } from "../src/store/undo";
import { localUndoHandlers, type LocalUndoPorts } from "../src/store/undo.local";
import { createVisitStore } from "../src/store/visits";
import {
  applyWatch,
  loadWatch,
  saveWatch,
  setWatchUndo,
  type WatchChoice,
} from "../src/store/watchmode";

interface World {
  stack: UndoStore;
  ports: LocalUndoPorts;
  /** Every write that reached the fake stores, oldest first. */
  writes: string[];
  collapsed(group: string): boolean;
  watch(session: string, as?: string): WatchChoice;
  /** Somebody else's hands: another tab, or the session bar. */
  meddleCollapse(group: string, collapsed: boolean): void;
  meddleWatch(session: string, choice: WatchChoice, as?: string): void;
}

/** A collapse map and a watch map that live in this test, keyed as the real
 *  ones are: collapse per OS user, watch per session and act-as target. */
function world(user = "wizard"): World {
  const who = user;
  const groups = new Set<string>();
  const watches = new Map<string, WatchChoice>();
  const writes: string[] = [];
  const key = (session: string, as: string) => (as ? `as:${as}:${session}` : session);

  const ports: LocalUndoPorts = {
    collapseUser: () => who,
    isCollapsed: (group) => groups.has(group),
    setCollapsed: (group, collapsed) => {
      if (groups.has(group) === collapsed) return;
      writes.push(`collapse ${group} ${collapsed}`);
      if (collapsed) groups.add(group);
      else groups.delete(group);
    },
    watchChoice: (session, as) => watches.get(key(session, as)),
    setWatchChoice: (session, choice, as) => {
      writes.push(`watch ${key(session, as)} ${String(choice)}`);
      watches.set(key(session, as), choice);
    },
  };

  return {
    stack: createUndoStore({
      storage: null,
      now: () => 1_700_000_000_000,
      handlers: localUndoHandlers(ports),
    }),
    ports,
    writes,
    collapsed: (group) => groups.has(group),
    watch: (session, as = "") => watches.get(key(session, as)),
    meddleCollapse: (group, collapsed) => {
      if (collapsed) groups.add(group);
      else groups.delete(group);
    },
    meddleWatch: (session, choice, as = "") => watches.set(key(session, as), choice),
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

/** The toggle, as store/collapse.ts performs it: read the old value, flip it,
 *  record what it was. */
function toggleGroup(w: World, group: string, user = "wizard"): void {
  const was = w.ports.isCollapsed(group);
  w.ports.setCollapsed(group, !was);
  w.stack.push({ kind: "collapse", user, group, was });
}

/** The switch, as store/watchmode.ts performs it. */
function switchWatch(w: World, session: string, to: WatchChoice, as = ""): void {
  const was = w.ports.watchChoice(session, as);
  w.ports.setWatchChoice(session, to, as);
  w.stack.push({
    kind: "watch",
    session,
    ...(was !== undefined ? { was } : null),
    ...(to !== undefined ? { to } : null),
    ...(as ? { as } : null),
  });
}

describe("undoing a collapse", () => {
  it("expands the group it collapsed, and collapses it again on redo", async () => {
    const w = world();
    toggleGroup(w, "work");
    expect(w.collapsed("work")).toBe(true);

    await expectOk(w.stack.undo());
    expect(w.collapsed("work")).toBe(false);

    await expectOk(w.stack.redo());
    expect(w.collapsed("work")).toBe(true);
  });

  it("collapses the group it expanded", async () => {
    // The other end of the same toggle, which is the case an inverse derived
    // from "collapse it" rather than from `was` gets wrong.
    const w = world();
    w.meddleCollapse("work", true);
    toggleGroup(w, "work");
    expect(w.collapsed("work")).toBe(false);

    await expectOk(w.stack.undo());
    expect(w.collapsed("work")).toBe(true);
  });

  it("takes the sentinel groups as readily as a project", async () => {
    const w = world();
    toggleGroup(w, UNGROUPED_KEY);
    await expectOk(w.stack.undo());
    expect(w.collapsed(UNGROUPED_KEY)).toBe(false);
  });

  it("writes nothing when the group is already where the undo would put it", async () => {
    // Somebody expanded it from another tab, or auto-expand-on-activate did.
    // The press asks for a state the group already holds, so there is nothing
    // to do and nothing to complain about.
    const w = world();
    toggleGroup(w, "work");
    w.meddleCollapse("work", false);
    const writes = w.writes.length;

    await expectOk(w.stack.undo());
    expect(w.writes).toHaveLength(writes);
    expect(w.collapsed("work")).toBe(false);
  });

  it("refuses when the sidebar belongs to another account now", async () => {
    // The map is keyed per OS user (`tmux-collapsed-<user>`), so undoing this
    // against a different one would flip a group in an account the entry says
    // nothing about.
    const w = world("wizard");
    toggleGroup(w, "work", "emo");
    await expectRefusal(w.stack.undo(), /account/);
    expect(w.collapsed("work")).toBe(true);
  });
});

describe("undoing a watch-mode switch", () => {
  it("puts the session back to no choice recorded", async () => {
    // The three-state part. A session nobody has chosen for resolves
    // automatically (store/watchmode.ts resolveWatch), and `false` means "I
    // chose to drive", a distinct answer, so an undo that wrote `false` here
    // would leave behind a decision the person never made.
    const w = world();
    switchWatch(w, "main", true);
    expect(w.watch("main")).toBe(true);

    await expectOk(w.stack.undo());
    expect(w.watch("main")).toBeUndefined();

    await expectOk(w.stack.redo());
    expect(w.watch("main")).toBe(true);
  });

  it("puts a taken-control session back to no choice recorded", async () => {
    // undefined → false, the case an entry that only remembered `was` would
    // redo as a switch to watching, since `!undefined` is `true`.
    const w = world();
    switchWatch(w, "main", false);

    await expectOk(w.stack.undo());
    expect(w.watch("main")).toBeUndefined();

    await expectOk(w.stack.redo());
    expect(w.watch("main")).toBe(false);
  });

  it("puts an explicit choice back", async () => {
    const w = world();
    w.meddleWatch("main", true);
    switchWatch(w, "main", false);

    await expectOk(w.stack.undo());
    expect(w.watch("main")).toBe(true);
  });

  it("refuses when the choice changed under it", async () => {
    // The same session's switch is on two surfaces (the session bar and the
    // card's menu) and the state is shared with every other tab in this
    // browser, so a press that arrives after somebody chose again would
    // silently overwrite that choice.
    const w = world();
    switchWatch(w, "main", true);
    w.meddleWatch("main", false);

    await expectRefusal(w.stack.undo(), /watch/);
    expect(w.watch("main")).toBe(false);
  });

  it("writes back in the namespace the switch wrote in", async () => {
    // A lens keeps its own keys, so a decision about bob's `code` cannot land
    // on your own session of that name. Undo is off in a lens tab today
    // (store/undo.ts UndoStoreOptions), so this is the entry holding its own
    // half of the contract rather than a path a person can reach.
    const w = world();
    w.meddleWatch("code", false); // your own `code`
    switchWatch(w, "code", true, "bob");

    await expectOk(w.stack.undo());
    expect(w.watch("code", "bob")).toBeUndefined();
    expect(w.watch("code")).toBe(false);
  });
});

// ---- the stores record them ------------------------------------------------
// The cases above drive the handlers against fake maps. These run the REAL
// stores against localStorage, because the push site is half the feature: an
// entry recorded by the automatic path, or a missing one on the path a person
// clicks, is a bug no handler test can see.

/** The real stores, wired to a stack the way store/lobby.ts wires them. */
function realWorld(user = "wizard"): { stack: UndoStore; collapse: CollapseStore } {
  // Late-bound on purpose: the stack's handlers reach the collapse store and
  // the collapse store records into the stack, so one of the two has to be
  // named before it exists. store/lobby.ts holds the same pair and resolves it
  // the same way, by building the store and registering the handlers around it.
  let collapse!: CollapseStore;
  const stack = createUndoStore({
    storage: null,
    handlers: localUndoHandlers({
      collapseUser: () => user,
      isCollapsed: (group) => collapse.isCollapsed(group),
      setCollapsed: (group, on) => collapse.set(group, on),
      watchChoice: (session, as) => loadWatch(session, as),
      setWatchChoice: (session, choice, as) => applyWatch(session, choice, as),
    }),
  });
  collapse = createCollapseStore(() => user, stack);
  setWatchUndo(stack);
  onTestFinished(() => setWatchUndo(null));
  return { stack, collapse };
}

describe("the stores record what they did", () => {
  beforeEach(() => localStorage.clear());

  it("records a collapse the user clicked, and undoes it through the real store", async () => {
    const { stack, collapse } = realWorld();
    collapse.toggle("work");
    expect(collapse.isCollapsed("work")).toBe(true);

    await expectOk(stack.undo());
    expect(collapse.isCollapsed("work")).toBe(false);
    // and it went where a click goes, so a reload keeps the undone state
    expect(localStorage.getItem("tmux-collapsed-wizard")).toBe("[]");

    await expectOk(stack.redo());
    expect(collapse.isCollapsed("work")).toBe(true);
  });

  it("records nothing for a collapse change nobody asked for", () => {
    // auto-expand-on-activate opens the group a selected session sits in, and
    // `set` is the path the inverse itself runs on. Neither is a person
    // collapsing anything: an entry for the first would spend a Cmd+Z press
    // undoing a navigation, and one for the second would undo the undo.
    const { stack, collapse } = realWorld();
    collapse.toggle("work");
    expect(stack.canUndo()).toBe(true);
    stack.clear();

    collapse.expand("work");
    collapse.set("work", true);
    collapse.set("work", false);
    expect(stack.canUndo()).toBe(false);
  });

  it("records a watch switch, and nothing when the same choice is saved again", async () => {
    const { stack } = realWorld();
    saveWatch("main", true);
    expect(loadWatch("main")).toBe(true);

    await expectOk(stack.undo());
    expect(loadWatch("main")).toBeUndefined();

    saveWatch("main", true);
    stack.clear();
    saveWatch("main", true); // the menu picked what was already chosen
    expect(stack.canUndo()).toBe(false);
  });

  it("records nothing once the wiring is taken back down", () => {
    const { stack } = realWorld();
    setWatchUndo(null);
    saveWatch("main", true);
    expect(stack.canUndo()).toBe(false);
  });

  /**
   * MARK-SEEN IS NOT AN ACTION, so it is not on the stack.
   *
   * store/visits.ts stamps a visit when a session is LOOKED at, from the same
   * poll fold that prunes dead sessions, and nothing in this tree marks one
   * unread. An entry for it would mean Cmd+Z undoing "I read this", which eats
   * the press that belongs to the kill or the retitle underneath. The other
   * name in the original list, a pin, has no feature behind it at all.
   */
  it("puts nothing on the stack when a session is seen", () => {
    const { stack } = realWorld();
    const visits = createVisitStore({ now: () => 1_000, visible: () => true });
    visits.observe([{ name: "main", state: "done", id: "$1" }], "main");
    visits.stamp("main");
    expect(stack.canUndo()).toBe(false);
  });
});
