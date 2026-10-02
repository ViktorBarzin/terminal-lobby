import { describe, it, expect, beforeEach } from "vitest";
import { onCleanup } from "solid-js";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ORIGIN_USER, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { callerGroupName } from "../src/components/lobby.logic";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

/**
 * A Caller's group on screen (CONTEXT.md: Origin, Caller).
 *
 * Drawn the way System is, since it is the same kind of group: its members come
 * from each session's origin, so it has a header, a chevron and a count, and
 * none of a project's controls. It sits just above System and starts closed.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  origin: ORIGIN_USER,
  ...over,
});

/** A session Muse opened through agent-api. */
const muse = (name: string, over: Partial<Session> = {}): Session =>
  sess(name, { origin: "muse", caller: "muse", ...over });

/** A session nobody stamped. */
const stray = (name: string, over: Partial<Session> = {}): Session => {
  const s = sess(name, over);
  delete s.origin;
  return s;
};

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
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
}

function mount(api: LobbyApi) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} />;
  });
  return { ...utils, store: store!, prefs: prefs! };
}

const titles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".tl-group-title")].map((el) => el.textContent ?? "");

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("<Sidebar> — a Caller's group", () => {
  it("shows the Caller's name and its count while collapsed", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine"), muse("session-ready"), muse("weekly-digest")];
    const { getByLabelText, queryByText, store } = mount(api);
    await store.refresh();

    const header = await waitFor(() => getByLabelText("Muse group"));
    expect(header.querySelector(".tl-group-title")!.textContent).toBe("Muse");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.querySelector(".tl-group-count")!.textContent).toBe("2");
    expect(queryByText("session-ready")).toBeNull();
    expect(queryByText("mine")).not.toBeNull();
    store.dispose();
  });

  it("opens on a click, and the device remembers it per Caller", async () => {
    const api = new FakeApi();
    api.sessionsVal = [muse("session-ready")];
    const { getByLabelText, queryByText, store } = mount(api);
    await store.refresh();
    const header = await waitFor(() => getByLabelText("Muse group"));

    fireEvent.click(header);
    await waitFor(() => expect(queryByText("session-ready")).not.toBeNull());
    expect(store.collapse.isCollapsed(callerGroupName("muse"))).toBe(false);

    fireEvent.keyDown(header, { key: "Enter" });
    await waitFor(() => expect(queryByText("session-ready")).toBeNull());
    store.dispose();
  });

  it("hides while the Caller has nothing live", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine")];
    const { queryByLabelText, container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
    expect(queryByLabelText("Muse group")).toBeNull();
    store.dispose();
  });

  it("sits just above System, one group per Caller in name order", async () => {
    const api = new FakeApi();
    api.sessionsVal = [
      sess("mine"),
      sess("theirs", { owner: "emo" }),
      muse("session-ready"),
      sess("nightly", { origin: "ci", caller: "ci" }),
      stray("shell-2"),
    ];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: [] }],
      ungrouped: ["mine"],
      ungroupedIndex: 1,
    };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toContain("Muse"));
    expect(titles(container)).toEqual([
      "work",
      "Ungrouped",
      "Shared with me",
      "Ci",
      "Muse",
      "System",
    ]);
    store.dispose();
  });

  it("offers none of a project's controls, and cannot be dragged", async () => {
    const api = new FakeApi();
    api.sessionsVal = [muse("session-ready")];
    const { getByLabelText, store } = mount(api);
    await store.refresh();
    const header = await waitFor(() => getByLabelText("Muse group"));
    const group = header.closest(".tl-group")!;
    expect(group.hasAttribute("data-token")).toBe(false);
    expect(header.querySelector("button")).toBeNull();
    store.dispose();
  });
});
