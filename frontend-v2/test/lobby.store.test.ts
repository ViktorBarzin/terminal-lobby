import { describe, it, expect, beforeEach } from "vitest";
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
});
