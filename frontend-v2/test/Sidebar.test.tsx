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
  /** set to make the next whoami/listSessions reject (load-error paths). */
  whoamiErr: ApiError | null = null;
  sessionsErr: ApiError | null = null;
  async whoami() {
    if (this.whoamiErr) throw this.whoamiErr;
    return this.whoamiVal;
  }
  async listSessions() {
    if (this.sessionsErr) throw this.sessionsErr;
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
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
  async listDirs() {
    return [];
  }
}

/**
 * Render <Sidebar> with a freshly-built store + prefs store; returns utils and
 * both. The prefs store seeds itself from localStorage and never reaches the
 * network (its PUT is debounced past the end of the test).
 */
function mount(
  api: LobbyApi,
  over: {
    confirm?: (message: string) => boolean;
    notifications?: Parameters<typeof Sidebar>[0]["notifications"];
    onReload?: () => void;
  } = {},
) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return (
      <Sidebar
        store={store}
        prefs={prefs}
        confirm={over.confirm}
        notifications={over.notifications}
        onReload={over.onReload}
      />
    );
  });
  return { ...utils, store: store!, prefs: prefs! };
}

/** jsdom has no PointerEvent; a bubbling MouseEvent stands in for the dismiss
 *  listener, which only reads `target`. */
function firePointerDown(el: Node): void {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
}

