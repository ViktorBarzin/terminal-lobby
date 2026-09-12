/**
 * EVERY VISIBLE TILE COUNTS AS OPEN — through the real shell.
 *
 * The design's surface table says it in one line: "notifications | every
 * visible tile counts as open. Whatever suppression the open session gets today
 * — push, bell badge, unseen marker — applies to the whole visible set." The
 * shell asked a narrower question than that until 2026-09-12 — `selected: () =>
 * store.selected()?.name ?? null`, one session — so in a two-tile workspace
 * with `auth` focused and `deploy` beside it:
 *
 *   - `visits.observe` stamped `auth` alone, so `deploy` kept its unseen mark;
 *   - the app-icon badge counted `deploy` as work waiting for you, while its
 *     output was on screen in front of you;
 *   - the tab title's `(N✓)` counted it for the same reason;
 *   - `computeTransitions` fired an OS banner for a turn you watched finish.
 *
 * WHY THIS FILE MOUNTS `<App/>`. The visible set reaches the notification system
 * as one optional option, and an optional option that nobody passes typechecks
 * and does nothing — which is exactly how the previous attempt at this reported
 * itself fixed while every call site still read the selected session. A test
 * that hands `createNotificationSystem` a visible set is a test of an argument
 * it supplied itself. So the set here is the one the shell derives from its own
 * `visibleKeys`, and every assertion is made from outside: the icon badge the
 * browser was asked to draw, the string in `document.title`, and the banners
 * `notify/fire.ts` was asked to raise.
 *
 * THE TAP PATH IS DELIBERATELY UNTOUCHED, and is not asserted here. Tapping a
 * notification about a visible-but-unfocused tile still selects that session —
 * which focuses its tile — because a tap that decided it was "already" where it
 * wanted to be would leave the press doing nothing. Notification tap routing has
 * broken three times, most recently 2026-09-01; this change moves which sessions
 * count as OPEN and nothing about where a tap goes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createEffect, untrack, type ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { LobbyStore } from "../src/store/lobby";
import type { FaviconKind } from "../src/notify/favicon";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { NOTIFY_KEY } from "../src/notify/opt-in";
import { toRects, type Rect, type TreeNode } from "../src/store/workspace-tree";

type ViewProps = ComponentProps<typeof RealSessionView>;

const world = vi.hoisted(() => {
  // notifications.ts reads `typeof Notification` once, at import, and jsdom has
  // none — so the stub has to exist before the module graph loads. The same
  // trick test/notify.fire.wiring.test.ts uses, and for the same reason.
  (globalThis as { Notification?: unknown }).Notification = Object.assign(function () {}, {
    permission: "granted",
    requestPermission: () => Promise.resolve("granted"),
  });
  return {
    sessions: [] as { name: string; attached: number; created: number; state: string }[],
    doc: {
      version: 1,
      workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
    },
    /** The store the shell hands its Sidebar — this file's way to force a poll. */
    store: null as LobbyStore | null,
    /** Every banner the page asked for, by session. */
    fired: [] as string[],
    /** Every count the app icon was asked to draw. `null` is a clear. */
    badges: [] as (number | null)[],
  };
});

vi.mock("../src/lib/lobby-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/lobby-api")>();
  return {
    ...real,
    lobbyApi: {
      ...real.lobbyApi,
      whoami: async (): Promise<Whoami> => ({ authentik: "wizard", osUser: "wizard" }),
      listSessions: async (): Promise<Session[]> => world.sessions as Session[],
      getLayout: async (): Promise<Layout> => emptyLayout(),
      putLayout: async (): Promise<void> => {},
    },
    getWorkspaces: async () => ({ ...emptyWorkspaces(), ...world.doc }),
    putWorkspaces: async (): Promise<void> => {},
    availableCommands: async () => ({}),
    listUsers: async (): Promise<string[]> => [],
  };
});

vi.mock("../src/notify/fire", () => ({
  fireNotification: (session: string) => {
    world.fired.push(session);
    return Promise.resolve();
  },
}));

