/**
 * The sidebar's half of a Workspace: which cards are marked, at which of the
 * two levels, and where a click on one lands.
 *
 * TWO levels, because one cannot say both things at once. Every member of the
 * workspace on screen is marked, which is the only way the list can point at a
 * group whose members sit in different projects — they are not adjacent, so no
 * bracket can join them. The FOCUSED tile keeps the full active treatment it
 * has always had, because that card is the answer to "where are my keystrokes
 * going", and a terminal is a place where the answer matters. A single level
 * would have made the sidebar stop answering the second question the moment a
 * second tile appeared.
 *
 * THE PHONE HAS NEITHER. `(pointer: coarse) and ((max-width: 720px) or
 * (max-height: 480px))` shows one session at a time (ADR-0027), so a mark there
 * would point at a group the screen cannot draw, and a click that entered one
 * would hand the shell a tree with nowhere to render it. The gate is in
 * <Sidebar>, in TypeScript rather than in a `@media` rule, so the class is
 * never applied at all — see the block at the foot of this file.
 */
import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { onCleanup } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import type { SidebarWorkspaces } from "../src/components/SessionCard";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { keyOf, type Selected } from "../src/store/keepalive";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  // Somebody's own session. An unstamped one is a SYSTEM session and files
  // itself under System instead (components/lobby.logic.ts isSystemSession).
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
    this.layoutVal = l;
    this.puts.push(l);
  }
  async killSession() {}
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

/**
 * A stand-in for the shell's pair of stores, built from one map of keepalive
 * key → workspace id.
 *
 * The real `workspaceOf` is `store/workspaces.ts`'s derived reverse lookup and
 * the real `current` is whichever workspace the shell has on screen. Both are
 * plain questions with plain answers, so a Map says the same thing here without
 * dragging a tree, a `parseTree` and a localStorage document into a test about
 * what a card looks like.
 */
function fakeWorkspaces(
  members: Record<string, string>,
  current: string | null,
): SidebarWorkspaces & { opened: Array<[Selected, string | null]> } {
  const opened: Array<[Selected, string | null]> = [];
  return {
    opened,
    current: () => current,
    workspaceOf: (sel) => members[keyOf(sel)] ?? null,
    onOpen: (sel, workspace) => opened.push([sel, workspace]),
  };
}

async function mountSidebar(names: string[], workspaces?: SidebarWorkspaces, layout?: Layout) {
  const api = new FakeApi();
  api.sessionsVal = names.map((n) => sess(n));
  api.layoutVal = layout ?? { ...emptyLayout(), ungrouped: [...names] };
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} workspaces={workspaces} />;
  });
  onTestFinished(() => store.dispose());
  await store.refresh();
  await waitFor(() =>
    expect(utils.container.querySelectorAll(".tl-card").length).toBe(names.length),
  );
  return { ...utils, store: store!, api };
}

/** The row for one session, by the name it carries in the DOM. */
const card = (container: HTMLElement, name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`.tl-card[data-name="${name}"]`);
  expect(el, `a card for ${name}`).not.toBeNull();
  return el!;
};

const marked = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".tl-card-member")).map(
    (c) => c.dataset.name!,
  );

/**
 * A matchMedia that answers from a real viewport rather than from a substring
 * guess, copied in spirit from test/mobile-flip.test.tsx: the flip query is a
 * compound of three clauses, and a stub that only looked for "coarse" would
 * pass a test the browser would fail.
 */
type Viewport = { width: number; height: number; coarse: boolean };

function evaluate(q: string, vp: Viewport): boolean {
  if (q.includes("pointer: coarse") && !vp.coarse) return false;
  if (q === "(pointer: coarse)") return vp.coarse;
  const w = q.match(/max-width:\s*(\d+)px/);
  const h = q.match(/max-height:\s*(\d+)px/);
  return (w ? vp.width <= Number(w[1]) : false) || (h ? vp.height <= Number(h[1]) : false);
}

const realMatchMedia = window.matchMedia;