/** Three polls' worth of fresh, genuinely-moved payload. */
async function poll(api: FakeApi, store: LobbyStore, times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    api.sessionsVal = api.sessionsVal.map((s) => ({ ...s, lastActivity: s.lastActivity + 1 }));
    api.layoutVal = structuredClone(api.layoutVal);
    await store.refresh();
  }
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
    const { getByText, container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(getByText(/No sessions yet/)).toBeInTheDocument());
    // control: a healthy brand-new user gets the empty state on its own.
    expect(container.querySelector(".tl-sidebar-error")).toBeNull();
    store.dispose();
  });

  it("does not claim 'No sessions yet' when whoami was denied", async () => {
    // resolveOSUser 403s an Authentik user with no terminal-account mapping;
    // refresh() then returns before /sessions or /layout is ever called, so the
    // sidebar knows nothing about the user's sessions and must not assert there
    // are none.
    const api = new FakeApi();
    api.whoamiErr = new ApiError(403, "denied");
    const { getByText, queryByText, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(getByText(/Access denied \(HTTP 403\)/)).toBeInTheDocument());
    expect(queryByText(/No sessions yet/)).toBeNull();
    store.dispose();
  });

  it("does not claim 'No sessions yet' when a cold /sessions load failed", async () => {
    // Brand-new user (empty layout) + a transient 500 on the first poll: the
    // empty layout alone must not be read as "no sessions".
    const api = new FakeApi();
    api.sessionsErr = new ApiError(500, "boom");
    const { getByText, queryByText, store } = mount(api);
    await store.refresh();

    await waitFor(() => expect(getByText(/Failed to load sessions/)).toBeInTheDocument());
    expect(queryByText(/No sessions yet/)).toBeNull();

    // …and the suppression is only for as long as the error is: once a poll
    // succeeds and confirms the account really is empty, the empty state is
    // back. Deferring the claim, not deleting it.
    api.sessionsErr = null;
    await store.refresh();
    await waitFor(() => expect(getByText(/No sessions yet/)).toBeInTheDocument());
    expect(queryByText(/Failed to load sessions/)).toBeNull();
    store.dispose();
  });

  it("keeps an established user's cards through a failed poll and recovers", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("alive")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alive"] };
    const { getByText, queryByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(getByText("alive")).toBeInTheDocument());

    api.sessionsErr = new ApiError(500, "boom");
    await store.refresh();
    await waitFor(() => expect(getByText(/Failed to load sessions/)).toBeInTheDocument());
    // control: the cards stay put and the empty state never appears over them.
    expect(getByText("alive")).toBeInTheDocument();
    expect(queryByText(/No sessions yet/)).toBeNull();

    api.sessionsErr = null;
    await store.refresh();
    await waitFor(() => expect(queryByText(/Failed to load sessions/)).toBeNull());
    expect(getByText("alive")).toBeInTheDocument();
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

  it("keeps an open card ⋯ menu, and its DOM node, across three polls", async () => {
    // hold() exists for exactly this ("rename/drag/menu"), but the menu was
    // the one case that never took it — so the poll rebuilt the subtree and
    // the menu vanished within 5s of opening.
    const api = new FakeApi();
    api.sessionsVal = [sess("alpha"), sess("beta")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha", "beta"] };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(2));

    const card = container.querySelector(".tl-card")!;
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());

    await poll(api, store);

    expect(container.querySelector(".tl-card")).toBe(card); // same node, not a clone
    expect(container.querySelector(".tl-menu")).not.toBeNull();
    store.dispose();
  });

  it("keeps an open group ⋯ menu across three polls", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("inwork")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["inwork"] }] };
    const { container, getByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    const group = container.querySelector(".tl-group")!;
    fireEvent.click(getByLabelText("Group actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());

    await poll(api, store);

    expect(container.querySelector(".tl-group")).toBe(group);
    expect(container.querySelector(".tl-menu")).not.toBeNull();
    store.dispose();
  });

  it("keeps a half-typed in-project session name across three polls", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("inwork")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["inwork"] }] };
    const { container, getByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(getByLabelText("New session in project"));
    await waitFor(() => expect(container.querySelector(".tl-add-input")).not.toBeNull());
    const input = container.querySelector(".tl-add-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "qa-halftyped" } });

    await poll(api, store);

    expect(container.querySelector(".tl-add-input")).toBe(input);
    expect(input.value).toBe("qa-halftyped");
    store.dispose();
  });

  it("releases the poll hold when the menu closes", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("alpha")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha"] };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    const actions = container.querySelector(".tl-card-actions")!;
    fireEvent.click(actions);
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    fireEvent.click(actions); // toggle shut
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());

    api.sessionsVal = [sess("alpha"), sess("beta")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha", "beta"] };
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(2));
    store.dispose();
  });

  it("dismisses the card menu on Escape and on an outside pointerdown", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("alpha")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha"] };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
    const actions = container.querySelector(".tl-card-actions")!;

    fireEvent.click(actions);
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());

    fireEvent.click(actions);
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    firePointerDown(document.body);
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());
    store.dispose();
  });

  it("dismisses the group menu on Escape and on an outside pointerdown", async () => {
    const api = new FakeApi();
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }] };
    const { container, getByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-group")).not.toBeNull());

    fireEvent.click(getByLabelText("Group actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());

    fireEvent.click(getByLabelText("Group actions"));
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    firePointerDown(document.body);
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());
    store.dispose();
  });

  it("a pointerdown inside the open menu leaves it open", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("alpha")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha"] };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(container.querySelector(".tl-card-actions")!);
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    firePointerDown(container.querySelector(".tl-menu-item")!);
    expect(container.querySelector(".tl-menu")).not.toBeNull();
    store.dispose();
  });

  it("a collapsed group header keeps its member count beside the state chips", async () => {
    // Chips only cover members that HAVE a Claude state; dropping the total
    // hides everything else in the group.
    const api = new FakeApi();
    api.sessionsVal = [
      sess("r", { state: "running" }),
      sess("d", { state: "done" }),
      sess("plain"),
    ];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["r", "d", "plain"] }],
    };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(3));
    expect(container.querySelector(".tl-group-count")!.textContent).toBe("3");

    fireEvent.click(getByText("work"));
    await waitFor(() => expect(container.querySelector(".tl-card")).toBeNull());

    expect(container.querySelector(".tl-group-count")!.textContent).toBe("3");
    expect(container.querySelectorAll(".tl-chip").length).toBe(2);
    store.dispose();
  });

  it("keeps every group and card node when the manifest comes back reordered", async () => {
    // /sessions spans OS users and promises no order, so the same sessions come
    // back shuffled. The model was rebuilt from that array and <For> keys on
    // reference, so a shuffle re-created every group and card on screen — the
    // idle sidebar rebuilding itself several times a minute, and anything the
    // user had in flight on one of those nodes going with it.
    const api = new FakeApi();
    api.sessionsVal = [sess("a1"), sess("b1"), sess("c1")];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["a1"] }],
      ungrouped: ["b1", "c1"],
    };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(3));

    const groups = [...container.querySelectorAll(".tl-group")];
    const cards = [...container.querySelectorAll(".tl-card")];

    for (let i = 0; i < 3; i++) {
      api.sessionsVal = [...api.sessionsVal].reverse();
      api.layoutVal = structuredClone(api.layoutVal);
      await store.refresh();
    }

    [...container.querySelectorAll(".tl-group")].forEach((g, i) => expect(g).toBe(groups[i]));
    [...container.querySelectorAll(".tl-card")].forEach((c, i) => expect(c).toBe(cards[i]));
    store.dispose();
  });

  it("keeps this user's rows when somebody else's session appears", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("mine")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["mine"] };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
    const card = container.querySelector(".tl-card")!;

    api.sessionsVal = [...api.sessionsVal, sess("theirs", { owner: "bob", access: "ro" })];
    await store.refresh();
    await waitFor(() => expect(getByText("Shared with me")).toBeInTheDocument());

    expect(container.querySelector(".tl-card")).toBe(card);
    store.dispose();
  });

  it("double-clicking a card that is NOT the selected session opens its rename box", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("chosen"), sess("other")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["chosen", "other"] };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(2));

    fireEvent.click(getByText("chosen"));
    expect(store.selected()?.name).toBe("chosen");

    const other = [...container.querySelectorAll(".tl-card")][1]!;
    fireEvent.dblClick(other);

    await waitFor(() => expect(other.querySelector(".tl-card-rename")).not.toBeNull());
    expect((other.querySelector(".tl-card-rename") as HTMLInputElement).value).toBe("other");
    store.dispose();
  });

  it("still has the same card node to double-click after a poll", async () => {
    // A double-click is two clicks on ONE node: the browser fires `dblclick` at
    // the nearest common ancestor of the two targets, so a poll that swaps the
    // card out between them sends the event to the group instead and the rename
    // never opens. Nothing here is held — the card is not mid-interaction yet.
    const api = new FakeApi();
    api.sessionsVal = [sess("chosen"), sess("other")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["chosen", "other"] };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(2));

    const other = [...container.querySelectorAll(".tl-card")][1]!;
    fireEvent.click(getByText("chosen")); // select a DIFFERENT card

    // one poll's worth of churn between the two clicks
    api.sessionsVal = [...api.sessionsVal].reverse();
    await store.refresh();

    expect([...container.querySelectorAll(".tl-card")][1]).toBe(other);
    fireEvent.dblClick(other);
    await waitFor(() => expect(other.querySelector(".tl-card-rename")).not.toBeNull());
    store.dispose();
  });

  it("releases the poll hold when a card is unmounted mid-rename", async () => {
    // The rename box holds the poll, and only endRename gives it back — so a
    // card that goes away while the box is open (collapsing its group does
    // exactly that) stranded the sidebar: no poll, ever again, for the rest of
    // the session. ProjectGroup already guards its own two holds this way.
    const api = new FakeApi();
    api.sessionsVal = [sess("inwork")];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: ["inwork"] }] };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.dblClick(container.querySelector(".tl-card")!);
    await waitFor(() => expect(container.querySelector(".tl-card-rename")).not.toBeNull());

    fireEvent.click(getByText("work")); // collapse — the card unmounts under it
    await waitFor(() => expect(container.querySelector(".tl-card")).toBeNull());
    fireEvent.click(getByText("work")); // and back open

    api.sessionsVal = [...api.sessionsVal, sess("late")];
    api.layoutVal = { ...api.layoutVal, ungrouped: ["late"] };
    await store.refresh();

    await waitFor(() =>
      expect([...container.querySelectorAll(".tl-card-name")].map((n) => n.textContent)).toContain(
        "late",
      ),
    );
    store.dispose();
  });

  it("puts a newly created project above Ungrouped, not below it", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("loose")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["loose"] };
    const { container, getByText, getByPlaceholderText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    fireEvent.click(getByText("+ Project"));
    const input = getByPlaceholderText("new project name…") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "fresh" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect([...container.querySelectorAll(".tl-group-title")].map((n) => n.textContent)).toEqual([
        "fresh",
        "Ungrouped",
      ]),
    );
    store.dispose();
  });

  it("files a session under the project its own record names", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("t3", { project: "t3-code" })];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "t3-code", sessions: [] }] };
    const { container, getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());

    const group = getByText("t3-code").closest(".tl-group")!;
    expect(group.querySelector(".tl-card-name")!.textContent).toBe("t3");
    expect(group.querySelector(".tl-group-count")!.textContent).toBe("1");
    expect([...container.querySelectorAll(".tl-group-title")].map((n) => n.textContent)).toEqual([
      "t3-code",
    ]);
    store.dispose();
  });

  it("marks the Shared-with-me section collapsed, so its chevron rotates", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("theirs", { owner: "bob", access: "rw" })];
    const { getByText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(getByText("Shared with me")).toBeInTheDocument());

    const group = getByText("Shared with me").closest(".tl-group")!;
    expect(group.classList.contains("tl-group-collapsed")).toBe(false);

    fireEvent.click(getByText("Shared with me"));
    await waitFor(() => expect(group.classList.contains("tl-group-collapsed")).toBe(true));
    expect(group.querySelector(".tl-card")).toBeNull();
    store.dispose();
  });
});

