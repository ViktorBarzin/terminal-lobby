import { describe, it, expect, beforeEach } from "vitest";
import { onCleanup } from "solid-js";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, PREFS_KEY, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
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
  kills: string[] = [];
  async killSession(n: string) {
    this.kills.push(n);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== n);
  }
  async renameSession() {
    throw new ApiError(404, "no");
  }
  async restoreSessions() {}
  async listDirs() {
    return [];
  }
}

/**
 * Render <Sidebar> with a freshly-built store + prefs store; returns utils and
 * both. The prefs store seeds itself from localStorage and never reaches the
 * network (its PUT is debounced past the end of the test).
 */
function mount(api: LobbyApi, over: { confirm?: (message: string) => boolean } = {}) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} confirm={over.confirm} />;
  });
  return { ...utils, store: store!, prefs: prefs! };
}

/** jsdom has no layout: give a card a real box so the drop edge is decidable. */
function stubRect(el: Element, top: number, height = 20): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("<Sidebar>", () => {
  it("renders grouped sessions with the right state dots", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("running1", { state: "running" }), sess("waiting1", { state: "awaiting" })];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["running1"] }], ungrouped: ["waiting1"] };
    const { getByText, container, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(getByText("running1")).toBeInTheDocument());
    expect(getByText("waiting1")).toBeInTheDocument();
    expect(getByText("work")).toBeInTheDocument();
    expect(container.querySelector(".tl-state-running")).not.toBeNull();
    expect(container.querySelector(".tl-state-awaiting")).not.toBeNull();
    store.dispose();
  });

  it("marks each row with the tool it is running, beside the state dot", async () => {
    const api = new FakeApi();
    api.sessionsVal = [
      sess("agent", { state: "running", tool: "claude" }),
      sess("cdx", { state: "", tool: "codex" }),
      sess("plain", { tool: "shell" }),
      sess("unknown"), // pre-tool server / failed proc scan
    ];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["agent", "cdx", "plain", "unknown"] };
    const { container, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(4));
    const cards = [...container.querySelectorAll(".tl-card")];
    expect(cards[0]!.querySelector(".tl-tool-claude")).not.toBeNull();
    expect(cards[1]!.querySelector(".tl-tool-codex")).not.toBeNull();
    expect(cards[2]!.querySelector(".tl-tool-shell")).not.toBeNull();
    expect(cards[3]!.querySelector(".tl-tool")).toBeNull();

    // the state dot keeps the leftmost slot; the mark follows it
    const first = cards[0]!.querySelector(".tl-state-dot")!;
    expect(first.nextElementSibling!.classList.contains("tl-tool")).toBe(true);

    // and the row's accessible name says what is running
    expect(cards[0]!.getAttribute("aria-label")).toMatch(/claude/i);
    store.dispose();
  });

  it("leads the row menu with Rename then Kill", async () => {
    // The two actions actually reached for sit at the top (Viktor,
    // 2026-08-02); Rename first so the destructive one is not under the
    // cursor as the menu opens.
    const api = new FakeApi();
    api.sessionsVal = [sess("solo")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }], ungrouped: ["solo"] };
    const { container, getByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(getByLabelText("Session actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    const labels = [...container.querySelectorAll(".tl-menu-item")].map((b) => b.textContent);
    expect(labels.slice(0, 2)).toEqual(["Rename", "Kill"]);
    expect(labels).toContain("work"); // move targets stay available, below
    store.dispose();
  });

  it("shows an empty state when there are no sessions or projects", async () => {
    const api = new FakeApi();
    const { getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(getByText(/No sessions yet/)).toBeInTheDocument());
    store.dispose();
  });

  it("creates a session from the new-session row (PUTs the layout)", async () => {
    const api = new FakeApi();
    const { getByPlaceholderText, store } = mount(api);
    await store.refresh();

    const input = getByPlaceholderText("new session…") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "fresh" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(store.selected()?.name).toBe("fresh"));
    expect(api.puts.length).toBe(1);
    expect(api.puts[0]!.ungrouped).toContain("fresh");
    store.dispose();
  });

  it("selects a session when its card is clicked", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("pickme")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["pickme"] };
    const { getByText, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(getByText("pickme")).toBeInTheDocument());
    fireEvent.click(getByText("pickme"));
    expect(store.selected()?.name).toBe("pickme");
    store.dispose();
  });

  it("collapses a group, hiding its cards, and persists the choice", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("inwork")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["inwork"] }] };
    const { getByText, queryByText, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(getByText("inwork")).toBeInTheDocument());
    fireEvent.click(getByText("work")); // header toggles collapse
    await waitFor(() => expect(queryByText("inwork")).toBeNull());
    expect(store.collapse.isCollapsed("work")).toBe(true);
    store.dispose();
  });

  it("drops a card where the indicator promised, past dead layout refs", async () => {
    // The project holds two dead refs before the live cards, so the rendered
    // index and the layout index disagree by two.
    const api = new FakeApi();
    api.sessionsVal = [sess("a"), sess("b"), sess("c")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["d1", "d2", "a", "b", "c"] }],
    };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(3));

    const cards = [...container.querySelectorAll(".tl-card")];
    stubRect(cards[1]!, 0, 20);
    fireEvent.dragStart(cards[0]!); // drag "a"
    fireEvent.dragOver(cards[1]!, { clientY: 15 }); // lower half of "b" → below
    expect(cards[1]!.classList.contains("tl-drop-below")).toBe(true);
    fireEvent.drop(cards[1]!);

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.puts[0]!.projects[0]!.sessions).toEqual(["d1", "d2", "b", "a", "c"]);
    expect([...container.querySelectorAll(".tl-card-name")].map((n) => n.textContent)).toEqual([
      "b",
      "a",
      "c",
    ]);
    store.dispose();
  });

  it("confirms before killing from the ⋯ menu, and honours a dismissal", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("doomed")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["doomed"] };
    const asked: string[] = [];
    const { container, getByLabelText, getByText, store } = mount(api, {
      confirm: (m) => {
        asked.push(m);
        return false; // user cancels
      },
    });
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(getByLabelText("Session actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    fireEvent.click(getByText("Kill"));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toBe('Kill session "doomed"?');
    expect(api.kills).toEqual([]); // dismissed → the session lives
    expect(container.querySelector(".tl-card")).not.toBeNull();
    store.dispose();
  });

  it("kills from the ⋯ menu once the confirm is accepted", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("doomed")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["doomed"] };
    const { container, getByLabelText, getByText, store } = mount(api, { confirm: () => true });
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(getByLabelText("Session actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    fireEvent.click(getByText("Kill"));
    await waitFor(() => expect(api.kills).toEqual(["doomed"]));
    store.dispose();
  });

  it("binds the create-row command dropdown to the roamed pref", async () => {
    const api = new FakeApi();
    const { getByLabelText, store, prefs } = mount(api);
    await store.refresh();

    const select = getByLabelText("Command for new session") as HTMLSelectElement;
    expect(select.value).toBe("claude");
    fireEvent.change(select, { target: { value: "shell" } });
    expect(prefs.prefs().session.newCommand).toBe("shell");
    store.dispose();
  });

  it("reflects the roamed pref in the dropdown, showing 'default' as claude", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "codex" } }));
    const api = new FakeApi();
    const first = mount(api);
    await first.store.refresh();
    expect((first.getByLabelText("Command for new session") as HTMLSelectElement).value).toBe("codex");
    first.store.dispose();
    first.unmount();

    // 'default' is a valid backing value for launcher accounts: show claude
    // without overwriting the pref.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "default" } }));
    const second = mount(api);
    await second.store.refresh();
    expect((second.getByLabelText("Command for new session") as HTMLSelectElement).value).toBe("claude");
    expect(second.prefs.prefs().session.newCommand).toBe("default");
    second.store.dispose();
  });

  it("lists foreign sessions under Shared with me", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("theirs", { owner: "bob", access: "rw" })];
    const { getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(getByText("Shared with me")).toBeInTheDocument());
    expect(getByText("theirs")).toBeInTheDocument();
    store.dispose();
  });
});