function stubViewport(vp: Viewport): void {
  window.matchMedia = ((q: string) =>
    ({
      media: q,
      get matches() {
        return evaluate(q, vp);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe("sidebar workspace marks — two levels", () => {
  it("marks every other member of the workspace on screen", async () => {
    const { container } = await mountSidebar(
      ["auth", "deploy", "docs", "alone"],
      fakeWorkspaces(
        {
          [keyOf({ name: "auth" })]: "w1",
          [keyOf({ name: "deploy" })]: "w1",
          [keyOf({ name: "docs" })]: "w1",
        },
        "w1",
      ),
    );

    expect(marked(container).sort()).toEqual(["auth", "deploy", "docs"]);
    expect(card(container, "alone").classList.contains("tl-card-member")).toBe(false);
  });

  it("gives the focused tile the full treatment and not the quieter one", async () => {
    // The two are mutually exclusive on the card, deliberately: the focused
    // tile is a member too, and a row carrying both marks would be asking the
    // stylesheet to decide which one wins on every theme.
    const { container, store } = await mountSidebar(
      ["auth", "deploy"],
      fakeWorkspaces({ [keyOf({ name: "auth" })]: "w1", [keyOf({ name: "deploy" })]: "w1" }, "w1"),
    );

    store.select("auth");
    await waitFor(() =>
      expect(card(container, "auth").classList.contains("tl-card-active")).toBe(true),
    );
    expect(card(container, "auth").classList.contains("tl-card-member")).toBe(false);
    expect(card(container, "deploy").classList.contains("tl-card-member")).toBe(true);
    expect(card(container, "deploy").classList.contains("tl-card-active")).toBe(false);
  });

  it("marks nothing for a workspace that is not the one on screen", async () => {
    // Membership is server-side and outlives the tab, so on any given screen
    // most workspaces are ones you are not in. Marking their members would say
    // "these are in front of you" about sessions that are not.
    const { container } = await mountSidebar(
      ["auth", "deploy", "logs", "notes"],
      fakeWorkspaces(
        {
          [keyOf({ name: "auth" })]: "w1",
          [keyOf({ name: "deploy" })]: "w1",
          [keyOf({ name: "logs" })]: "w2",
          [keyOf({ name: "notes" })]: "w2",
        },
        "w2",
      ),
    );

    expect(marked(container).sort()).toEqual(["logs", "notes"]);
  });

  it("marks nothing at all while a single session is on screen", async () => {
    const { container } = await mountSidebar(
      ["auth", "deploy"],
      fakeWorkspaces({ [keyOf({ name: "auth" })]: "w1", [keyOf({ name: "deploy" })]: "w1" }, null),
    );

    expect(marked(container)).toEqual([]);
  });

  it("marks nothing when the shell wires no workspaces at all", async () => {
    // What every suite that mounts a sidebar gets, and what the app itself gets
    // before the first split: no provider, no marks, no new behaviour.
    const { container } = await mountSidebar(["auth", "deploy"]);
    expect(marked(container)).toEqual([]);
  });

  it("follows the workspace the shell moves to, without a remount", async () => {
    // Entering another workspace is a signal change, not a new sidebar. The
    // marks are derived, so they have to move with it.
    const members = {
      [keyOf({ name: "auth" })]: "w1",
      [keyOf({ name: "logs" })]: "w2",
    };
    let current: string | null = "w1";
    const ws: SidebarWorkspaces = {
      current: () => current,
      workspaceOf: (sel) => members[keyOf(sel)] ?? null,
      onOpen: () => {},
    };
    const { container, store } = await mountSidebar(["auth", "logs"], ws);
    expect(marked(container)).toEqual(["auth"]);

    current = "w2";
    // Nudge the sidebar's own reactivity the way a real entry does: the shell
    // re-selects as it enters, and the cards re-derive from that.
    store.select("logs");
    await waitFor(() => expect(marked(container)).toEqual([]));
    store.select("auth");
    await waitFor(() => expect(marked(container)).toEqual(["logs"]));
  });
});

describe("sidebar workspace marks — clicking a card", () => {
  const membersOfTwo = {
    [keyOf({ name: "auth" })]: "w1",
    [keyOf({ name: "deploy" })]: "w1",
    [keyOf({ name: "logs" })]: "w2",
  };

  it("opens the whole workspace when the card belongs to one", async () => {
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container } = await mountSidebar(["auth", "deploy", "logs", "alone"], ws);

    card(container, "deploy").click();

    expect(ws.opened).toEqual([[{ name: "deploy", owner: undefined }, "w1"]]);
  });

  it("names the workspace of the card that was clicked, not the one on screen", async () => {
    // Clicking a member of ANOTHER workspace swaps you into it. The shell needs
    // the clicked card's id to do that, so the lookup is per card rather than a
    // yes/no about the workspace already open.
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container } = await mountSidebar(["auth", "deploy", "logs"], ws);

    card(container, "logs").click();

    expect(ws.opened).toEqual([[{ name: "logs", owner: undefined }, "w2"]]);
  });

  it("passes no workspace for a session that belongs to none", async () => {
    // The signal to LEAVE: the session shows alone, exactly as it did before
    // tiles existed.
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container } = await mountSidebar(["auth", "alone"], ws);

    card(container, "alone").click();

    expect(ws.opened).toEqual([[{ name: "alone", owner: undefined }, null]]);
  });

  it("still selects the session, so the shell knows which tile to focus", async () => {
    // Additive, not a replacement. `store.select` is what the session bar, the
    // URL and the keepalive list all follow, and the workspace callback says
    // only which group that session is being shown in.
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container, store } = await mountSidebar(["auth", "deploy"], ws);

    card(container, "deploy").click();

    await waitFor(() => expect(store.selected()?.name).toBe("deploy"));
    expect(ws.opened.length).toBe(1);
  });

  it("opens from the keyboard on the same terms as a click", async () => {
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container } = await mountSidebar(["auth", "deploy"], ws);

    card(container, "auth").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(ws.opened).toEqual([[{ name: "auth", owner: undefined }, "w1"]]);
  });

  it("says nothing about a row inside its kill window", async () => {
    // A dying row is not a way into anything: the press already took its
    // terminal off screen, and the only live control left is the undo arrow.
    const ws = fakeWorkspaces(membersOfTwo, "w1");
    const { container, store } = await mountSidebar(["auth", "deploy"], ws);

    void store.kill("deploy");
    await waitFor(() => expect(card(container, "deploy").hasAttribute("data-killing")).toBe(true));
    card(container, "deploy").click();

    expect(ws.opened).toEqual([]);
  });

  it("does not crash a sidebar mounted with no workspaces wired", async () => {
    const { container, store } = await mountSidebar(["auth"]);
    card(container, "auth").click();
    await waitFor(() => expect(store.selected()?.name).toBe("auth"));
  });
});