/**
 * The lobby header. It replaced a bare "Sessions" label, and the point of the
 * replacement is the information: which app this is, who you are on this box,
 * and that the sessions you can see are only ever your own.
 */
describe("<Sidebar> — the lobby header", () => {
  it("titles the app rather than just labelling the list", async () => {
    const api = new FakeApi();
    const { container, store } = mount(api);
    await store.refresh();
    const h1 = container.querySelector("h1.tl-sidebar-title");
    expect(h1?.textContent).toBe("tmux sessions");
  });

  it("says who you are logged in as, and that sessions are yours alone", async () => {
    const api = new FakeApi();
    api.whoamiVal = { osUser: "wizard", authentik: "vbarzin@gmail.com" };
    const { container, store } = mount(api);
    await store.refresh();
    const sub = container.querySelector(".tl-sidebar-sub")?.textContent ?? "";
    expect(sub).toContain("wizard");
    expect(sub).toContain("vbarzin@gmail.com");
    expect(sub).toContain("kernel-isolated");
  });

  it("holds the explainer back until whoami answers, rather than guessing", () => {
    const { container } = mount(new FakeApi()); // never refreshed
    expect(container.querySelector(".tl-sidebar-sub")).toBeNull();
  });

  it("reloads the app from the ↻ button", async () => {
    let reloads = 0;
    const { getByLabelText, store } = mount(new FakeApi(), {
      onReload: () => void reloads++,
    });
    await store.refresh();
    fireEvent.click(getByLabelText("Reload the app"));
    expect(reloads).toBe(1);
  });

  it("carries the notification bell, and toggles it", async () => {
    let toggled = 0;
    const notifications = {
      bellMode: "toggle" as const,
      bellOn: () => false,
      bellTitle: () => "Notify me when Claude finishes or needs input",
      toggleBell: async () => void toggled++,
      showInstallHint: () => {},
    } as unknown as Parameters<typeof Sidebar>[0]["notifications"];
    const { getByLabelText, store } = mount(new FakeApi(), { notifications });
    await store.refresh();
    const bell = getByLabelText("Notifications");
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bell);
    expect(toggled).toBe(1);
  });

  it("shows no bell when notifications are unavailable on this device", async () => {
    const { queryByLabelText, store } = mount(new FakeApi());
    await store.refresh();
    expect(queryByLabelText("Notifications")).toBeNull();
  });
});
