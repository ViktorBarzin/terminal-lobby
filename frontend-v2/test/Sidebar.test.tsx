import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
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
  async killSession() {}
  async renameSession() {
    throw new ApiError(404, "no");
  }
  async restoreSessions() {}
  async listDirs() {
    return [];
  }
}

/** Render <Sidebar> with a freshly-built store; returns utils + the store. */
function mount(api: LobbyApi) {
  let store!: LobbyStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    return <Sidebar store={store} />;
  });
  return { ...utils, store: store! };
}

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
