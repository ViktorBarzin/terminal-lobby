/**
 * The phone's session list, T3 pass (Viktor, 2026-11-23; mocks compared with T3
 * Code's mobile home screen). On the phone layout only:
 *
 *   - a T3-style header: a "Sessions" title, a ⋯ menu that holds what the
 *     footer and the header icons used to, and a round compose button in place
 *     of the full-width New session bar;
 *   - a search box that matches titles, tmux names and projects;
 *   - two-line rows: the title, a line of what the session is doing, and one
 *     chip on the right;
 *   - the swipe's action drawn under the row while it trails, and an Undo
 *     toast after a close.
 *
 * The desktop sidebar is unchanged, and the last test here says so.
 */
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { FLIP_QUERY } from "../src/mobile/pointer";
import { toasts } from "../src/store/toast";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const now = () => Math.floor(Date.now() / 1000);

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: now() - 30,
  created: now() - 3600,
  owner: "wizard",
  origin: "user",
  ...over,
});

class FakeApi implements LobbyApi {
  async setSessionOrigin() {}
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
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
  kills: string[] = [];
  async killSession(name: string) {
    this.kills.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
  }
  async setSessionTitle() {
    throw new ApiError(404, "no");
  }
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
}

/** Report a phone: a coarse pointer on a 390px screen, which is what the flip
 *  query (mobile/pointer.ts) claims. */
const original = window.matchMedia;
function asPhone(): void {
  window.matchMedia = ((q: string) =>
    ({
      media: q,
      matches: q === FLIP_QUERY || q === "(pointer: coarse)",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

interface Hooks {
  onNewSession?: (group?: string) => void;
  onOpenSettings?: () => void;
  onOpenSkills?: () => void;
  onReload?: () => void;
}

function mount(api: LobbyApi, hooks: Hooks = {}) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} {...hooks} />;
  });
  onTestFinished(() => store.dispose());
  return { ...utils, store: store! };
}

/** Three sessions: one waiting on you in project "code", one working there,
 *  and an idle shell left ungrouped. */
function sampleApi(): FakeApi {
  const api = new FakeApi();
  api.sessionsVal = [
    sess("ask", { title: "Browser bridge sharing", state: "awaiting" }),
    sess("work", { title: "Double billing check", state: "running", lastPrompt: now() - 252 }),
    sess("sh", { title: "China trip plan", tool: "shell", lastPrompt: now() - 7200 }),
  ];
  api.layoutVal = {
    ...emptyLayout(),
    projects: [{ name: "code", sessions: ["ask", "work"] }],
    ungrouped: ["sh"],
  };
  return api;
}

async function loaded(container: HTMLElement, store: LobbyStore, count = 3) {
  await store.refresh();
  await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(count));
}

const card = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`.tl-card[data-name="${name}"]`)!;

function point(el: Element, type: string, x: number, y = 200): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );
}