describe("sidebar workspace marks — the phone has none", () => {
  const phone: Viewport = { width: 390, height: 844, coarse: true };
  const desktop: Viewport = { width: 1920, height: 1080, coarse: false };
  const members = {
    [keyOf({ name: "auth" })]: "w1",
    [keyOf({ name: "deploy" })]: "w1",
  };

  it("marks no card on a phone, even with a workspace on screen", async () => {
    stubViewport(phone);
    const { container } = await mountSidebar(["auth", "deploy"], fakeWorkspaces(members, "w1"));

    expect(marked(container)).toEqual([]);
  });

  it("opens the clicked session alone there, saying nothing about a workspace", async () => {
    stubViewport(phone);
    const ws = fakeWorkspaces(members, "w1");
    const { container, store } = await mountSidebar(["auth", "deploy"], ws);

    card(container, "deploy").click();

    // Exactly the pre-workspace behaviour: the session is selected and nothing
    // is asked of the shell's tree.
    await waitFor(() => expect(store.selected()?.name).toBe("deploy"));
    expect(ws.opened).toEqual([]);
  });

  it("keeps both on a tablet, which renders the split view", async () => {
    // A finger is a finger at 768px, but the flip query deliberately does not
    // claim a tablet: it was measured healthy with both panes, so it gets
    // workspaces like any other wide screen.
    stubViewport({ width: 768, height: 1024, coarse: true });
    const ws = fakeWorkspaces(members, "w1");
    const { container } = await mountSidebar(["auth", "deploy"], ws);

    expect(marked(container).sort()).toEqual(["auth", "deploy"]);
    card(container, "auth").click();
    expect(ws.opened).toEqual([[{ name: "auth", owner: undefined }, "w1"]]);
  });

  it("keeps both on a desktop window someone shrank", async () => {
    stubViewport({ width: 600, height: 800, coarse: false });
    const { container } = await mountSidebar(["auth", "deploy"], fakeWorkspaces(members, "w1"));
    expect(marked(container).sort()).toEqual(["auth", "deploy"]);
  });

  it("keeps both on a full desktop", async () => {
    stubViewport(desktop);
    const { container } = await mountSidebar(["auth", "deploy"], fakeWorkspaces(members, "w1"));
    expect(marked(container).sort()).toEqual(["auth", "deploy"]);
  });
});

/**
 * The quieter level, in the stylesheet.
 *
 * Asserted against the CSS text for the same reason test/mobile-flip.test.tsx
 * reads it: jsdom applies no stylesheet, so a DOM test can say which class is
 * on a row and nothing at all about whether the two levels look different. What
 * is worth pinning is the DERIVATION — the quiet mark is the active one stepped
 * down, sharing its geometry and its accent, so there is one visual language in
 * the list rather than two.
 */
