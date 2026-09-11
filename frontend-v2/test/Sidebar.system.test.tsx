import { describe, it, expect, beforeEach } from "vitest";
import { onCleanup } from "solid-js";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ORIGIN_USER, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { SYSTEM_KEY } from "../src/store/collapse";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

/**
 * The System group on screen (design doc
 * `docs/plans/2026-09-06-test-session-origin-design.md`).
 *
 * Hand-rolled in the sidebar rather than drawn by <ProjectGroup>, for the same
 * reason "Shared with me" is: it is not a project. It cannot be renamed,
 * deleted, dragged or added to, and the layout has no slot for it — so what it
 * shares with a project is a header, a chevron and a count, and nothing else.
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

/** A session nobody stamped — what the strays measured on 2026-09-06 looked like. */
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

describe("<Sidebar> — the System group", () => {
  it("shows its count while collapsed, with no cards under it", async () => {
    // The count is the whole of the evidence a person gets that something
    // landed here wrongly: the group opens closed, so a count that only
    // appeared once you opened it would say nothing to anybody who never did.
    const api = new FakeApi();
    api.sessionsVal = [sess("mine"), stray("shell-2"), sess("qa-slug", { origin: "test" })];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["mine", "qa-slug"] };
    const { getByLabelText, queryByText, container, store } = mount(api);
    await store.refresh();

    const header = await waitFor(() => getByLabelText("System group"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.querySelector(".tl-group-count")!.textContent).toBe("2");
    expect(queryByText("shell-2")).toBeNull();
    expect(queryByText("qa-slug")).toBeNull();
    // The person's own session is untouched by any of this.
    expect(queryByText("mine")).not.toBeNull();
    expect(container.querySelectorAll(".tl-card")).toHaveLength(1);
    store.dispose();
  });

  it("opens on a click and closes again, and the device remembers", async () => {
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    const { getByLabelText, queryByText, store } = mount(api);
    await store.refresh();
    const header = await waitFor(() => getByLabelText("System group"));

    fireEvent.click(header);
    await waitFor(() => expect(queryByText("shell-2")).not.toBeNull());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(store.collapse.isCollapsed(SYSTEM_KEY)).toBe(false);

    fireEvent.click(header);
    await waitFor(() => expect(queryByText("shell-2")).toBeNull());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    store.dispose();
  });

  it("toggles from the keyboard, like every other group header", async () => {
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    const { getByLabelText, queryByText, store } = mount(api);
    await store.refresh();
    const header = await waitFor(() => getByLabelText("System group"));
    expect(header.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(header, { key: "Enter" });
    await waitFor(() => expect(queryByText("shell-2")).not.toBeNull());
    fireEvent.keyDown(header, { key: " " });
    await waitFor(() => expect(queryByText("shell-2")).toBeNull());
    store.dispose();
  });

  it("hides while nothing has landed in it", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine")];
    const { queryByLabelText, container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
    expect(queryByLabelText("System group")).toBeNull();
    store.dispose();
  });

  it("sits at the foot, under every project, Ungrouped and Shared with me", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine"), sess("theirs", { owner: "emo" }), stray("shell-2")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: [] }],
      ungrouped: ["mine"],
      ungroupedIndex: 1,
    };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toContain("System"));
    expect(titles(container)).toEqual(["work", "Ungrouped", "Shared with me", "System"]);
    store.dispose();
  });

  it("offers none of a project's controls, and cannot be dragged", async () => {
    // No `+` (nothing creates a session INTO System), no ⋯ (nothing to rename,
    // delete or move) and no token (the sidebar's group sortable reads that
    // attribute to decide what may be picked up, and System is pinned).
    const api = new FakeApi();
    api.sessionsVal = [stray("shell-2")];
    const { getByLabelText, store } = mount(api);
    await store.refresh();
    const header = await waitFor(() => getByLabelText("System group"));
    const group = header.closest(".tl-group")!;

    expect(group.hasAttribute("data-token")).toBe(false);
    expect(header.querySelector("button")).toBeNull();
    store.dispose();
  });
});
