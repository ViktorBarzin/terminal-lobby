import { describe, it, expect } from "vitest";
import { createRoot } from "solid-js";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session } from "../src/types/lobby";

/**
 * The store's half of the session menu's Restart: send it, say how it went,
 * and refresh so the card shows the restarted session without waiting a poll.
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

class RestartApi implements LobbyApi {
  sessionsVal: Session[] = [sess("notes", { state: "running" })];
  layoutVal: Layout = emptyLayout();
  sent: string[] = [];
  /** [status, message] to throw instead of restarting; null restarts. */
  refuse: [number, string] | null = null;

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
  async restartSession(name: string) {
    if (this.refuse) throw new ApiError(this.refuse[0], this.refuse[1]);
    this.sent.push(name);
    this.sessionsVal = this.sessionsVal.map((s) => (s.name === name ? { ...s, state: "done" } : s));
  }
}

/** A server that predates the route. */
class OldApi extends RestartApi {
  override restartSession = undefined as unknown as RestartApi["restartSession"];
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

describe("lobby store — restart", () => {
  it("restarts, says so, and shows the session as it is now", async () => {
    const api = new RestartApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.restart("notes")).toBe(true);
      expect(api.sent).toEqual(["notes"]);
      expect(store.sessions.find((s) => s.name === "notes")?.state).toBe("done");
      expect(store.toast()).toMatch(/restarted/i);
    });
  });

  it("shows the server's reason when it refuses", async () => {
    const api = new RestartApi();
    api.refuse = [409, "the session has no conversation to restart yet"];
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.restart("notes")).toBe(false);
      expect(store.toast()).toMatch(/no conversation to restart yet/);
    });
  });

  it("says the session is gone on a 404", async () => {
    const api = new RestartApi();
    api.refuse = [404, "session not found"];
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.restart("notes")).toBe(false);
      expect(store.toast()).toMatch(/no longer exists/i);
    });
  });

  it("answers false on a server with no restart route", async () => {
    const api = new OldApi();
    await withStore(api, async (store) => {
      await store.refresh();
      expect(await store.restart("notes")).toBe(false);
    });
  });
});