/** "no": the server does not push to this device, so the PAGE is the notifier
 *  and `computeTransitions` is the gate under test rather than a no-op. */
vi.mock("../src/pwa/push", () => ({
  PUSH_SUBS_API: "/api/sessions/push-subscriptions",
  VAPID_PUBLIC_API: "/api/sessions/push/vapid-public",
  PUSH_TEST_API: "/api/sessions/push/test",
  deviceSubscriptionState: () => Promise.resolve("no"),
  reportFocus: () => Promise.resolve(true),
  subscribePush: () => Promise.resolve(),
  unsubscribePush: () => Promise.resolve(),
  testAllDevices: () => Promise.resolve({ ok: true, sent: 0, pruned: 0 }),
}));

/** jsdom has no canvas, and the badged favicon draws on one. */
vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return { ...actual, createFaviconBadger: () => ({ apply: (_: FaviconKind) => {} }) };
});

vi.mock("../src/components/SessionView", () => ({
  SessionView: (props: ViewProps) => <div class="tl-session-view" data-session={props.session} />,
}));

vi.mock("../src/components/Sidebar", () => ({
  Sidebar: (props: { store: LobbyStore }) => {
    world.store = props.store;
    return <aside class="tl-sidebar" />;
  },
}));

vi.mock("../src/components/WorkspaceCanvas", () => ({
  WorkspaceCanvas: (props: {
    tree: TreeNode;
    container: { width: number; height: number };
    onRects: (rects: Rect[]) => void;
  }) => {
    createEffect(() => {
      const rects = toRects(props.tree, props.container);
      untrack(() => props.onRects(rects));
    });
    return <div class="tl-tiles" />;
  },
}));

import { App } from "../src/components/App";

/** 1440x900, less the 260px sidebar and the 37px shell bar. */
const SHELL = { width: 1180, height: 776 };

function installLayout(): void {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver as unknown as typeof ResizeObserver);
  const proto = HTMLElement.prototype;
  for (const [prop, value] of [
    ["clientWidth", SHELL.width],
    ["clientHeight", SHELL.height],
    ["offsetWidth", SHELL.width],
    ["offsetHeight", SHELL.height],
  ] as const) {
    Object.defineProperty(proto, prop, { configurable: true, get: () => value });
  }
  // SOMEBODY IS LOOKING AT THIS TAB, which is the state every suppression here
  // is about. jsdom answers `hasFocus()` false for a document nothing has
  // focused, and both gates read it: `away()` in notifications.ts and the visit
  // store's default `visible`. Left alone, the whole file would measure the
  // looked-AWAY case, where a banner for every session is the right answer and
  // the visible set decides nothing.
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  // The Badging API, which jsdom does not ship: the icon count this file reads.
  for (const [name, fn] of [
    ["setAppBadge", (n?: number) => void world.badges.push(n ?? 0)],
    ["clearAppBadge", () => void world.badges.push(null)],
  ] as const) {
    Object.defineProperty(navigator, name, {
      configurable: true,
      value: (n?: number) => {
        fn(n);
        return Promise.resolve();
      },
    });
  }
}

const running = (name: string) => ({
  name,
  attached: 1,
  created: 1_700_000_000,
  state: "running",
});

beforeEach(() => {
  installLayout();
  world.sessions = [];
  world.doc = { version: 1, workspaces: [] };
  world.store = null;
  world.fired = [];
  world.badges = [];
  localStorage.clear();
  localStorage.setItem(NOTIFY_KEY, "1"); // the bell is on for this browser
  window.location.hash = "";
  document.title = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const prop of ["clientWidth", "clientHeight", "offsetWidth", "offsetHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  for (const prop of ["setAppBadge", "clearAppBadge"]) {
    Reflect.deleteProperty(navigator, prop);
  }
  Reflect.deleteProperty(document, "hasFocus");
  window.location.hash = "";
});

