import { describe, it, expect } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session, type SettableState } from "../src/types/lobby";

/**
 * The store's half of correcting a state dot by hand.
 *
 * The write goes to the same `@claude_state` the hooks write, so the store has
 * nothing to expire and nothing to remember: it sends, refreshes, and lets the
 * next poll say what the session is. What it does own is the answer — TRUE
 * only when the stamp landed — because the card has no other way to tell a
 * refusal from a correction that simply has not reached a poll yet.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  origin: "user",
  ...over,
});

class StateApi implements LobbyApi {
  sessionsVal: Session[] = [sess("stuck", { state: "running" })];
  layoutVal: Layout = emptyLayout();
  sent: [string, SettableState][] = [];
  /** status to throw instead of writing; 0 writes. */
  refuse = 0;

  async whoami() {
    return { authentik: "wiz@x", osUser: "wizard" };
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
  async killSession() {}
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
  async setSessionState(name: string, state: SettableState) {
    if (this.refuse) throw new ApiError(this.refuse, "refused");
    this.sent.push([name, state]);
    // The server stamps the option; the next list is where a client sees it.
    this.sessionsVal = this.sessionsVal.map((s) => (s.name === name ? { ...s, state } : s));
  }
}

/** The same fake with no state route at all — a server that predates it. */
class OldApi extends StateApi {
  override setSessionState = undefined as unknown as StateApi["setSessionState"];
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

describe("lobby store — setState", () => {
  it("sends the correction and shows it without waiting for the next poll", async () => {
    const api = new StateApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(store.sessions.find((s) => s.name === "stuck")?.state).toBe("running");

      expect(await store.setState("stuck", "done")).toBe(true);
      expect(api.sent).toEqual([["stuck", "done"]]);
      // Refreshed inside the call: the person who pressed it is watching the
      // dot, and the poll is five seconds away.
      expect(store.sessions.find((s) => s.name === "stuck")?.state).toBe("done");
      expect(store.toast()).toBeNull();
    });
  });

  it("says so when the session has no state to correct", async () => {
    const api = new StateApi();
    api.refuse = 409;
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.setState("stuck", "done")).toBe(false);
      expect(store.toast()).toMatch(/no Claude state/i);
      expect(store.sessions.find((s) => s.name === "stuck")?.state).toBe("running");
    });
  });

  it("says so when the session is gone", async () => {
    const api = new StateApi();
    api.refuse = 404;
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.setState("stuck", "done")).toBe(false);
      expect(store.toast()).toMatch(/no longer exists/i);
    });
  });

  it("answers false on a server with no state route, and toasts nothing", async () => {
    // There is nothing to tell a person here: an old server simply has no
    // rows, because the card reads the same answer to decide whether to draw
    // them.
    const api = new OldApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.setState("stuck", "done")).toBe(false);
      expect(store.toast()).toBeNull();
    });
  });
});
