import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import {
  callerGroupName,
  callerGroupTitle,
  deriveSidebar,
  groupToken,
  isCallerSession,
  isGroupVisible,
  isSystemSession,
  notifySnapshotOf,
  SYSTEM_GROUP_NAME,
  visibleGroupSeqTokens,
} from "../src/components/lobby.logic";
import { captureVisibleOrder } from "../src/logic/order.logic";
import { createCollapseStore, SYSTEM_KEY } from "../src/store/collapse";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ORIGIN_USER, type LobbyApi } from "../src/lib/lobby-api";
import {
  emptyLayout,
  type Layout,
  type Session,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

/**
 * A group per Caller (CONTEXT.md: Origin, Caller).
 *
 * A session a Caller made through agent-api carries the Caller's name as its
 * origin, and tmux-api sends that name back as `caller`. Such a session used to
 * fall into System with the harness fleets; it now collects in a group named
 * after the Caller, collapsed by default and pinned just above System.
 */

const ME = "wizard";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: ME,
  origin: ORIGIN_USER,
  ...over,
});

/** A session Muse opened: agent-api stamps the credential's name. */
const muse = (name: string, over: Partial<Session> = {}): Session =>
  sess(name, { origin: "muse", caller: "muse", ...over });

const stray = (name: string): Session => {
  const s = sess(name);
  delete s.origin;
  return s;
};

const layout = (over: Partial<Layout> = {}): Layout => ({ ...emptyLayout(), ...over });
const names = (ss: Session[]) => ss.map((s) => s.name);
const groupNamed = (l: Layout, sessions: Session[], name: string) =>
  deriveSidebar(l, sessions, ME).groups.find((g) => g.name === name);

describe("isCallerSession / isSystemSession", () => {
  it("reads the Caller from the server's caller field", () => {
    expect(isCallerSession(muse("session-ready"))).toBe(true);
    expect(isSystemSession(muse("session-ready"))).toBe(false);
  });

  it("leaves harness and unstamped sessions in System", () => {
    expect(isCallerSession(sess("qa-slug", { origin: "test" }))).toBe(false);
    expect(isSystemSession(sess("qa-slug", { origin: "test" }))).toBe(true);
    expect(isCallerSession(stray("shell-2"))).toBe(false);
    expect(isSystemSession(stray("shell-2"))).toBe(true);
  });

  it("does not repeat the server's rule for which origins are Callers", () => {
    // A server that predates the field sends the origin alone. The session
    // stays in System, where it always was, rather than the client guessing
    // from the raw word; tmux-api is the one place that decides.
    expect(isCallerSession(sess("session-ready", { origin: "muse" }))).toBe(false);
    expect(isSystemSession(sess("session-ready", { origin: "muse" }))).toBe(true);
  });
});

describe("notifySnapshotOf", () => {
  // The page notifier's input: a Caller's and System's sessions are marked
  // quiet, as the push sender keeps them (tmux-api isUserSession).
  it("marks a Caller's and System's sessions quiet, and a person's not", () => {
    expect(notifySnapshotOf(muse("sleep-command-test", { state: "done" })).quiet).toBe(true);
    expect(notifySnapshotOf(sess("qa-slug", { origin: "test" })).quiet).toBe(true);
    expect(notifySnapshotOf(stray("shell-2")).quiet).toBe(true);
    expect(notifySnapshotOf(sess("deploy", { state: "done", title: "Deploy" }))).toMatchObject({
      name: "deploy",
      title: "Deploy",
      state: "done",
      quiet: false,
    });
  });
});

describe("callerGroupTitle", () => {
  it("capitalises the Caller's name", () => {
    expect(callerGroupTitle("muse")).toBe("Muse");
    expect(callerGroupTitle("ci_bot")).toBe("Ci_bot");
    expect(callerGroupTitle("Muse")).toBe("Muse");
  });
});

describe("deriveSidebar / Caller groups", () => {
  it("files a Caller's session in a group named after it, not in System", () => {
    const m = deriveSidebar(layout(), [sess("mine"), muse("session-ready"), stray("shell-2")], ME);
    const g = m.groups.find((x) => x.kind === "caller")!;
    expect(g.name).toBe(callerGroupName("muse"));
    expect(g.caller).toBe("muse");
    expect(names(g.sessions)).toEqual(["session-ready"]);
    expect(names(m.groups.find((x) => x.kind === "system")!.sessions)).toEqual(["shell-2"]);
    expect(names(m.groups.find((x) => x.kind === "ungrouped")!.sessions)).toEqual(["mine"]);
  });

  it("gives every Caller its own group, in name order, just above System", () => {
    const l = layout({ projects: [{ name: "work", sessions: [] }], ungroupedIndex: 1 });
    const m = deriveSidebar(
      l,
      [muse("m1"), sess("ci1", { origin: "ci", caller: "ci" }), stray("shell-2")],
      ME,
    );
    expect(m.groups.map(groupToken)).toEqual(["p:work", "u", "c:ci", "c:muse", "s"]);
  });

  it("creates no group for a Caller with nothing live, so an empty one never shows", () => {
    const m = deriveSidebar(layout(), [sess("mine")], ME);
    expect(m.groups.some((g) => g.kind === "caller")).toBe(false);
    const g = groupNamed(layout(), [muse("m1")], callerGroupName("muse"))!;
    expect(isGroupVisible(g)).toBe(true);
  });

  it("takes a Caller's session out of a project or Ungrouped the layout lists it in", () => {
    const l = layout({
      projects: [{ name: "work", sessions: ["m1"] }],
      ungrouped: ["m2"],
      ungroupedIndex: 1,
    });
    const m = deriveSidebar(l, [muse("m1"), muse("m2", { created: 2000 })], ME);
    expect(m.groups.find((g) => g.name === "work")!.sessions).toEqual([]);
    expect(m.groups.find((g) => g.kind === "ungrouped")!.sessions).toEqual([]);
    expect(
      names(
        groupNamed(l, [muse("m1"), muse("m2", { created: 2000 })], callerGroupName("muse"))!
          .sessions,
      ),
    ).toEqual(["m1", "m2"]);
  });

  it("does not let a Caller session's own project claim it", () => {
    const l = layout({ projects: [{ name: "work", sessions: [] }], ungroupedIndex: 1 });
    const m = deriveSidebar(l, [muse("m1", { project: "work" })], ME);
    expect(m.groups.find((g) => g.name === "work")!.sessions).toEqual([]);
  });

  it("orders a Caller's group by creation time then name", () => {
    const g = groupNamed(
      layout(),
      [muse("b", { created: 300 }), muse("a", { created: 100 }), muse("c", { created: 100 })],
      callerGroupName("muse"),
    )!;
    expect(names(g.sessions)).toEqual(["a", "c", "b"]);
  });

  it("keeps a foreign Caller session in Shared with me", () => {
    const m = deriveSidebar(layout(), [muse("theirs", { owner: "emo" })], ME);
    expect(m.groups.some((g) => g.kind === "caller")).toBe(false);
    expect(names(m.foreign)).toEqual(["theirs"]);
  });

  it("is not a slot the reorder controls can step onto", () => {
    const l = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 1 });
    const model = deriveSidebar(l, [sess("mine"), muse("m1")], ME);
    expect(visibleGroupSeqTokens(model)).toEqual(["p:a", "u"]);
  });

  it("carries a name no project can take, and not System's", () => {
    expect(callerGroupName("muse")).toBe(":caller:muse");
    expect(callerGroupName("muse")).not.toBe(SYSTEM_GROUP_NAME);
  });
});