describe("the quieter mark is the active one, stepped down", () => {
  const CSS_PATH = resolve(process.cwd(), "src/sidebar.css");
  const rule = (selector: string): string => {
    const css = readFileSync(CSS_PATH, "utf8");
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} in sidebar.css`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("draws the same 2px bar in the same place as the active row", async () => {
    const quiet = rule(".tl-card-member::before");
    const full = rule(".tl-card-active::before");
    for (const decl of ["width: 2px", "border-radius: 2px", "top: 6px", "bottom: 6px"]) {
      expect(quiet, decl).toContain(decl);
      expect(full, decl).toContain(decl);
    }
  });

  it("mixes the accent down rather than picking another colour", async () => {
    // The full bar is the accent flat; the quiet one is the same accent with
    // some of it taken away. A different hue would read as a different KIND of
    // state, which is what the two levels exist to avoid saying.
    expect(rule(".tl-card-active::before")).toMatch(/background:\s*var\(--accent\)/);
    const quiet = rule(".tl-card-member::before");
    const mix = quiet.match(/color-mix\(in srgb,\s*var\(--accent\)\s*(\d+)%/);
    expect(mix, "a color-mix off --accent").not.toBeNull();
    expect(Number(mix![1])).toBeLessThan(100);
  });

  it("leaves the heavier name to the focused row alone", async () => {
    // Weight is the third carrier of the active treatment, and it is the one
    // the quiet level gives up: 700 on the focused card, the list's resting 600
    // on its siblings. Without this both levels would end up at 700 and the
    // sidebar would stop saying where the keystrokes go.
    const css = readFileSync(CSS_PATH, "utf8");
    expect(css).toContain(".tl-card-active .tl-card-name");
    expect(css).not.toContain(".tl-card-member .tl-card-name");
  });

  it("is ordered so the focused and unseen bars still win", async () => {
    // Both are stronger claims than membership — where the keystrokes go, and
    // what finished while you were away — and both are drawn on the same
    // ::before. Source order is what settles it, as it already does between
    // .tl-card-active and .tl-card-unseen.
    const css = readFileSync(CSS_PATH, "utf8");
    expect(css.indexOf(".tl-card-member::before")).toBeLessThan(
      css.indexOf(".tl-card-active::before"),
    );
    expect(css.indexOf(".tl-card-member::before")).toBeLessThan(
      css.indexOf(".tl-card-unseen::before"),
    );
  });
});

/**
 * The drag that puts a session into a tile in the first place.
 *
 * dnd/sidebar.ts decides what may be lifted by reading the row's classes
 * (`.tl-card` and not `.tl-card-foreign`), so a new class on the row is exactly
 * the kind of change that can stop a list being draggable without any test
 * noticing. This drags a MARKED card and asserts the layout the store was left
 * holding, which is the same thing test/dnd.drag.test.tsx asserts — the helpers
 * below are its, narrowed to one list.
 */
describe("a marked card still drags", () => {
  const rect = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON() {},
    }) as DOMRect;

  /** Rows 40px tall in the order they are rendered RIGHT NOW: a drag reorders
   *  the list as it goes, so the seat has to be measured live. */
  function layOut(container: HTMLElement): HTMLElement[] {
    const live = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(".tl-card")).filter(
        (c) => c.id !== "dnd-dragged-node-clone",
      );
    const seat = (el: HTMLElement): number => Math.max(0, live().indexOf(el));
    for (const c of live()) c.getBoundingClientRect = () => rect(100 + seat(c) * 40, 40);
    for (const body of container.querySelectorAll<HTMLElement>(".tl-group-body")) {
      body.getBoundingClientRect = () => {
        const own = Array.from(body.querySelectorAll<HTMLElement>(".tl-card"));
        return rect(100 + (own[0] ? seat(own[0]) : 0) * 40, Math.max(own.length, 1) * 40);
      };
    }
    document.elementFromPoint = (_x: number, y: number) =>
      live().find((c) => {
        const r = c.getBoundingClientRect();
        return y >= r.top && y < r.bottom;
      }) ?? null;
    return live();
  }

  const point = (el: Element, type: string, y: number) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: y,
        pointerType: "touch",
      }),
    );

  /** The hold is 450ms; wait past it with real time, since fake timers and
   *  Solid's scheduling do not mix well enough to be worth it. */
  const held = () => new Promise((r) => setTimeout(r, 600));
  const settled = () => new Promise((r) => setTimeout(r, 60));

  it("reorders the list from a finger, with the mark on the row", async () => {
    const names = ["auth", "deploy", "docs"];
    const ws = fakeWorkspaces(
      Object.fromEntries(names.map((n) => [keyOf({ name: n }), "w1"])),
      "w1",
    );
    const { container, store, api } = await mountSidebar(names, ws);
    expect(marked(container).sort()).toEqual(["auth", "deploy", "docs"]);
    const cards = layOut(container);

    point(cards[0]!, "pointerdown", 120);
    await held();
    for (const y of [125, 165]) {
      point(document.elementFromPoint(150, y) ?? document.body, "pointermove", y);
      await settled();
    }
    point(document.elementFromPoint(150, 165) ?? document.body, "pointerup", 165);
    await settled();

    expect(store.layout().ungrouped).toEqual(["deploy", "auth", "docs"]);
    expect(api.puts.length).toBe(1);
    // A drag is not a click: the row was carried, not opened, so the shell was
    // never asked to enter anything.
    expect(ws.opened).toEqual([]);
  });
});