beforeEach(() => toasts.clear());
afterEach(() => {
  window.matchMedia = original;
  toasts.clear();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the phone list's header", () => {
  it("is a Sessions title with a compose button, not the desktop header and bar", async () => {
    asPhone();
    const onNewSession = vi.fn();
    const { container, store, getByRole, queryByText } = mount(sampleApi(), { onNewSession });
    await loaded(container, store);

    expect(getByRole("heading", { name: "Sessions" })).toBeTruthy();
    expect(container.querySelector(".tl-new-row")).toBeNull();
    expect(queryByText("tmux sessions")).toBeNull();
    expect(container.querySelector(".tl-order-btn")).toBeNull();

    fireEvent.click(container.querySelector(".tl-phone-compose")!);
    expect(onNewSession).toHaveBeenCalledWith();
  });

  it("drops the footer row, whose buttons move into the ⋯ menu", async () => {
    asPhone();
    const onOpenSettings = vi.fn();
    const onOpenSkills = vi.fn();
    const onReload = vi.fn();
    const { container, store, getByRole, queryByRole } = mount(sampleApi(), {
      onOpenSettings,
      onOpenSkills,
      onReload,
    });
    await loaded(container, store);

    expect(container.querySelector(".tl-foot-btn")).toBeNull();
    expect(queryByRole("menu")).toBeNull();

    fireEvent.click(getByRole("button", { name: "More" }));
    const menu = getByRole("menu");
    const items = [...menu.querySelectorAll('[role^="menuitem"]')].map((b) =>
      b.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items).toEqual([
      "✓ Created newest first",
      "Last active newest first",
      "Manual drag to arrange",
      "New project",
      "Restore closed",
      "Skills",
      "Reload the app",
      "Settings",
    ]);

    fireEvent.click(getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(queryByRole("menu")).toBeNull();
  });

  it("opens the new-project box from the menu", async () => {
    asPhone();
    const { container, store, getByRole } = mount(sampleApi());
    await loaded(container, store);

    fireEvent.click(getByRole("button", { name: "More" }));
    fireEvent.click(getByRole("menuitem", { name: "New project" }));

    await waitFor(() =>
      expect(container.querySelector('input[placeholder="new project name…"]')).not.toBeNull(),
    );
  });
});

describe("the phone list's rows", () => {
  it("say what each session is doing on a second line, with one chip on the right", async () => {
    asPhone();
    const { container, store } = mount(sampleApi());
    await loaded(container, store);

    const ask = card(container, "ask");
    expect(ask.querySelector(".tl-card-sub")?.textContent).toBe("waiting for you");
    expect(ask.querySelector(".tl-card-chip")?.textContent).toBe("Needs you");
    expect(ask.querySelector(".tl-card-chip")?.getAttribute("data-kind")).toBe("need");

    const work = card(container, "work");
    expect(work.querySelector(".tl-card-sub")?.textContent).toBe("working");
    expect(work.querySelector(".tl-card-chip")?.textContent).toMatch(/^4:1\d$/);

    const sh = card(container, "sh");
    expect(sh.querySelector(".tl-card-sub")?.textContent).toBe("shell");
    expect(sh.querySelector(".tl-card-chip")?.textContent).toBe("2h");
    // The one-line row's time cell is not drawn beside the chip.
    expect(sh.querySelector(".tl-card-time")).toBeNull();
  });

  it("mark a T3 thread on the title line, beside the chip, not on a line of its own", async () => {
    asPhone();
    const api = sampleApi();
    api.sessionsVal = [
      ...api.sessionsVal,
      sess("t3_ab12", { title: "Energy switch", backend: "t3", lastPrompt: now() - 7200 }),
    ];
    api.layoutVal = { ...api.layoutVal, ungrouped: ["sh", "t3_ab12"] };
    const { container, store } = mount(api);
    await loaded(container, store, 4);

    const t3 = card(container, "t3_ab12");
    expect(t3.querySelector(".tl-card-sub")).toBeNull();
    const side = t3.querySelector(".tl-card-side");
    expect(side?.querySelector(".tl-card-side-t3 svg")).not.toBeNull();
    expect(side?.querySelector(".tl-card-chip")?.textContent).toBe("2h");
    // A row that is not T3 has no mark.
    expect(card(container, "sh").querySelector(".tl-card-side-t3")).toBeNull();
  });

  it("draw the swipe's action under the row while it trails", async () => {
    asPhone();
    const { container, store } = mount(sampleApi());
    await loaded(container, store);
    const sh = card(container, "sh");

    point(sh, "pointerdown", 100);
    point(sh, "pointermove", 140);
    point(sh, "pointermove", 180);
    await waitFor(() =>
      expect(sh.querySelector('.tl-swipe-act[data-act="close"]')?.textContent).toBe("Close"),
    );
    point(sh, "pointercancel", 180);
    await waitFor(() => expect(sh.querySelector(".tl-swipe-act")).toBeNull());

    point(sh, "pointerdown", 300);
    point(sh, "pointermove", 260);
    point(sh, "pointermove", 220);
    await waitFor(() =>
      expect(sh.querySelector('.tl-swipe-act[data-act="open"]')?.textContent).toBe("Open"),
    );
    point(sh, "pointercancel", 220);
  });

  it("offer Undo in a toast after a swipe closes a session", async () => {
    asPhone();
    const api = sampleApi();
    const { container, store } = mount(api);
    await loaded(container, store);
    const sh = card(container, "sh");

    point(sh, "pointerdown", 100);
    point(sh, "pointermove", 160);
    point(sh, "pointermove", 220);
    sh.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 220,
        clientY: 200,
        pointerType: "touch",
      }),
    );

    await waitFor(() => expect(store.killing("sh")).toBe(true));
    const toast = toasts.toasts().find((t) => t.action);
    expect(toast?.message).toBe("Closed “China trip plan”");
    expect(toast?.action?.label).toBe("Undo");

    toast!.action!.run();
    await waitFor(() => expect(store.killing("sh")).toBe(false));
    expect(api.kills).toEqual([]);
  });
});

describe("the phone list's search", () => {
  it("narrows the list to the sessions whose title, name or project matches", async () => {
    asPhone();
    const { container, store, getByRole, getByText } = mount(sampleApi());
    await loaded(container, store);

    fireEvent.input(getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "bill" },
    });

    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(1));
    expect(card(container, "work")).toBeTruthy();
    // No group headers over a flat list of results, so each row names its
    // project itself.
    expect(container.querySelector(".tl-group-header")).toBeNull();
    expect(card(container, "work").querySelector(".tl-card-sub")?.textContent).toBe(
      "code · working",
    );
    expect(getByText("1 session")).toBeTruthy();

    fireEvent.input(getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "code" },
    });
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(2));
    expect(getByText("2 sessions")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(3));
    expect(container.querySelector(".tl-group-header")).not.toBeNull();
  });

  it("says so when nothing matches", async () => {
    asPhone();
    const { container, store, getByRole, getByText } = mount(sampleApi());
    await loaded(container, store);

    fireEvent.input(getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "solar" },
    });
    await waitFor(() => expect(container.querySelectorAll(".tl-card").length).toBe(0));
    expect(getByText("No sessions match “solar”")).toBeTruthy();
  });
});

describe("the desktop sidebar", () => {
  it("keeps its header, New session bar, footer and one-line rows", async () => {
    const { container, store, getByText } = mount(sampleApi());
    await loaded(container, store);

    expect(getByText("tmux sessions")).toBeTruthy();
    expect(container.querySelector(".tl-new-row")).not.toBeNull();
    expect(container.querySelector(".tl-foot-btn")).not.toBeNull();
    expect(container.querySelector(".tl-phone-head")).toBeNull();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelector(".tl-card-sub")).toBeNull();
    expect(container.querySelector(".tl-card-chip")).toBeNull();
  });
});
