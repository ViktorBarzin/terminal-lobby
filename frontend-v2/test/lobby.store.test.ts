import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore, type LobbyStoreOptions } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import {
  emptyLayout,
  NAME_RE,
  NEW_SESSION_LABEL,
  sessionLabel,
  type Layout,
  type Session,
  type Whoami,
} from "../src/types/lobby";
import { promptLineFor } from "../src/store/prompt-line";
import { isSessionId } from "../src/lib/session-id";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  kills: string[] = [];
  restores = 0;
  restoreSelections: { snapshot: string; sessions: string[] }[] = [];
  snapshotsVal: import("../src/types/lobby").Snapshot[] = [];
  snapshotRows: Record<string, import("../src/types/lobby").SnapshotRow[]> = {};
  killError = false;
  layoutError = false;
  putError = false;
  /** thrown by listSessions — a timed-out or refused poll. */
  sessionsError?: unknown;
  /** how many times the poll asked for the session list. */
  sessionCalls = 0;

  async whoami() {
    return this.whoamiVal;
  }
  async listSessions() {
    this.sessionCalls++;
    if (this.sessionsError) throw this.sessionsError;
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
  titles: [string, string][] = [];
  titleError = 0;
  async setSessionTitle(name: string, title: string) {
    if (this.titleError) throw new ApiError(this.titleError, "x");
    this.titles.push([name, title]);
    this.sessionsVal = this.sessionsVal.map((s) =>
      s.name === name ? { ...s, ...(title ? { title } : { title: undefined }) } : s,
    );
  }
  async restoreSessions(sel?: { snapshot: string; sessions: string[] }) {
    this.restores++;
    if (sel) this.restoreSelections.push(sel);
  }
  async listSnapshots() {
    return { snapshots: this.snapshotsVal, memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot(ts: string) {
    return this.snapshotRows[ts] ?? [];
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

/**
 * The same fake with listSessions held open until the test answers it, so two
 * polls can be put in flight and answered in the WRONG order — which is what a
 * slow network does to the 5s poll every time a request overruns the interval.
 * getLayout still answers at once, snapshotting the document as it stood when
 * the poll started (FreshApi's clone), so each poll carries a coherent world.
 */
class GatedApi extends FreshApi {
  gate = false;
  readonly pending: Array<{
    resolve: (s: Session[]) => void;
    reject: (e: unknown) => void;
  }> = [];

  override listSessions(): Promise<Session[]> {
    if (!this.gate) return super.listSessions();
    this.sessionCalls++;
    return new Promise<Session[]>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

async function withStore(
  api: LobbyApi,
  fn: (store: LobbyStore) => Promise<void>,
  opts: Partial<LobbyStoreOptions> = {},
): Promise<void> {
  let dispose: () => void = () => {};
  let store: LobbyStore | undefined;
  const done = new Promise<void>((resolve, reject) => {
    createRoot((d) => {
      dispose = d;
      store = createLobbyStore({ api, autoStart: false, syncHash: false, ...opts });
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

  it("create: mints an id for the name, optimistically adds + selects, and PUTs the layout", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("newsess", "");
      expect(isSessionId(id)).toBe(true);
      expect(api.puts).toHaveLength(1);
      expect(api.puts[0]!.ungrouped).toEqual([id]);
      expect(names(store)).toEqual([id]); // optimistic pending card
      expect(store.selected()?.name).toBe(id);
    });
  });

  it("create: a NAME is stamped as the title, because nothing will summarise a shell", async () => {
    // Choosing `shell` in the composer turns the box back into a name box: a
    // shell has no conversation, so no summary is ever coming and the typed
    // text is the only title the session will get.
    vi.useFakeTimers();
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("scratch \u{1F680}", "", "name");
      expect(isSessionId(id)).toBe(true);
      const card = store.model().groups.flatMap((g) => g.sessions).find((c) => c.name === id);
      expect(card?.title).toBe("scratch \u{1F680}");
      // stampTitleWhenAlive's first rung, the same ladder the refresh burst uses
      await vi.advanceTimersByTimeAsync(700);
      expect(api.titles).toEqual([[id, "scratch \u{1F680}"]]);
    });
  });

  it("create: a PROMPT is never stamped, or the summary could never land", async () => {
    // The auto-title rule only fires while @title is unset (tmux-api/autotitle.go),
    // so stamping the prompt's first line would freeze the placeholder in place
    // and Claude's own summary would never reach the card.
    vi.useFakeTimers();
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("Fix the deploy\nit 500s on push", "");
      const card = store.model().groups.flatMap((g) => g.sessions).find((c) => c.name === id);
      // The card reads as the prompt's FIRST LINE while it waits.
      expect(card?.title).toBe("Fix the deploy");
      await vi.advanceTimersByTimeAsync(7000);
      expect(api.titles).toEqual([]);
    });
  });

  it("create: the prompt's first line survives the poll, and the summary replaces it", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("Fix the deploy", "");
      // The server now knows the session, so the optimistic card is gone; the
      // line has to come from somewhere that outlives it.
      api.sessionsVal = [sess(id)];
      api.layoutVal = { ...emptyLayout(), ungrouped: [id] };
      await store.refresh();
      expect(store.sessions.find((s) => s.name === id)?.title).toBe("Fix the deploy");

      // tmux-api stamps Claude's summary, and it wins from here on.
      api.sessionsVal = [sess(id, { title: "Deploy pipeline 500s" })];
      await store.refresh();
      expect(store.sessions.find((s) => s.name === id)?.title).toBe("Deploy pipeline 500s");
      // ...and the placeholder is dropped rather than lingering in storage.
      expect(promptLineFor(id)).toBeNull();
    });
  });

  it("create: two sessions can carry the same title, because the name is not derived from it", async () => {
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(isSessionId(await store.create("dup", ""))).toBe(true);
      expect(isSessionId(await store.create("dup", ""))).toBe(true);
      const [a, b] = api.puts.at(-1)!.ungrouped;
      expect(a).not.toBe(b);
      expect(store.toast()).toBeNull();
    });
  });

  it("the URL hash carries the id, and an owner beside it for a foreign session", async () => {
    // The hash is how a session is reopened, shared and reported. It used to
    // carry a readable name; it carries the id now, which is the string ADR-0019
    // says people will be quoting when something goes wrong.
    const api = new FakeApi();
    api.sessionsVal = [sess("theirs", { owner: "emo", access: "ro" })];
    await withStore(
      api,
      async (store) => {
        await store.refresh();
        const id = await store.create("mine", "");
        expect(isSessionId(id)).toBe(true);
        expect(window.location.hash).toBe("#" + id);
        // Every consumer of the hash gates on NAME_RE before it selects.
        expect(NAME_RE.test(window.location.hash.slice(1))).toBe(true);

        store.select("theirs", "emo");
        expect(window.location.hash).toBe("#theirs@emo");
        // The `@` split has to survive the id: an id contains no `@`, so the
        // owner half stays unambiguous however short or long the id is.
        const [name, owner] = window.location.hash.slice(1).split("@");
        expect(name).toBe("theirs");
        expect(owner).toBe("emo");
      },
      { syncHash: true },
    );
  });

  it("create: an empty box creates a session, and it reads New session", async () => {
    // Naming left the critical path entirely: pressing Enter on an empty
    // composer is a real instruction, and the session it makes is titled by
    // whatever Claude summarises it as.
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("   ", "");
      expect(isSessionId(id)).toBe(true);
      expect(api.puts).toHaveLength(1);
      expect(store.toast()).toBeNull();
      const card = store.model().groups.flatMap((g) => g.sessions).find((c) => c.name === id);
      expect(sessionLabel(card!)).toBe(NEW_SESSION_LABEL);
    });
  });

  it("create: never mints a name a live session already holds", async () => {
    // 60 bits makes this unreachable in the field; forcing it is the only way
    // to know the retry is wired, and attaching a create to somebody else's
    // conversation is what it costs when it is not.
    const api = new FakeApi();
    const clash = "abcdefghjkmn";
    api.sessionsVal = [sess(clash)];
    let mint = 0;
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
        // The low five bits pick the symbol, so 10..21 spells `clash` on the
        // first mint and the next mint slides one symbol along.
        const b = buf as unknown as Uint8Array;
        for (let i = 0; i < b.length; i++) b[i] = 10 + i + mint;
        mint++;
        return buf;
      });
    try {
      await withStore(api, async (store) => {
        await store.refresh();
        const id = await store.create("second", "");
        expect(id).not.toBe(clash);
        expect(isSessionId(id)).toBe(true);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("rename: sets the title and leaves the name where it is", async () => {
    // The name is an id now (ADR-0019). A retitle is one POST /title and
    // nothing else moves: no rename, no layout mirror, no re-navigation of the
    // terminal iframe.
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["a"] };
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.rename("a", "Fix the parser");
      expect(ok).toBe(true);
      expect(api.titles).toEqual([["a", "Fix the parser"]]);
      expect(store.layout().ungrouped).toEqual(["a"]);
      expect(names(store)).toEqual(["a"]);
    });
  });

  it("rename: a title another session already carries is not a collision", async () => {
    // Two sessions may read the same, because nothing is derived from the
    // title any more. The old code refused this to protect a derived name.
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), { ...sess("b"), title: "Taken" }];
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.rename("a", "Taken");
      expect(ok).toBe(true);
      expect(store.toast()).toBeNull();
      expect(api.titles).toEqual([["a", "Taken"]]);
      expect(names(store)).toEqual(["a", "b"]);
    });
  });

  it("rename: normalizes the title before it goes out", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.rename("a", "  Fix\tthe\nparser  ")).toBe(true);
      expect(api.titles).toEqual([["a", "Fix the parser"]]);
    });
  });

  it("rename: an empty title clears the title, handing the session back", async () => {
    const api = new FakeApi();
    api.sessionsVal = [{ ...sess("a"), title: "Something" }];
    await withStore(api, async (store) => {
      await store.refresh();
      const ok = await store.rename("a", "   ");
      expect(ok).toBe(true);
      expect(api.titles).toEqual([["a", ""]]);
      expect(names(store)).toEqual(["a"]); // the name never moves
    });
  });

  it("rename: surfaces a 404 as the session being gone", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("a")];
    api.titleError = 404;
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.rename("a", "Too late")).toBe(false);
      expect(store.toast()).toMatch(/no longer exists/i);
    });
  });

  it("keeps the selection on a session the poll stopped returning", async () => {
    // Nothing renames, so a name vanishing from the poll means the session is
    // gone rather than moved. The store used to chase it by tmux session id;
    // there is nothing left to chase.
    const api = new FakeApi();
    api.sessionsVal = [{ ...sess("a"), id: "$3" }];
    await withStore(api, async (store) => {
      await store.refresh();
      store.select("a");
      expect(store.selected()?.name).toBe("a");

      api.sessionsVal = [{ ...sess("b"), id: "$3" }];
      await store.refresh();

      expect(store.selected()?.name).toBe("a");
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

  it("create: a layout entry left by a session that died outside the API cannot block a create", async () => {
    // The session is gone from tmux but its layout entry survives (removeSession
    // runs only on an explicit UI kill). Names used to be reusable and this was
    // about not burning one; ids are never reused, so what is left to protect is
    // that the orphan neither blocks the create nor lands in the new group.
    const api = new FakeApi();
    api.sessionsVal = [];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "old", sessions: ["orphan"] }] };
    await withStore(api, async (store) => {
      await store.refresh();
      expect(isSessionId(await store.create("orphan", ""))).toBe(true);
      expect(store.toast()).toBeNull();
      const put = api.puts.at(-1)!;
      expect(put.ungrouped).toHaveLength(1);
      expect(isSessionId(put.ungrouped[0]!)).toBe(true);
      expect(put.projects[0]!.sessions).toEqual(["orphan"]); // not ours to touch
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
    api.sessionsVal = [sess("main"), sess("main", { owner: "bob", access: "ro" })];
    await withStore(api, async (store) => {
      await store.refresh();
      await store.refresh();
      expect(names(store)).toEqual(["main"]);
      expect(store.model().foreign.map((s) => s.name)).toEqual(["main"]);
      expect(store.model().foreign[0]!.owner).toBe("bob");
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

  /* The phone layout navigates on activation: opening a session IS the move to
     the terminal screen. That makes "was a session activated?" a distinct
     question from "did the selection change?", and the two answers differ in
     both directions — hence a callback rather than an effect on selected(). */
  describe("onActivate — the phone layout's navigation signal", () => {
    it("fires when a session is selected", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("a"), sess("b")];
      const activated: string[] = [];
      await withStore(
        api,
        async (store) => {
          await store.refresh();
          store.select("a");
          expect(activated).toEqual(["a"]);
          store.select("b");
          expect(activated).toEqual(["a", "b"]);
        },
        { onActivate: (s) => activated.push(s.name) },
      );
    });

    it("fires again when the SAME session is re-selected", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("a")];
      const activated: string[] = [];
      await withStore(
        api,
        async (store) => {
          await store.refresh();
          store.select("a");
          // Tapping the session you already had open is how you get BACK to a
          // terminal you left to browse the list. The selection does not
          // change, so an effect on selected() would never fire and the tap
          // would do nothing at all.
          store.select("a");
          expect(activated).toEqual(["a", "a"]);
        },
        { onActivate: (s) => activated.push(s.name) },
      );
    });

    it("carries the owner of a shared session", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("shared", { owner: "bob" })];
      const seen: Array<{ name: string; owner?: string }> = [];
      await withStore(
        api,
        async (store) => {
          await store.refresh();
          store.select("shared", "bob");
          expect(seen).toEqual([{ name: "shared", owner: "bob" }]);
        },
        { onActivate: (s) => seen.push({ name: s.name, owner: s.owner }) },
      );
    });

    it("does NOT fire when a session is retitled", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("old")];
      const activated: string[] = [];
      await withStore(
        api,
        async (store) => {
          await store.refresh();
          store.select("old");
          activated.length = 0;
          await store.rename("old", "new");
          // The person is already looking at the session they just retitled.
          // Counting that as an activation would yank a phone off the list.
          expect(store.selected()?.name).toBe("old");
          expect(activated).toEqual([]);
        },
        { onActivate: (s) => activated.push(s.name) },
      );
    });

    it("is optional — the desktop passes nothing", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("a")];
      await withStore(api, async (store) => {
        await store.refresh();
        expect(() => store.select("a")).not.toThrow();
        expect(store.selected()?.name).toBe("a");
      });
    });
  });

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

    // A restore is the server placing sessions in their projects, so its layout
    // is ahead of ours the moment the call returns. Holding our copy through the
    // grace window would hide the placement until the next poll, and the
    // conflict check would blame another tab for a change this click asked for.
    it("takes the server's layout straight after a restore places sessions", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-06T10:00:00Z"));
      const api = new FreshApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = {
        ...emptyLayout(),
        projects: [{ name: "code", sessions: [] }],
        ungrouped: ["a"],
      };
      await withStore(api, async (store) => {
        await store.refresh();
        await store.move("a", "code"); // arms the grace window and the conflict check

        // tmux-api recreates `b` and puts it back where it belonged.
        api.sessionsVal = [sess("a"), sess("b")];
        api.layoutVal = {
          ...emptyLayout(),
          projects: [{ name: "code", sessions: ["a", "b"] }],
          ungrouped: [],
        };
        await store.restore({ snapshot: "20260814T125000", sessions: ["b"] });

        expect(store.toast()).not.toMatch(/elsewhere/i);
        const code = store.model().groups.find((g) => g.name === "code");
        expect(code!.sessions.map((s) => s.name)).toEqual(["a", "b"]);
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
    // clears the input and strands an optimistic card that never resolves.
    const api = new FakeApi();
    api.putError = true;
    await withStore(api, async (store) => {
      await store.refresh();
      await store.create("ghost", "");
      expect(names(store)).toEqual([]);
      expect(store.toast()).toMatch(/layout/i);

      api.putError = false;
      await store.create("ghost", "");
      expect(names(store)).toHaveLength(1);
      expect(isSessionId(names(store)[0]!)).toBe(true);
    });
  });

  /**
   * The poll is the lobby's only view of the world, and on a slow or flaky
   * network it is the part that breaks first: requests that never answer,
   * answers that arrive in the wrong order, and a fixed 5s cadence that keeps
   * hammering a link already failing to carry it.
   */
  describe("polling on a slow or unreliable network", () => {
    /** Run every microtask, and any timer due within `ms`. */
    const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

    it("drops a slow poll's answer once a newer one has already landed", async () => {
      const api = new GatedApi();
      api.sessionsVal = [sess("a")];
      api.layoutVal = { ...emptyLayout(), ungrouped: ["a"] };
      await withStore(api, async (store) => {
        await store.refresh(); // seeds whoami, so both polls below start at the fetch

        api.gate = true;
        const slow = store.refresh();

        // the world moves on while the slow poll is still out
        api.sessionsVal = [sess("b")];
        api.layoutVal = { ...emptyLayout(), ungrouped: ["b"] };
        const fresh = store.refresh();
        expect(api.pending).toHaveLength(2);

        api.pending[1]!.resolve([sess("b")]);
        await fresh;
        expect(names(store)).toEqual(["b"]);

        // …and the older poll finally answers with the world as it WAS
        api.pending[0]!.resolve([sess("a")]);
        await slow;
        expect(names(store)).toEqual(["b"]);
        expect(store.layout().ungrouped).toEqual(["b"]);
        expect(store.toast()).toBeNull();
      });
    });

    it("never lets a poll slower than the interval pile up behind itself", async () => {
      vi.useFakeTimers();
      const api = new GatedApi();
      api.gate = true;
      await withStore(
        api,
        async (store) => {
          await settle();
          expect(api.sessionCalls).toBe(1);

          await settle(60000); // twelve intervals pass with the poll still open
          expect(api.sessionCalls).toBe(1);

          api.pending[0]!.resolve([sess("a")]);
          await settle();
          expect(names(store)).toEqual(["a"]);

          await settle(5000); // the next poll is scheduled off the ANSWER
          expect(api.sessionCalls).toBe(2);
        },
        { autoStart: true },
      );
    });

    it("keeps the last-known-good list when a poll times out", async () => {
      const api = new FakeApi();
      api.sessionsVal = [sess("a"), sess("b")];
      api.layoutVal = { ...emptyLayout(), ungrouped: ["a", "b"] };
      await withStore(api, async (store) => {
        await store.refresh();
        expect(names(store)).toEqual(["a", "b"]);

        api.sessionsError = new DOMException("The operation timed out.", "TimeoutError");
        api.layoutError = true;
        await store.refresh();

        expect(names(store)).toEqual(["a", "b"]); // nothing wiped
        expect(store.layout().ungrouped).toEqual(["a", "b"]);
        expect(store.loadError()).toMatch(/sessions/i); // …but the failure is shown

        api.sessionsError = undefined;
        api.layoutError = false;
        await store.refresh();
        expect(store.loadError()).toBeNull();
      });
    });

    it("backs off 5s → 10s → 20s → 30s while polls fail, and snaps back on success", async () => {
      vi.useFakeTimers();
      const api = new FakeApi();
      api.sessionsVal = [sess("a")];
      await withStore(
        api,
        async (store) => {
          await settle();
          expect(api.sessionCalls).toBe(1);

          api.sessionsError = new Error("network down");

          await settle(5000); // 1st failure → next at +10s
          expect(api.sessionCalls).toBe(2);
          await settle(5000);
          expect(api.sessionCalls).toBe(2);
          await settle(5000); // 2nd failure → next at +20s
          expect(api.sessionCalls).toBe(3);

          await settle(19999);
          expect(api.sessionCalls).toBe(3);
          await settle(1); // 3rd failure → next at +40s, capped to 30s
          expect(api.sessionCalls).toBe(4);

          await settle(29999);
          expect(api.sessionCalls).toBe(4);
          api.sessionsError = undefined;
          await settle(1); // the poll that finally succeeds
          expect(api.sessionCalls).toBe(5);

          await settle(5000); // one success is enough to restore the cadence
          expect(api.sessionCalls).toBe(6);
          expect(names(store)).toEqual(["a"]); // and the list was never lost
        },
        { autoStart: true },
      );
    });

    it("holds at the 30s cap however long the outage runs", async () => {
      vi.useFakeTimers();
      const api = new FakeApi();
      api.sessionsError = new Error("network down");
      await withStore(
        api,
        async () => {
          await settle(); // the very first poll already fails
          expect(api.sessionCalls).toBe(1);
          await settle(10000);
          expect(api.sessionCalls).toBe(2);
          await settle(20000);
          expect(api.sessionCalls).toBe(3);

          for (let i = 0; i < 4; i++) {
            await settle(29999);
            expect(api.sessionCalls).toBe(3 + i);
            await settle(1);
            expect(api.sessionCalls).toBe(4 + i);
          }
        },
        { autoStart: true },
      );
    });

    it("refreshes at once when the network comes back, and drops the backoff", async () => {
      vi.useFakeTimers();
      const api = new FakeApi();
      api.sessionsVal = [sess("a")];
      await withStore(
        api,
        async (store) => {
          await settle();
          api.sessionsError = new Error("network down");
          await settle(5000); // → next at +10s
          await settle(10000); // → next at +20s
          expect(api.sessionCalls).toBe(3);

          api.sessionsError = undefined;
          window.dispatchEvent(new Event("online"));
          await settle();
          expect(api.sessionCalls).toBe(4); // not 20s from now — now
          expect(store.loadError()).toBeNull();

          await settle(5000); // back on the base cadence, not the ladder
          expect(api.sessionCalls).toBe(5);
        },
        { autoStart: true },
      );
    });

    it("stops polling and unhooks its listeners on dispose", async () => {
      vi.useFakeTimers();
      const api = new FakeApi();
      await withStore(
        api,
        async (store) => {
          await settle();
          const before = api.sessionCalls;

          store.dispose();

          await settle(60000);
          expect(api.sessionCalls).toBe(before);

          window.dispatchEvent(new Event("online"));
          await settle();
          expect(api.sessionCalls).toBe(before);

          document.dispatchEvent(new Event("visibilitychange"));
          await settle();
          expect(api.sessionCalls).toBe(before);
        },
        { autoStart: true },
      );
    });

    /**
     * A hidden tab is the dominant cost of this poll, not the visible one. Two
     * lobby tabs left open drove 63k requests/day through Cloudflare on
     * 2026-08-15 (31.5k /sessions + 31.4k /layout — the poll fires both), which
     * with the Worker on a wildcard route was a material share of a 100k/day
     * quota. Nobody is reading a backgrounded list, and `wake()` already
     * refreshes on visibilitychange, so a hidden tab has nothing to poll FOR.
     */
    describe("a hidden tab", () => {
      /** Drive document.visibilityState, which jsdom leaves read-only. */
      const setVisibility = (state: "visible" | "hidden") => {
        Object.defineProperty(document, "visibilityState", {
          value: state,
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      };

      afterEach(() => setVisibility("visible"));

      it("stops polling while hidden", async () => {
        vi.useFakeTimers();
        const api = new FakeApi();
        await withStore(
          api,
          async () => {
            await settle();
            await settle(5000);
            const before = api.sessionCalls;
            expect(before).toBeGreaterThan(0);

            setVisibility("hidden");
            await settle();

            // Ten intervals go by with nobody looking at the tab.
            await settle(50000);
            expect(api.sessionCalls).toBe(before);
          },
          { autoStart: true },
        );
      });

      it("catches up at once when the tab comes back, and resumes the cadence", async () => {
        vi.useFakeTimers();
        const api = new FakeApi();
        await withStore(
          api,
          async () => {
            await settle();
            setVisibility("hidden");
            await settle(50000);
            const whileHidden = api.sessionCalls;

            setVisibility("visible");
            await settle();
            // Immediately, not after sitting out another interval.
            expect(api.sessionCalls).toBe(whileHidden + 1);

            await settle(5000);
            expect(api.sessionCalls).toBe(whileHidden + 2);
          },
          { autoStart: true },
        );
      });

      it("does not resume polling on an `online` event while still hidden", async () => {
        vi.useFakeTimers();
        const api = new FakeApi();
        await withStore(
          api,
          async () => {
            await settle();
            setVisibility("hidden");
            await settle(50000);
            const whileHidden = api.sessionCalls;

            window.dispatchEvent(new Event("online"));
            await settle(50000);

            expect(api.sessionCalls).toBe(whileHidden);
          },
          { autoStart: true },
        );
      });
    });

    it("a poll still in flight at dispose cannot restart the loop", async () => {
      vi.useFakeTimers();
      const api = new GatedApi();
      api.gate = true;
      await withStore(
        api,
        async (store) => {
          await settle();
          expect(api.sessionCalls).toBe(1);

          store.dispose();
          api.pending[0]!.resolve([sess("a")]); // answers after the store is gone
          await settle(60000);

          expect(api.sessionCalls).toBe(1);
        },
        { autoStart: true },
      );
    });
  });
});
