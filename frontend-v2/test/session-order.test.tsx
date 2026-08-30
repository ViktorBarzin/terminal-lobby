/**
 * Ordering the session list — the pref, the store, and the control (Viktor,
 * 2026-08-22).
 *
 * "Allow different ordering of sessions — support manual ordering as well as
 * sorting by created time and last active time. Default to created time."
 *
 * The arithmetic is in `order.logic.ts` and tested there. What is tested here
 * is the wiring: that the choice roams like every other setting, that the
 * sidebar and the keyboard both see the same order, that the picker is one tap
 * from the list rather than a trip through Settings, and that a drag while a
 * time ordering is active does something coherent instead of fighting the sort.
 */
import { describe, it, expect, afterEach, onTestFinished } from "vitest";
import { createRoot, createSignal, onCleanup } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import {
  createPrefsStore,
  coercePrefs,
  composeDoc,
  mergeAdopt,
  changedPrefPaths,
  PREF_DEFAULTS,
  type PrefsStore,
} from "../src/store/prefs";
import { flatSessionOrder } from "../src/keybindings/navigation.logic";
import type { SessionOrder } from "../src/components/order.logic";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  putError = false;
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
    if (this.putError) throw new ApiError(500, "nope");
    this.puts.push(l);
    this.layoutVal = l;
  }
  async killSession() {}
  async renameSession() {
    throw new ApiError(404, "no");
  }
  async retitleSession() {
    throw new ApiError(404, "no");
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
  async listDirs() {
    return [];
  }
}

// ---- the roamed pref -------------------------------------------------------

describe("sidebar.order — the roamed pref", () => {
  it("defaults to created time", () => {
    expect(PREF_DEFAULTS.sidebar.order).toBe("created");
  });

  /**
   * The one that decides the feature's reach. Every existing user has a stored
   * doc with no `sidebar.order` in it AND a layout full of hand-placed
   * sessions; Viktor asked for created time to be the default "including for
   * someone who already has a manual layout saved", so the absent key resolves
   * to `created`, not to the arrangement that happens to be sitting there.
   */
  it("defaults to created time for a doc that predates it, layout or no layout", () => {
    const legacy = {
      fontSize: 14,
      session: { newCommand: "claude", reopenLast: true },
      sidebar: { showLastActive: true },
    };
    expect(coercePrefs(legacy).sidebar.order).toBe("created");
  });

  it("takes any of the three stored orderings", () => {
    for (const order of ["manual", "created", "active"] as SessionOrder[]) {
      expect(coercePrefs({ sidebar: { order } }).sidebar.order).toBe(order);
    }
  });

  it("falls back to the default rather than trusting an unknown value", () => {
    for (const v of ["", "Created", "date", 1, true, null, {}, []]) {
      expect(coercePrefs({ sidebar: { order: v } }).sidebar.order).toBe("created");
    }
  });

  it("rides the whole-doc PUT beside the other sidebar keys", () => {
    const raw = { sidebar: { showLastActive: true, somethingElse: "kept" }, fontSize: 14 };
    const next = { ...PREF_DEFAULTS, sidebar: { showLastActive: true, order: "active" as const } };
    const doc = composeDoc(raw, next) as Record<string, any>;
    expect(doc.sidebar.order).toBe("active");
    expect(doc.sidebar.showLastActive).toBe(true);
    expect(doc.sidebar.somethingElse).toBe("kept");
  });

  it("survives the adoption merge, like every other sidebar subkey", () => {
    // A server doc written before this key existed must not reset a local
    // choice back to created on the next boot.
    const merged = mergeAdopt(
      { sidebar: { order: "manual" } },
      { sidebar: { showLastActive: true } },
    );
    expect(coercePrefs(merged).sidebar.order).toBe("manual");
    expect(coercePrefs(merged).sidebar.showLastActive).toBe(true);
  });

  it("reports the ordering someone picked, with the value they picked", () => {
    // telemetry/events.go: tl.key is the pref path, tl.to the NEW value. A
    // namespace name in either field answers nothing.
    const next = { ...PREF_DEFAULTS, sidebar: { ...PREF_DEFAULTS.sidebar, order: "active" as const } };
    expect(changedPrefPaths(PREF_DEFAULTS, next)).toEqual([["sidebar.order", "active"]]);
  });
});

// ---- the store applies it --------------------------------------------------

interface Wired {
  store: LobbyStore;
  api: FakeApi;
  order: () => SessionOrder;
}

/** A store wired to an ordering signal, as App wires it to the roamed pref. */
async function wire(
  layout: Layout,
  sessions: Session[],
  initial: SessionOrder = "created",
): Promise<Wired> {
  const api = new FakeApi();
  api.layoutVal = layout;
  api.sessionsVal = sessions;
  const [order, setOrder] = createSignal<SessionOrder>(initial);
  let store!: LobbyStore;
  const dispose = createRoot((d) => {
    store = createLobbyStore({
      api,
      autoStart: false,
      syncHash: false,
      sessionOrder: order,
      setSessionOrder: setOrder,
    });
    return d;
  });
  onTestFinished(() => {
    store.dispose();
    dispose();
  });
  await store.refresh();
  return { store, api, order };
}

