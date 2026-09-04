import { describe, it, expect } from "vitest";
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";
import {
  PREF_DEFAULTS,
  applyPatch,
  changedPrefPaths,
  coercePrefs,
  composeDoc,
  mergeAdopt,
} from "../src/store/prefs";

/**
 * "How long ago was this session last active" is a per-USER setting, roamed
 * through /prefs like font size and the notify toggles, and OFF by default.
 *
 * Deliberately narrow: it hides the relative "5m ago" only. A running session
 * keeps its live working timer, which is progress on the turn in flight rather
 * than a timestamp, and is the one number you want while waiting.
 */

// ---- the pref itself -------------------------------------------------------

describe("sidebar.showLastActive — the roamed pref", () => {
  it("is off by default", () => {
    expect(PREF_DEFAULTS.sidebar.showLastActive).toBe(false);
  });

  it("defaults to off for a doc that predates it", () => {
    // Every existing user's stored doc is exactly this shape: it has never
    // carried a sidebar namespace, so they all start with the time hidden.
    const legacy = {
      fontSize: 14,
      session: { newCommand: "claude", reopenLast: true },
      notify: { onDone: true, onAwaiting: true },
      gestures: { haptics: true },
    };
    expect(coercePrefs(legacy).sidebar.showLastActive).toBe(false);
  });

  it("takes a stored true", () => {
    expect(coercePrefs({ sidebar: { showLastActive: true } }).sidebar.showLastActive).toBe(true);
  });

  it("refuses a non-boolean rather than guessing", () => {
    for (const v of ["true", 1, null, {}, []]) {
      expect(coercePrefs({ sidebar: { showLastActive: v } }).sidebar.showLastActive).toBe(false);
    }
  });

  it("round-trips through the whole-doc PUT without clobbering anything else", () => {
    const raw = {
      fontSize: 14,
      cursorStyle: "block",
      gestures: { haptics: true },
      links: { copyChip: true },
      sidebar: { somethingElse: "kept" },
      session: { reopenLast: true, newCommand: "claude" },
    };
    const next = {
      ...PREF_DEFAULTS,
      sidebar: { ...PREF_DEFAULTS.sidebar, showLastActive: true },
    };
    const doc = composeDoc(raw, next) as Record<string, any>;
    expect(doc.sidebar.showLastActive).toBe(true);
    // The vanilla page's keys survive, including an unknown subkey of the
    // namespace this pref introduces.
    expect(doc.sidebar.somethingElse).toBe("kept");
    expect(doc.cursorStyle).toBe("block");
    // gestures is PARTLY owned (the two desktop wheel keys, and the two the
    // native terminal's touch scroller reads), so the touch flag survives
    // beside them rather than being alone.
    expect(doc.gestures).toEqual({
      haptics: true,
      wheelSmooth: true,
      wheelSpeed: 1,
      scrollSpeedV2: 1,
      scrollMomentum: true,
    });
    expect(doc.links).toEqual({ copyChip: true });
    expect(doc.session.reopenLast).toBe(true);
  });

  it("survives the adoption merge one level deep, like session and notify", () => {
    // A server doc that never saw the subkey must not reset a local one.
    const merged = mergeAdopt(
      { sidebar: { showLastActive: true } },
      { sidebar: {} },
    ) as Record<string, any>;
    expect(merged.sidebar.showLastActive).toBe(true);
    // ...and the server wins where it does have an opinion.
    const merged2 = mergeAdopt(
      { sidebar: { showLastActive: true } },
      { sidebar: { showLastActive: false } },
    ) as Record<string, any>;
    expect(merged2.sidebar.showLastActive).toBe(false);
  });

  it("applies as a patch", () => {
    const next = applyPatch(PREF_DEFAULTS, { sidebar: { showLastActive: true } });
    expect(next.sidebar.showLastActive).toBe(true);
    // and leaves its neighbours alone
    expect(next.fontSize).toBe(PREF_DEFAULTS.fontSize);
    expect(next.notify).toEqual(PREF_DEFAULTS.notify);
  });

  it("reports its dotted path to telemetry with the NEW value", () => {
    // Spread the namespace rather than replacing it: `sidebar` carries the
    // list's ordering too, and dropping it here would report that as changed.
    const on = { ...PREF_DEFAULTS, sidebar: { ...PREF_DEFAULTS.sidebar, showLastActive: true } };
    expect(changedPrefPaths(PREF_DEFAULTS, on)).toEqual([
      ["sidebar.showLastActive", "true"],
    ]);
    expect(changedPrefPaths(on, PREF_DEFAULTS)).toEqual([
      ["sidebar.showLastActive", "false"],
    ]);
    expect(changedPrefPaths(PREF_DEFAULTS, PREF_DEFAULTS)).toEqual([]);
  });
});

// ---- what the card renders -------------------------------------------------

const sess = (over: Partial<Session> = {}): Session => ({
  name: "s1",
  attached: 0,
  // The card reads lastDrive (when a human last had hands on it); lastActivity
  // is tmux's raw number, which a read-only attach also bumps and which nothing
  // displays. Deliberately different values here, so this fixture would catch a
  // regression back to the wrong field.
  lastDrive: Math.floor(Date.now() / 1000) - 300, // driven 5m ago
  lastActivity: Math.floor(Date.now() / 1000) - 2, // "active" 2s ago (a watcher)
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
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
  async killSession() {}
  async renameSession() {
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
}

function card(session: Session, show: boolean | undefined) {
  const [tick] = createSignal(0);
  let store!: LobbyStore;
  const utils = render(() => {
    store = createLobbyStore({ api: new FakeApi(), autoStart: false, syncHash: false });
    return (
      <SessionCard
        store={store}
        session={session}
        groupName=""
        tick={tick}
        showLastActive={show === undefined ? undefined : () => show}
      />
    );
  });
  return utils;
}

const timeText = (root: Element): string =>
  (root.querySelector(".tl-card-time")?.textContent ?? "").trim();

describe("session card — the last-active time obeys the pref", () => {
  it("hides the relative time when the pref is off", () => {
    const { container, unmount } = card(sess(), false);
    expect(timeText(container)).toBe("");
    unmount();
  });

  it("shows it when the pref is on", () => {
    const { container, unmount } = card(sess(), true);
    expect(timeText(container)).toBe("5m ago");
    unmount();
  });

  // A call site that forgets to pass it hides the time. That is the safe
  // direction for a setting whose default is off.
  it("hides it when no pref is supplied at all", () => {
    const { container, unmount } = card(sess(), undefined);
    expect(timeText(container)).toBe("");
    unmount();
  });

  // The setting is about a TIMESTAMP. A running session's elapsed timer is
  // progress on the turn in flight, and stays either way.
  it("keeps the live working timer for a running session with the pref off", () => {
    const { container, unmount } = card(sess({ state: "running" }), false);
    expect(timeText(container)).not.toBe("");
    unmount();
  });

  it("renders no empty time element when there is nothing to say", () => {
    // An empty span would still take a flex gap in the row.
    const { container, unmount } = card(sess(), false);
    expect(container.querySelector(".tl-card-time")).toBeNull();
    unmount();
  });
});
