import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { renameSessionInLayout } from "../src/components/lobby.logic";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  kills: string[] = [];
  renames: [string, string][] = [];
  restores = 0;
  renameError?: number;
  killError = false;
  layoutError = false;
  putError = false;

  async whoami() {
    return this.whoamiVal;
  }
  async listSessions() {
    return this.sessionsVal;
  }
  async getLayout() {
    if (this.layoutError) throw new ApiError(500, "boom");
    return this.layoutVal;
  }
  async putLayout(l: Layout) {
    if (this.putError) throw new ApiError(500, "nope");
    this.puts.push(l);
    this.layoutVal = l;
  }
  async killSession(n: string) {
    if (this.killError) throw new ApiError(500, "x");
    this.kills.push(n);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== n);
  }
  async renameSession(o: string, n: string) {
    if (this.renameError) throw new ApiError(this.renameError, "x");
    this.renames.push([o, n]);
    // mirror the backend: rename the tmux session AND the server layout.
    this.sessionsVal = this.sessionsVal.map((s) => (s.name === o ? { ...s, name: n } : s));
    this.layoutVal = renameSessionInLayout(this.layoutVal, o, n);
  }
  async restoreSessions() {
    this.restores++;
  }
  async listDirs() {
    return [];
  }
}

/**
 * The same fake, but handing out FRESH objects on every call the way `fetch` +
 * `JSON.parse` does. Returning the stored reference would make an unchanged
 * poll look stable for free and hide the rebuild this file asserts against.
 */