interface Shell {
  root: HTMLElement;
  store: () => LobbyStore;
  /** The last count the app icon was asked for; 0 for a clear. */
  badge: () => number;
}

/** Boot the shell at `selected`, and wait for `tiles` laid-out tiles. */
async function openShell(selected: string, tiles: number): Promise<Shell> {
  window.location.hash = `#${selected}`;
  const { container } = render(() => <App />);
  const root = container as HTMLElement;
  await waitFor(() =>
    expect(root.querySelectorAll(".tl-session-slot.tl-tiled")).toHaveLength(tiles),
  );
  // The first poll is the transition seed and must not itself announce
  // anything — a reloaded tab re-declaring long-standing states is the bug
  // `prev === null` exists to stop.
  await waitFor(() => expect(world.badges.length).toBeGreaterThan(0));
  return {
    root,
    store: () => {
      if (!world.store) throw new Error("the shell never handed its store to a Sidebar");
      return world.store;
    },
    badge: () => world.badges[world.badges.length - 1] ?? 0,
  };
}

/**
 * Finish every session and let the poll that says so land.
 *
 * `store.refresh()` rather than waiting out the 5-second interval: it is the
 * same request on the same path, and this file asserts on what the poll's
 * answer does rather than on when it arrives.
 */
async function finishAll(shell: Shell): Promise<void> {
  world.sessions = world.sessions.map((s) => ({ ...s, state: "done" }));
  await shell.store().refresh();
  await waitFor(() => expect(world.badges.length).toBeGreaterThan(1));
}

describe("a two-tile workspace treats both tiles as read", () => {
  beforeEach(() => {
    // `auth` is focused, `deploy` is the second tile, `docs` is not on screen.
    world.sessions = [running("auth"), running("deploy"), running("docs")];
    world.doc = {
      version: 1,
      workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
    };
  });

  /**
   * THE ICON BADGE ANSWERS "HOW MANY NEED ME". A tile whose output is on screen
   * does not need you, whether or not it is the one taking keystrokes — so
   * three sessions finishing at once behind a two-tile workspace is a badge of
   * ONE, for the session nobody is looking at.
   *
   * `docs` carries this test: without it a badge of 0 would pass while the
   * whole counting path was dead.
   */
  it("counts only the session nobody can see", async () => {
    const shell = await openShell("auth", 2);
    await finishAll(shell);
    expect(shell.badge()).toBe(1);
  });

  /** The tab title's `(N✓)` is the same count with a different frame around
   *  it, off the same unseen predicate. */
  it("badges the tab title with the same one", async () => {
    const shell = await openShell("auth", 2);
    await finishAll(shell);
    await waitFor(() => expect(document.title).toContain("(1✓)"));
    expect(document.title).not.toContain("(2✓)");
  });

  /**
   * THE BANNER, which is the loudest of the three. A turn finishing in the tile
   * beside the one you are typing in is a turn you watched finish, and an OS
   * notification about it is the app telling you something you can see.
   */
  it("raises a banner for that session and for neither tile", async () => {
    const shell = await openShell("auth", 2);
    await finishAll(shell);
    await waitFor(() => expect(world.fired).toEqual(["docs"]));
  });
});

describe("a lone session behaves exactly as it did", () => {
  beforeEach(() => {
    // No workspace at all: `auth` is selected and alone on screen, `deploy` is
    // in the sidebar. This is the lobby as it worked last week, and what a
    // phone always gets.
    world.sessions = [running("auth"), running("deploy")];
    world.doc = { version: 1, workspaces: [] };
  });

  it("counts the session that is not on screen, and not the one that is", async () => {
    const shell = await openShell("auth", 0);
    await finishAll(shell);
    expect(shell.badge()).toBe(1);
    await waitFor(() => expect(document.title).toContain("(1✓)"));
  });

  it("raises a banner for the session that is not on screen", async () => {
    const shell = await openShell("auth", 0);
    await finishAll(shell);
    await waitFor(() => expect(world.fired).toEqual(["deploy"]));
  });
});
