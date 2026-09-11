import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, ORIGIN_USER, setSessionOrigin, type LobbyApi } from "../src/lib/lobby-api";
import { isSystemSession, SYSTEM_GROUP_NAME } from "../src/components/lobby.logic";
import {
  emptyLayout,
  type Layout,
  type Session,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

/**
 * The rescue (design doc `docs/plans/2026-09-06-test-session-origin-design.md`).
 *
 * Dragging a card out of System adopts the session for good: the drop writes
 * the layout as any drop does, and it also tells the SERVER the session is a
 * person's now. Without that second half the card would sit in a project while
 * tmux still called it a system session, so it would go on not pushing and not
 * recording, and the next reload would put it back where it came from.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  origin: ORIGIN_USER,
  ...over,
});

/** A session the lobby did not make — the three strays measured on 2026-09-06
 *  carried no origin at all, so that is the shape used here. */
const stray = (name: string, over: Partial<Session> = {}): Session => {
  const s = sess(name, over);
  delete s.origin;
  return s;
};

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  /** every (name, origin) this run was asked to stamp. */
  origins: [string, string][] = [];
  /** status the next setSessionOrigin should fail with; 0 answers 204. */
  originError = 0;

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
    if (this.originError) throw new ApiError(this.originError, "x");
    this.origins.push([name, origin]);
    this.sessionsVal = this.sessionsVal.map((s) => (s.name === name ? { ...s, origin } : s));
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

/** The group a session renders in right now: a project name, "" for Ungrouped,
 *  ":system" for System. */
const groupOf = (store: LobbyStore, name: string): string | undefined =>
  store.model().groups.find((g) => g.sessions.some((s) => s.name === name))?.name;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /sessions/{name}/origin", () => {
  it("sends the origin as JSON and takes 204 for an answer", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await setSessionOrigin("qa slug", ORIGIN_USER);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/qa%20slug\/origin$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ origin: "user" });
  });

  it("throws with the status when the server refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response("session not found", { status: 404 }));
    const err = await setSessionOrigin("gone", ORIGIN_USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("agrees with the predicate about what `user` is spelled like", async () => {
    // Three copies of this string exist — here, ORIGIN_USER in
    // components/lobby.logic.ts, and originUser in tmux-api/origin.go — and a
    // rescue that posted a fourth spelling would 400 on the server and read as
    // a system session forever on the client. This is the client half's guard.
    expect(isSystemSession(sess("mine", { origin: ORIGIN_USER }))).toBe(false);
  });
});

describe("dragging a card out of System", () => {
  it("stamps the session `user` on the server as well as writing the layout", async () => {
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: [] }],
      ungroupedIndex: 1,
    };
    await withStore(api, async (store) => {
      await store.refresh();
      expect(groupOf(store, "shell-2")).toBe(SYSTEM_GROUP_NAME);

      await store.move("shell-2", "work");

      expect(api.origins).toEqual([["shell-2", "user"]]);
      expect(api.puts.at(-1)!.projects[0]!.sessions).toEqual(["shell-2"]);
      // And on screen straight away, not at the next poll: deriveSidebar files
      // a system session in System whatever the layout says, so the card would
      // otherwise spring back for the rest of the poll interval.
      expect(groupOf(store, "shell-2")).toBe("work");
    });
  });

  it("adopts a session dropped into Ungrouped too", async () => {
    // Ungrouped is the one that cannot work on the layout alone: deriveSidebar
    // reads a system session OUT of layout.ungrouped on purpose (a harness
    // drives the ordinary create flow, so its sessions are filed there like
    // anybody's), and only the origin flip makes the card stay.
    const api = new FakeApi();
    api.sessionsVal = [sess("qa-slug", { origin: "test" })];
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("qa-slug", "");
      expect(api.origins).toEqual([["qa-slug", "user"]]);
      expect(groupOf(store, "qa-slug")).toBe("");
    });
  });

  it("leaves an ordinary session's move alone", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: [] }],
      ungroupedIndex: 1,
    };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("mine", "work");
      expect(api.origins).toEqual([]);
      expect(api.puts).toHaveLength(1);
    });
  });

  it("writes no layout at all when the stamp does not land", async () => {
    // The dishonest alternative: the layout says "work", the server still says
    // system. deriveSidebar honours an explicit project placement over the
    // origin, so the card would sit in `work` looking rescued while it went on
    // being silent — and nothing would ever tell anybody.
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: [] }],
      ungroupedIndex: 1,
    };
    api.originError = 500;
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("shell-2", "work");

      expect(api.puts).toHaveLength(0);
      expect(groupOf(store, "shell-2")).toBe(SYSTEM_GROUP_NAME);
      expect(store.toast()).toBeTruthy();
    });
  });

  it("says so plainly when the session died under the drag", async () => {
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    api.originError = 404;
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("shell-2", "");
      expect(store.toast()).toMatch(/no longer exists/i);
      expect(api.puts).toHaveLength(0);
    });
  });
});

describe("dropping something INTO System", () => {
  it("is refused, because the layout has no slot to write it to", async () => {
    // moveSession would strip every reference to the name and put it back
    // nowhere, so a user session dragged in would reappear in Ungrouped having
    // silently lost its project.
    const api = new FakeApi();
    api.sessionsVal = [sess("mine")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["mine"] }],
      ungroupedIndex: 1,
    };
    await withStore(api, async (store) => {
      await store.refresh();
      await store.move("mine", SYSTEM_GROUP_NAME);
      expect(api.puts).toHaveLength(0);
      expect(api.origins).toEqual([]);
      expect(groupOf(store, "mine")).toBe("work");
    });
  });
});

describe("a session the lobby has just created", () => {
  it("is a user session on the optimistic card, not a stray", async () => {
    // The card exists before tmux-api has heard of the session, so nothing but
    // this stamp says who made it — and an unstamped card files itself into a
    // collapsed System group, which is where a create the user is watching
    // would disappear to.
    const api = new FakeApi();
    await withStore(api, async (store) => {
      await store.refresh();
      const id = await store.create("hello", "");
      expect(groupOf(store, id)).toBe("");
    });
  });
});