class FreshApi extends FakeApi {
  override async listSessions() {
    return structuredClone(await super.listSessions());
  }
  override async getLayout() {
    return structuredClone(await super.getLayout());
  }
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

const names = (store: LobbyStore) =>
  store.model().groups.flatMap((g) => g.sessions.map((s) => s.name));

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lobby store", () => {
  it("loads whoami + sessions + layout and derives groups", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), sess("b")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["a"] }], ungrouped: ["b"] };
    await withStore(api, async (store) => {
      await store.refresh();
      expect(store.me()).toBe("wizard");
      const work = store.model().groups.find((g) => g.name === "work");
      expect(work!.sessions.map((s) => s.name)).toEqual(["a"]);
      expect(names(store)).toContain("b");
    });
  });

  it("create: validates, optimistically adds + selects, and PUTs the layout", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.create("newsess", "");
      expect(ok).toBe(true);
      expect(api.puts).toHaveLength(1);
      expect(api.puts[0]!.ungrouped).toContain("newsess");
      expect(names(store)).toContain("newsess"); // optimistic pending card
      expect(store.selected()?.name).toBe("newsess");
    });
  });

  it("create: rejects an invalid name and a live duplicate without a PUT", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("dup")];
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.create("bad name!", "")).toBe(false);
      expect(await store.create("dup", "")).toBe(false);
      expect(api.puts).toHaveLength(0);
      expect(store.toast()).toBeTruthy();
    });
  });

  it("rename: calls the API and mirrors the layout optimistically", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["a"] };
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.rename("a", "b");
      expect(ok).toBe(true);
      expect(api.renames).toEqual([["a", "b"]]);
      expect(store.layout().ungrouped).toContain("b");
      expect(names(store)).toContain("b");
      expect(names(store)).not.toContain("a");
    });
  });

  it("rename: surfaces a 409 (name taken) and does not change local state", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.renameError = 409;
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.rename("a", "taken");
      expect(ok).toBe(false);
      expect(store.toast()).toMatch(/taken/i);
    });
  });

  it("kill: calls the API and removes the session from the model", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), sess("b")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["a", "b"] };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.kill("a");
      expect(api.kills).toContain("a");
      expect(names(store)).not.toContain("a");
      expect(names(store)).toContain("b");
    });
  });

  it("move: PUTs a layout with the session in the target project", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }], ungrouped: ["a"] };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("a", "work");
      expect(api.puts).toHaveLength(1);
      expect(api.puts[0]!.projects[0]!.sessions).toContain("a");
      expect(api.puts[0]!.ungrouped).not.toContain("a");
    });
  });

  it("move: an anchored drop resolves the anchor against the RAW layout", async () => {
    // raw ['d1','d2','a','b'] renders as ['a','b'] — a rendered index would
    // splice between the dead refs and leave the render untouched.
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), sess("b")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["d1", "d2", "a", "b"] }],
    };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("a", "work", { name: "b", side: "below" });
      expect(api.puts.at(-1)!.projects[0]!.sessions).toEqual(["d1", "d2", "b", "a"]);
      const work = store.model().groups.find((g) => g.name === "work")!;
      expect(work.sessions.map((s) => s.name)).toEqual(["b", "a"]);
    });
  });

  it("move: an anchored drop in Ungrouped materializes the leftovers it needs", async () => {
    const api = new FakeApi();
    api.sessionsVal = [
      sess("alpha", { created: 1 }),
      sess("beta", { created: 2 }),
      sess("gamma", { created: 3 }),
    ];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha"] };
    await withStore(api, async (store) => {
      await store.refresh();
      // beta and gamma are leftovers: live, referenced by no group.
      expect(names(store)).toEqual(["alpha", "beta", "gamma"]);
      await store.move("beta", "", { name: "gamma", side: "below" });
      expect(api.puts.at(-1)!.ungrouped).toEqual(["alpha", "gamma", "beta"]);
      expect(names(store)).toEqual(["alpha", "gamma", "beta"]);
    });
  });

  it("move: an anchored drop inside a PROJECT materializes the members it needs", async () => {
    // Sessions the layout never placed but whose own record names the project
    // render there with no raw entry behind them — the same position-with-no-
    // index Ungrouped's leftovers have. Without materializing first, the anchor
    // resolves against an empty list and the drop silently appends.
    const api = new FakeApi();
    api.sessionsVal = [
      sess("alpha", { created: 1, project: "work" }),
      sess("beta", { created: 2, project: "work" }),
      sess("gamma", { created: 3, project: "work" }),
    ];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }] };
    await withStore(api, async (store) => {
      await store.refresh();
      expect(names(store)).toEqual(["alpha", "beta", "gamma"]);
      await store.move("alpha", "work", { name: "beta", side: "below" });
      expect(api.puts.at(-1)!.projects[0]!.sessions).toEqual(["beta", "alpha", "gamma"]);
      expect(names(store)).toEqual(["beta", "alpha", "gamma"]);
    });
  });

  it("move: an un-anchored move into Ungrouped lands after the leftovers, not before", async () => {
    const api = new FakeApi();
    api.sessionsVal = [
      sess("alpha", { created: 1 }),
      sess("beta", { created: 2 }),
      sess("inproj", { created: 3 }),
    ];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["inproj"] }],
      ungrouped: ["alpha"],
    };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("inproj", ""); // the ⋯ "Move to → Ungrouped" path
      expect(api.puts.at(-1)!.ungrouped).toEqual(["alpha", "beta", "inproj"]);
      const ungrouped = store.model().groups.find((g) => g.kind === "ungrouped")!;
      expect(ungrouped.sessions.map((s) => s.name)).toEqual(["alpha", "beta", "inproj"]);
    });
  });

  it("create: a name left in the layout by a session that died outside the API is free again", async () => {
    // The session is gone from tmux but its layout entry survives (removeSession
    // runs only on an explicit UI kill), so the name must not stay burnt.
    const api = new FakeApi();
    api.sessionsVal = [];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "old", sessions: ["orphan"] }] };
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.create("orphan", "")).toBe(true);
      expect(store.toast()).toBeNull();
      const put = api.puts.at(-1)!;
      expect(put.ungrouped).toEqual(["orphan"]);
      expect(put.projects[0]!.sessions).toEqual([]); // the stale ref is gone
    });
  });

  it("kill: PUTs the layout so the entry cannot come back on the next poll", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), sess("b")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["a", "b"] };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.kill("a");
      // The server doc — not just the local signal — must lose the entry, or
      // the next poll (past the 4s grace) pulls it straight back.
      expect(api.layoutVal.ungrouped).toEqual(["b"]);
      expect(api.puts.at(-1)!.ungrouped).toEqual(["b"]);
    });
  });

  it("createProject / deleteProject go through the layout PUT", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.createProject("proj")).toBe(true);
      expect(api.puts.at(-1)!.projects.some((p) => p.name === "proj")).toBe(true);
      await store.deleteProjectAction("proj");
      expect(api.puts.at(-1)!.projects.some((p) => p.name === "proj")).toBe(false);
    });
  });

  it("degrades gracefully when the layout fetch fails (sessions still render)", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.layoutError = true;
    await withStore(api, async (store) => {
      await store.refresh();
      expect(names(store)).toContain("a"); // unreferenced live own session → Ungrouped
    });
  });

  it("collapse state persists per-browser under tmux-collapsed-<user>", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      store.collapse.toggle("work");
      expect(store.collapse.isCollapsed("work")).toBe(true);
      expect(localStorage.getItem("tmux-collapsed-wizard")).toContain("work");
    });
  });

  it("foreign sessions land in the Shared-with-me list, not the groups", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine"), sess("theirs", { owner: "bob", access: "ro" })];
    await withStore(api, async (store) => {
      await store.refresh();
      expect(store.model().foreign.map((s) => s.name)).toEqual(["theirs"]);
      expect(names(store)).toContain("mine");
      expect(names(store)).not.toContain("theirs");
    });
  });

  it("restore calls the API", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      await store.restore();
      expect(api.restores).toBe(1);
    });
  });

  it("a poll that changes nothing leaves the render model reference-identical", async () => {
    // The 5s poll re-parses the same JSON into fresh objects. If those land in
    // the store as-is, every memo downstream recomputes and <For> (which keys
    // on reference) tears down and re-creates every group and card — taking
    // any open menu or half-typed input with it.
    const api = new FreshApi();
    api.sessionsVal = [sess("a", { state: "running" }), sess("b")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["a"] }],
      ungrouped: ["b"],
    };
    await withStore(api, async (store) => {
      await store.refresh();
      const model = store.model();
      const layoutRef = store.layout();
      const group = model.groups[0]!;
      const card = group.sessions[0]!;

      await store.refresh();
      await store.refresh();
      await store.refresh();

      expect(store.layout()).toBe(layoutRef);
      expect(store.model()).toBe(model);
      expect(store.model().groups[0]).toBe(group);
      expect(store.model().groups[0]!.sessions[0]).toBe(card);
    });
  });

  it("a poll that only REORDERS the manifest leaves the render model alone", async () => {
    // /sessions spans OS users and nothing promises a stable order, so the very
    // same sessions come back shuffled. The model is rebuilt from that array, so
    // a shuffle used to hand <For> a whole new set of RenderGroups and re-create
    // every group and card node — on a sidebar where nothing had changed.
    const api = new FreshApi();
    api.sessionsVal = [sess("a"), sess("b"), sess("c")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["a"] }],
      ungrouped: ["b", "c"],
    };
    await withStore(api, async (store) => {
      await store.refresh();
      const model = store.model();
      const work = model.groups.find((g) => g.name === "work")!;
      const card = work.sessions[0]!;

      for (let i = 0; i < 3; i++) {
        api.sessionsVal = [...api.sessionsVal].reverse();
        await store.refresh();
      }

      expect(store.model()).toBe(model);
      expect(store.model().groups.find((g) => g.name === "work")).toBe(work);
      expect(work.sessions[0]).toBe(card);
      expect(names(store)).toEqual(["b", "c", "a"]); // and the render is unmoved
    });
  });

  it("a foreign session appearing does not re-create this user's groups", async () => {
    // Somebody else's session showing up in the shared manifest is not a change
    // to any of this user's rows.
    const api = new FreshApi();
    api.sessionsVal = [sess("mine")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["mine"] };
    await withStore(api, async (store) => {
      await store.refresh();
      const ungrouped = store.model().groups[0]!;

      api.sessionsVal = [...api.sessionsVal, sess("theirs", { owner: "bob", access: "ro" })];
      await store.refresh();

      expect(store.model().groups[0]).toBe(ungrouped);
      expect(store.model().foreign.map((s) => s.name)).toEqual(["theirs"]);
    });
  });

  it("a poll that DOES change something still repaints", async () => {
    const api = new FreshApi();
    api.sessionsVal = [sess("a")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["a"] };
    await withStore(api, async (store) => {
      await store.refresh();
      api.sessionsVal = [sess("a"), sess("b")];
      api.layoutVal = { ...api.layoutVal, ungrouped: ["a", "b"] };
      await store.refresh();
      expect(names(store)).toEqual(["a", "b"]);

      api.sessionsVal = [sess("b", { state: "running" })];
      api.layoutVal = { ...api.layoutVal, ungrouped: ["b"] };
      await store.refresh();
      expect(names(store)).toEqual(["b"]);
      expect(store.model().groups[0]!.sessions[0]!.state).toBe("running");
    });
  });

  it("survives two sessions sharing a name under different owners", async () => {
    // The manifest spans OS users and tmux names are only unique per user, so
    // the reconcile key is not unique — neither entry may be dropped.
    const api = new FreshApi();
    api.sessionsVal = [sess("main"), sess("main", { owner: "emo", access: "ro" })];
    await withStore(api, async (store) => {
      await store.refresh();
      await store.refresh();
      expect(names(store)).toEqual(["main"]);
      expect(store.model().foreign.map((s) => s.name)).toEqual(["main"]);
      expect(store.model().foreign[0]!.owner).toBe("emo");
    });
  });

  it("the working timer's anchor survives a reload", async () => {
    // The anchor is our own first observation (no backend exposes a real
    // state-change time), so it has to be persisted or every page load
    // restarts a long-running session's timer at 0:00.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
    const api = new FakeApi();
    api.sessionsVal = [sess("busy", { state: "running" })];
    let first: number | undefined;
    await withStore(api, async (store) => {
      await store.refresh();
      first = store.workingSince("busy");
      expect(first).toBe(Date.now());
    });

    vi.setSystemTime(new Date("2026-08-06T10:00:30Z"));
    await withStore(api, async (store) => {
      await store.refresh();
      expect(store.workingSince("busy")).toBe(first);
    });
  });

  it("the working-timer anchor re-arms when the session stops running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
    const api = new FakeApi();
    api.sessionsVal = [sess("busy", { state: "running" })];
    await withStore(api, async (store) => {
      await store.refresh();
      api.sessionsVal = [sess("busy", { state: "done" })];
      await store.refresh();
      expect(store.workingSince("busy")).toBeUndefined();

      vi.setSystemTime(new Date("2026-08-06T10:01:00Z"));
      api.sessionsVal = [sess("busy", { state: "running" })];
      await store.refresh();
      expect(store.workingSince("busy")).toBe(Date.now());
    });
  });

  it("a project rename carries its collapsed state; a delete drops the key", async () => {
    // Collapse is keyed on the project NAME, so a rename that leaves the key
    // behind pops the group open and hands the stale key to the next project
    // that reuses the name.
    const api = new FakeApi();
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "old", sessions: [] }] };
    await withStore(api, async (store) => {
      await store.refresh();
      store.collapse.toggle("old");
      expect(store.collapse.isCollapsed("old")).toBe(true);

      expect(await store.renameProjectAction("old", "fresh")).toBe(true);
      expect(store.collapse.isCollapsed("fresh")).toBe(true);
      expect(store.collapse.isCollapsed("old")).toBe(false);
      expect(localStorage.getItem("tmux-collapsed-wizard")).toBe('["fresh"]');

      await store.deleteProjectAction("fresh");
      expect(store.collapse.isCollapsed("fresh")).toBe(false);
      expect(localStorage.getItem("tmux-collapsed-wizard")).toBe("[]");
    });
  });

  it("a rename whose layout write fails leaves the collapse key where it was", async () => {
    const api = new FakeApi();
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "old", sessions: [] }] };
    api.putError = true;
    await withStore(api, async (store) => {
      await store.refresh();
      store.collapse.toggle("old");
      expect(await store.renameProjectAction("old", "fresh")).toBe(false);
      expect(store.collapse.isCollapsed("old")).toBe(true);
      expect(store.collapse.isCollapsed("fresh")).toBe(false);
    });
  });

  /**
   * The layout is a whole-document PUT with no concurrency control, so the last
   * writer wins outright: two tabs open, tab B polls the pre-move document and
   * writes it back, and tab A's move is gone. That is the backend's contract and
   * this lane does not change it — but losing the move in SILENCE is what made
   * it look like the drag never worked. The write we PUT is remembered until the
   * next poll we accept: a server document that no longer matches it means
   * somebody else wrote in between, and the user gets told.
   */
  describe("layout conflicts between tabs", () => {
    /** Past the 4s grace, where a poll is allowed to overwrite local layout. */
    const pastGrace = () => vi.setSystemTime(Date.now() + 5000);

    it("says so when another tab's write reverted this tab's move", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
      const api = new FreshApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = {
        ...emptyLayout(),
        projects: [{ name: "work", sessions: [] }],
        ungrouped: ["a"],
      };
      await withStore(api, async (store) => {
        await store.refresh();
        await store.move("a", "work");
        expect(api.puts).toHaveLength(1);

        // tab B, which never saw the move, PUTs the document it still remembers
        api.layoutVal = {
          ...emptyLayout(),
          projects: [{ name: "work", sessions: [] }],
          ungrouped: ["a"],
        };
        pastGrace();
        await store.refresh();

        expect(store.toast()).toMatch(/elsewhere/i);
        expect(names(store)).toEqual(["a"]); // the server document still wins
      });
    });

    it("stays quiet when the poll reads back the layout this tab wrote", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
      const api = new FreshApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = {
        ...emptyLayout(),
        projects: [{ name: "work", sessions: [] }],
        ungrouped: ["a"],
      };
      await withStore(api, async (store) => {
        await store.refresh();
        await store.move("a", "work");
        pastGrace();
        await store.refresh();
        await store.refresh();
        expect(store.toast()).toBeNull();
      });
    });

    it("does not blame a conflict for a poll with no local write behind it", async () => {
      // Another tab moving a session while THIS one is only reading is not a
      // conflict — there is nothing of ours to lose.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
      const api = new FreshApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = { ...emptyLayout(), ungrouped: ["a"] };
      await withStore(api, async (store) => {
        await store.refresh();
        api.layoutVal = {
          ...emptyLayout(),
          projects: [{ name: "elsewhere", sessions: ["a"] }],
        };
        pastGrace();
        await store.refresh();
        expect(store.toast()).toBeNull();
        expect(store.layout().projects.map((p) => p.name)).toEqual(["elsewhere"]);
      });
    });

    it("reports the conflict once, not on every poll that follows", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
      const api = new FreshApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = {
        ...emptyLayout(),
        projects: [{ name: "work", sessions: [] }],
        ungrouped: ["a"],
      };
      const seen: string[] = [];
      let dispose: () => void = () => {};
      await new Promise<void>((resolve, reject) => {
        createRoot((d) => {
          dispose = d;
          const store = createLobbyStore({
            api,
            autoStart: false,
            syncHash: false,
            notify: (m) => seen.push(m),
          });
          void (async () => {
            await store.refresh();
            await store.move("a", "work");
            api.layoutVal = {
              ...emptyLayout(),
              projects: [{ name: "work", sessions: [] }],
              ungrouped: ["a"],
            };
            pastGrace();
            await store.refresh();
            await store.refresh();
            await store.refresh();
            store.dispose();
          })().then(resolve, reject);
        });
      });
      dispose();
      expect(seen.filter((m) => /elsewhere/i.test(m))).toHaveLength(1);
    });
  });

  it("create: a layout write that fails reports failure and leaves no phantom card", async () => {
    // The layout PUT is the only record a create makes (tmux-api never sees
    // it), so a failed write means nothing was created. Reporting success
    // clears the input and strands an optimistic card that never resolves —
    // and, because pending names count as taken, burns the name too.
    const api = new FakeApi();
    api.putError = true;
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.create("ghost", "")).toBe(false);
      expect(names(store)).not.toContain("ghost");
      expect(store.toast()).toMatch(/layout/i);

      // the name is not burnt: it is free again the moment the write can land
      api.putError = false;
      expect(await store.create("ghost", "")).toBe(true);
      expect(names(store)).toContain("ghost");
    });
  });
});