describe("captureVisibleOrder", () => {
  it("writes nothing for a Caller's group and keeps its members' layout entries", () => {
    // Like System, the layout has no field for it, and a member still listed
    // in layout.ungrouped is not a stale duplicate to delete.
    const l = layout({ ungrouped: ["mine", "m1"] });
    const model = deriveSidebar(l, [sess("mine"), muse("m1")], ME);
    const out = captureVisibleOrder(l, model);
    expect(out.ungrouped).toEqual(["mine", "m1"]);
    expect(out.projects).toEqual([]);
  });
});

describe("collapse defaults", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("starts every Caller's group collapsed, like System", () => {
    const c = createCollapseStore(() => ME);
    expect(c.isCollapsed(callerGroupName("muse"))).toBe(true);
    expect(c.isCollapsed(callerGroupName("ci"))).toBe(true);
    expect(c.isCollapsed(SYSTEM_KEY)).toBe(true);
    c.toggle(callerGroupName("muse"));
    expect(c.isCollapsed(callerGroupName("muse"))).toBe(false);
    expect(createCollapseStore(() => ME).isCollapsed(callerGroupName("muse"))).toBe(false);
    expect(c.isCollapsed(callerGroupName("ci"))).toBe(true);
  });
});

// --- dragging out of a Caller's group behaves like dragging out of System ---

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: ME };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  origins: [string, string][] = [];

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
    this.puts.push(l);
    this.layoutVal = l;
  }
  async killSession() {}
  async setSessionTitle() {}
  async setSessionOrigin(name: string, origin: string) {
    this.origins.push([name, origin]);
    // What tmux-api sends on the next poll: the new origin, and no caller,
    // since callerOf reads the restamped origin.
    this.sessionsVal = this.sessionsVal.map((s) => {
      if (s.name !== name) return s;
      const { caller: _gone, ...rest } = s;
      return { ...rest, origin };
    });
  }
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot(): Promise<SnapshotRow[]> {
    return [];
  }
  async prewarm() {}
  async releasePrewarm() {}
}

async function withStore(api: LobbyApi, fn: (store: LobbyStore) => Promise<void>): Promise<void> {
  let dispose: () => void = () => {};
  let store: LobbyStore | undefined;
  const done = new Promise<void>((resolve, reject) => {
    createRoot((d) => {
      dispose = d;
      store = createLobbyStore({ api, autoStart: false, syncHash: false });
      fn(store).then(resolve, reject);
    });
  });
  try {
    await done;
  } finally {
    store?.dispose();
    dispose();
  }
}

const groupOf = (store: LobbyStore, name: string): string | undefined =>
  store.model().groups.find((g) => g.sessions.some((s) => s.name === name))?.name;

describe("dragging a card out of a Caller's group", () => {
  it("stamps the session `user` and keeps it where it was dropped", async () => {
    const api = new FakeApi();
    api.sessionsVal = [muse("session-ready")];
    api.layoutVal = layout({ projects: [{ name: "work", sessions: [] }], ungroupedIndex: 1 });
    await withStore(api, async (store) => {
      await store.refresh();
      expect(groupOf(store, "session-ready")).toBe(callerGroupName("muse"));

      await store.move("session-ready", "work");

      expect(api.origins).toEqual([["session-ready", "user"]]);
      expect(api.puts.at(-1)!.projects[0]!.sessions).toEqual(["session-ready"]);
      // On screen at once, not at the next poll.
      expect(groupOf(store, "session-ready")).toBe("work");
    });
  });

  it("refuses a drop INTO a Caller's group, which the layout cannot hold", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine"), muse("m1")];
    api.layoutVal = layout({ projects: [{ name: "work", sessions: ["mine"] }], ungroupedIndex: 1 });
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("mine", callerGroupName("muse"));
      expect(api.puts).toHaveLength(0);
      expect(api.origins).toEqual([]);
      expect(groupOf(store, "mine")).toBe("work");
    });
  });
});