/** What the sidebar would paint, group by group. */
const painted = (store: LobbyStore): Record<string, string[]> =>
  Object.fromEntries(
    store.model().groups.map((g) => [
      g.kind === "ungrouped" ? "" : g.name,
      g.sessions.map((s) => s.name),
    ]),
  );

const three = (): Session[] => [
  sess("alpha", { created: 100, lastDrive: 900 }),
  sess("beta", { created: 500, lastDrive: 100 }),
  sess("gamma", { created: 900, lastDrive: 500 }),
];
const rawOrder = (): Layout => ({
  ...emptyLayout(),
  ungrouped: ["alpha", "beta", "gamma"],
});

describe("the store paints the list in the chosen order", () => {
  it("puts the newest session at the top, whatever the layout says", async () => {
    const { store } = await wire(rawOrder(), three(), "created");
    expect(painted(store)[""]).toEqual(["gamma", "beta", "alpha"]);
  });

  it("orders by last active when asked, which is a different answer", async () => {
    const { store } = await wire(rawOrder(), three(), "active");
    expect(painted(store)[""]).toEqual(["alpha", "gamma", "beta"]);
  });

  it("gives the layout's own arrangement back under manual", async () => {
    const { store } = await wire(rawOrder(), three(), "manual");
    expect(painted(store)[""]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("sorts inside each group without moving the groups", async () => {
    const { store } = await wire(
      {
        ...emptyLayout(),
        projects: [{ name: "work", sessions: ["alpha", "gamma"] }],
        ungrouped: ["beta"],
        ungroupedIndex: 1,
      },
      three(),
      "created",
    );
    expect(store.model().groups.map((g) => (g.kind === "ungrouped" ? "" : g.name))).toEqual([
      "work",
      "",
    ]);
    expect(painted(store)).toEqual({ work: ["gamma", "alpha"], "": ["beta"] });
  });

  /**
   * Alt+1..0 and the next/prev-session chords walk `flatSessionOrder`, which
   * reads the same model. Sorting anywhere else — in the sidebar's own render,
   * say — would have left Alt+1 attaching a session other than the top card.
   */
  it("hands the keyboard the same order the eye sees", async () => {
    const { store } = await wire(rawOrder(), three(), "created");
    expect(flatSessionOrder(store.model()).map((s) => s.name)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("leaves the ordering alone when nothing wired one in", async () => {
    // The default that matters is the PREF's. A store built with no ordering
    // seam at all (every test that predates this, and any caller that has not
    // been taught) keeps the layout order it has always had.
    const api = new FakeApi();
    api.layoutVal = rawOrder();
    api.sessionsVal = three();
    let store!: LobbyStore;
    const dispose = createRoot((d) => {
      store = createLobbyStore({ api, autoStart: false, syncHash: false });
      return d;
    });
    onTestFinished(() => {
      store.dispose();
      dispose();
    });
    await store.refresh();
    expect(painted(store)[""]).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---- what a drag does while the list is sorted -----------------------------

describe("dragging a card while a time ordering is deciding positions", () => {
  /**
   * The drop wins and the list becomes manual.
   *
   * The alternative — honour the sort and refuse the position — means the card
   * springs back the instant the finger lifts, which reads as a broken drag.
   * So the visible order is written into the layout, the drop is applied on
   * top, and the list hands ordering back to the user. Nothing jumps: every
   * card that was not dragged keeps its seat, because the seat it had is now
   * what the layout says.
   */
  it("lands the card exactly where the indicator promised", async () => {
    const { store, api } = await wire(rawOrder(), three(), "created");
    // On screen: gamma, beta, alpha. Drag gamma below alpha, the bottom row.
    await store.move("gamma", "", { name: "alpha", side: "below" });
    expect(painted(store)[""]).toEqual(["beta", "alpha", "gamma"]);
    // Resolved against the RAW layout, this anchor would have landed gamma
    // second (alpha sits at index 0 of ["alpha","beta"]) — a card dropped at
    // the bottom of the list appearing in the middle of it.
    expect(api.puts.at(-1)!.ungrouped).toEqual(["beta", "alpha", "gamma"]);
  });

  it("switches the list to manual, and says so through the pref", async () => {
    const { store, order } = await wire(rawOrder(), three(), "created");
    await store.move("gamma", "", { name: "alpha", side: "below" });
    expect(order()).toBe("manual");
  });

  it("freezes every group, not just the one dragged in", async () => {
    // Ungrouped is where the drag happened; `work` is a bystander. If the
    // capture only covered the target, `work` would re-order itself the moment
    // the list went manual — cards moving that nobody touched.
    const { store, api } = await wire(
      {
        ...emptyLayout(),
        projects: [{ name: "work", sessions: ["alpha", "gamma"] }],
        ungrouped: ["beta", "delta"],
        ungroupedIndex: 1,
      },
      [...three(), sess("delta", { created: 700, lastDrive: 700 })],
      "created",
    );
    expect(painted(store)).toEqual({ work: ["gamma", "alpha"], "": ["delta", "beta"] });
    await store.move("beta", "", { name: "delta", side: "above" });
    expect(api.puts.at(-1)!.projects[0]!.sessions).toEqual(["gamma", "alpha"]);
    expect(painted(store)).toEqual({ work: ["gamma", "alpha"], "": ["beta", "delta"] });
  });

  /**
   * A move that names only a GROUP is not a position: "Move to work" from the
   * card menu, and a drop onto a group header, both leave the placement to the
   * layout. Under a time ordering the answer is already decided, so there is
   * nothing for the drop to fight and no reason to take the sort away.
   */
  it("keeps the ordering when a move names a group but no position", async () => {
    const { store, order } = await wire(
      { ...emptyLayout(), projects: [{ name: "work", sessions: [] }], ungrouped: ["alpha", "beta", "gamma"], ungroupedIndex: 1 },
      three(),
      "created",
    );
    await store.move("beta", "work");
    expect(order()).toBe("created");
    expect(painted(store)).toEqual({ work: ["beta"], "": ["gamma", "alpha"] });
  });

  it("leaves a manual list exactly as it always behaved", async () => {
    const { store, api, order } = await wire(rawOrder(), three(), "manual");
    await store.move("gamma", "", { name: "alpha", side: "below" });
    expect(order()).toBe("manual");
    expect(api.puts.at(-1)!.ungrouped).toEqual(["alpha", "gamma", "beta"]);
  });

  it("puts the ordering back when the layout write fails", async () => {
    // saveLayout rolls the layout back and toasts; the ordering it changed on
    // the way in has to come back with it, or the list is left in manual
    // showing an arrangement the server never accepted.
    const { store, api, order } = await wire(rawOrder(), three(), "created");
    api.putError = true;
    await store.move("gamma", "", { name: "alpha", side: "below" });
    expect(order()).toBe("created");
    expect(painted(store)[""]).toEqual(["gamma", "beta", "alpha"]);
  });
});

// ---- the control in the sidebar header -------------------------------------

async function mountSidebar(initial?: SessionOrder) {
  const api = new FakeApi();
  api.sessionsVal = three();
  api.layoutVal = rawOrder();
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    if (initial) prefs.setPref({ sidebar: { order: initial } });
    store = createLobbyStore({
      api,
      autoStart: false,
      syncHash: false,
      sessionOrder: () => prefs.prefs().sidebar.order,
      setSessionOrder: (order) => prefs.setPref({ sidebar: { order } }),
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} confirm={() => true} />;
  });
  onTestFinished(() => store.dispose());
  await store.refresh();
  await waitFor(() => expect(utils.container.querySelectorAll(".tl-card").length).toBe(3));
  return { ...utils, store: store!, prefs: prefs! };
}

const cardNames = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".tl-card")).map((c) => c.dataset.name ?? "");

const orderBtn = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(".tl-order-btn")!;

const orderItems = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-order-menu .tl-menu-item"));

afterEach(() => {
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe("the ordering picker", () => {
  it("sits in the sidebar header, one tap from the list", async () => {
    // Not in Settings: on a phone the list IS the screen, and re-ordering it is
    // something you do while looking at it.
    const { container } = await mountSidebar();
    const btn = orderBtn(container);
    expect(btn).not.toBeNull();
    expect(container.querySelector(".tl-sidebar-head-row")!.contains(btn)).toBe(true);
  });

  it("says which ordering is on without being opened", async () => {
    const { container } = await mountSidebar();
    expect(orderBtn(container).getAttribute("aria-label")).toMatch(/order sessions/i);
    expect(orderBtn(container).title).toMatch(/newest first/i);
  });

  it("offers the three orderings and ticks the one in force", async () => {
    const { container } = await mountSidebar();
    orderBtn(container).click();
    const items = orderItems(container);
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining("Created"),
      expect.stringContaining("Last active"),
      expect.stringContaining("Manual"),
    ]);
    expect(items.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  /** Newest-first is not obvious from the word "Created", so the menu says it. */
  it("spells out the direction both time orderings run in", async () => {
    const { container } = await mountSidebar();
    orderBtn(container).click();
    const [created, active] = orderItems(container);
    expect(created!.textContent).toMatch(/newest first/i);
    expect(active!.textContent).toMatch(/newest first/i);
  });

  it("re-orders the list and roams the choice when one is picked", async () => {
    const { container, prefs } = await mountSidebar();
    expect(cardNames(container)).toEqual(["gamma", "beta", "alpha"]);
    orderBtn(container).click();
    orderItems(container)[1]!.click(); // last active
    await waitFor(() => expect(cardNames(container)).toEqual(["alpha", "gamma", "beta"]));
    expect(prefs.prefs().sidebar.order).toBe("active");
    // and the menu closes behind the choice, as every other sidebar menu does
    expect(container.querySelector(".tl-order-menu")).toBeNull();
  });

  it("shows a manual list in the layout's own order", async () => {
    const { container } = await mountSidebar("manual");
    expect(cardNames(container)).toEqual(["alpha", "beta", "gamma"]);
  });
});
