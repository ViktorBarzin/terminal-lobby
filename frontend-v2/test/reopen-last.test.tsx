/**
 * THE INSTALLED APP REOPENS ON THE LAST SESSION — through the real shell.
 *
 * Viktor, 2026-10-01: "every time I open it I go to the composer view
 * instead". A killed PWA cold-launches at start_url `/` with no session in its
 * URL, and nothing selected is the composer. pwa/last-session.ts holds the
 * decision; this file proves App.tsx wires it: the marker is read at boot, the
 * reopen waits for the session list, the composer never shows on the way, and
 * the marker follows what is on screen afterwards.
 *
 * Mocked scenery is the same as test/tile-kill.test.tsx: `SessionView` (a real
 * one boots xterm and a socket) and `lib/lobby-api`. The lobby store and the
 * shell are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { LobbyStore } from "../src/store/lobby";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { LAST_SESSION_KEY } from "../src/pwa/last-session";

type ViewProps = ComponentProps<typeof RealSessionView>;

const world = vi.hoisted(() => ({
  sessions: [] as { name: string; attached: number; created: number }[],
  /** Resolves the first /sessions call, so a test can look at the shell before
   *  the list has answered. */
  release: null as null | (() => void),
  store: null as LobbyStore | null,
}));

vi.mock("../src/lib/lobby-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/lobby-api")>();
  return {
    ...real,
    lobbyApi: {
      ...real.lobbyApi,
      whoami: async (): Promise<Whoami> => ({ authentik: "wizard", osUser: "wizard" }),
      listSessions: async (): Promise<Session[]> => {
        if (world.release === null) return world.sessions as Session[];
        await new Promise<void>((r) => {
          const prev = world.release;
          world.release = () => {
            world.release = null;
            prev?.();
            r();
          };
        });
        return world.sessions as Session[];
      },
      getLayout: async (): Promise<Layout> => emptyLayout(),
      putLayout: async (): Promise<void> => {},
    },
    getWorkspaces: async () => emptyWorkspaces(),
    putWorkspaces: async (): Promise<void> => {},
    availableCommands: async () => ({}),
    listUsers: async (): Promise<string[]> => [],
  };
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

import { App } from "../src/components/App";

const session = (name: string) => ({ name, attached: 0, created: 1_700_000_000 });

function installed(on: boolean): void {
  Object.defineProperty(navigator, "standalone", { configurable: true, value: on });
}

/** The session on screen: the one view not parked offstage by keepalive. */
const shown = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(".tl-session-slot:not(.tl-offstage) [data-session]")].map(
    (el) => el.dataset.session,
  );
const composer = (root: HTMLElement) => root.querySelector(".tl-new-view");

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
  }
  world.sessions = [session("issues"), session("trip-casia")];
  world.release = null;
  world.store = null;
  localStorage.clear();
  window.location.hash = "";
  installed(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "standalone");
  window.location.hash = "";
});

describe("reopening the installed app", () => {
  it("lands on the remembered session, with no composer on the way", async () => {
    localStorage.setItem(LAST_SESSION_KEY, "trip-casia");
    world.release = () => {};
    const { container } = render(() => <App />);
    const root = container as HTMLElement;
    // Before the list answers: neither the composer nor a guessed attach.
    await waitFor(() => expect(world.store).not.toBeNull());
    expect(composer(root)).toBeNull();
    expect(world.store?.selected()).toBeNull();
    world.release?.();
    await waitFor(() => expect(world.store?.selected()?.name).toBe("trip-casia"));
    await waitFor(() => expect(shown(root)).toEqual(["trip-casia"]));
    expect(window.location.hash).toBe("#trip-casia");
  });

  it("shows the composer when the remembered session was killed elsewhere", async () => {
    localStorage.setItem(LAST_SESSION_KEY, "gone");
    const { container } = render(() => <App />);
    const root = container as HTMLElement;
    await waitFor(() => expect(composer(root)).not.toBeNull());
    expect(world.store?.selected()).toBeNull();
  });

  it("leaves a browser tab on the composer", async () => {
    installed(false);
    localStorage.setItem(LAST_SESSION_KEY, "trip-casia");
    const { container } = render(() => <App />);
    const root = container as HTMLElement;
    await waitFor(() => expect(composer(root)).not.toBeNull());
    expect(world.store?.selected()).toBeNull();
  });

  it("lets a URL that names a session win", async () => {
    localStorage.setItem(LAST_SESSION_KEY, "trip-casia");
    window.location.hash = "#issues";
    render(() => <App />);
    await waitFor(() => expect(world.store?.selected()?.name).toBe("issues"));
    expect(localStorage.getItem(LAST_SESSION_KEY)).toBe("issues");
  });

  it("remembers the session you open and forgets it when you leave for the composer", async () => {
    render(() => <App />);
    await waitFor(() => expect(world.store?.loading()).toBe(false));
    world.store?.select("issues");
    expect(localStorage.getItem(LAST_SESSION_KEY)).toBe("issues");
    world.store?.deselect();
    expect(localStorage.getItem(LAST_SESSION_KEY)).toBeNull();
  });
});
