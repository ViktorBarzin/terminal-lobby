import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import {
  ApiError,
  type LobbyApi,
  type T3Created,
  type T3CreateRequest,
} from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session } from "../src/types/lobby";
import { notifySnapshotOf } from "../src/components/lobby.logic";
import { createRunAppCommand } from "../src/keybindings/commands";
import type { PaletteController } from "../src/keybindings/palette-controller";
import { toasts } from "../src/store/toast";

/**
 * The store's half of T3 rows (ADR-0046): every way into a session opens a T3
 * row in T3 rather than selecting it, every way of closing one archives it,
 * and New in T3 goes to POST /sessions/t3.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  origin: "user",
  tool: "claude",
  ...over,
});

const T3 = "t3_abcdefghijkl";
const t3 = (over: Partial<Session> = {}) =>
  sess(T3, {
    backend: "t3",
    title: "In T3",
    url: "https://t3.example.test/env/mcp%3A1",
    appUrl: "t3code://threads/env/mcp:1",
    ...over,
  });

class T3Api implements LobbyApi {
  sessionsVal: Session[] = [sess("work"), t3()];
  layoutVal: Layout = emptyLayout();
  archived: string[] = [];
  killed: string[] = [];
  created: T3CreateRequest[] = [];
  refuse: ApiError | null = null;
  async whoami() {
    return { authentik: "wiz@x", osUser: "wizard", t3: true, claudeBackend: "t3" as const };
  }
  async listSessions() {
    return structuredClone(this.sessionsVal);
  }
  async getLayout() {
    return structuredClone(this.layoutVal);
  }
  async putLayout(l: Layout) {
    this.layoutVal = l;
  }
  async killSession(name: string) {
    this.killed.push(name);
  }
  async setSessionTitle() {}
  async setSessionOrigin() {}
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
  async prewarm() {}
  async releasePrewarm() {}
  async archiveT3Session(name: string) {
    if (this.refuse) throw this.refuse;
    this.archived.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
  }
  async createT3Session(body: T3CreateRequest): Promise<T3Created> {
    if (this.refuse) throw this.refuse;
    this.created.push(body);
    return { name: "t3_newnewnewnew", url: "https://x/y", appUrl: "t3code://y", threadId: "mcp:2" };
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

let opened: unknown[][];
beforeEach(() => {
  toasts.clear();
  opened = [];
  vi.stubGlobal("open", (...a: unknown[]) => void opened.push(a));
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("fine"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("lobby store — T3 rows", () => {
  it("opens a T3 row in T3 rather than selecting it", async () => {
    await withStore(new T3Api(), async (store) => {
      await store.refresh();
      store.select(T3);
      expect(store.selected()).toBeNull();
      expect(opened).toEqual([["https://t3.example.test/env/mcp%3A1", "_blank", "noopener"]]);
      // A tmux row still selects.
      store.select("work");
      expect(store.selected()?.name).toBe("work");
    });
  });

  it("archives a T3 row on a kill, at once and with nothing to undo", async () => {
    const api = new T3Api();
    await withStore(api, async (store) => {
      await store.refresh();
      await store.kill(T3);
      expect(api.archived).toEqual([T3]);
      expect(api.killed).toEqual([]);
      expect(store.killing(T3)).toBe(false);
      expect(store.sessions.map((s) => s.name)).toEqual(["work"]);
      expect(store.toast()).toContain("Archived In T3");
    });
  });

  it("says why an archive failed", async () => {
    const api = new T3Api();
    api.refuse = new ApiError(502, "T3 did not answer: connection refused");
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.archive(T3)).toBe(false);
      expect(store.toast()).toContain("connection refused");
      expect(store.sessions.some((s) => s.name === T3)).toBe(true);
    });
  });

  it("starts a thread in T3 and hands back its links", async () => {
    const api = new T3Api();
    await withStore(api, async (store) => {
      const made = await store.createT3({ dir: "/srv/a", prompt: "hi", project: "p" });
      expect(made?.url).toBe("https://x/y");
      expect(api.created).toEqual([{ dir: "/srv/a", prompt: "hi", project: "p" }]);
      expect(store.selected()).toBeNull();
    });
  });

  it("a refused create toasts and answers null", async () => {
    const api = new T3Api();
    api.refuse = new ApiError(404, "no T3 server for wizard");
    await withStore(api, async (store) => {
      expect(await store.createT3({ dir: "", prompt: "hi" })).toBeNull();
      expect(store.toast()).toContain("no T3 server");
    });
  });
});

describe("T3 rows and notifications", () => {
  it("are quiet: lobby notifications are for tmux sessions", () => {
    expect(notifySnapshotOf(t3()).quiet).toBe(true);
    expect(notifySnapshotOf(sess("work")).quiet).toBe(false);
  });
});

describe("next/previous session chords", () => {
  it("step over T3 rows, which would open a tab on every press", () => {
    const rows = [sess("a"), t3(), sess("b")];
    const select = vi.fn();
    let current = "a";
    const store = {
      selected: () => ({ name: current }),
      model: () => ({ groups: [{ kind: "ungrouped", name: "", sessions: rows }], foreign: [] }),
      sessions: rows,
      select: (n: string) => {
        select(n);
        current = n;
      },
    } as unknown as LobbyStore;
    const run = createRunAppCommand({
      store,
      palette: { isOpen: () => false, close: () => {} } as unknown as PaletteController,
      help: { isOpen: () => false, open: () => {}, close: () => {}, toggle: () => {} },
      toggleSidebar: () => {},
      focusNewSession: () => {},
      notify: () => {},
      openGallery: () => {},
      pasteToTerminal: () => true,
      toggleDock: () => {},
    });
    run("session.next");
    expect(select).toHaveBeenLastCalledWith("b");
    run("session.prev");
    expect(select).toHaveBeenLastCalledWith("a");
  });
});
