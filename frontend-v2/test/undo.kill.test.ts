/**
 * The kill's GRACE WINDOW, and the create that Cmd+Z turns into a kill.
 *
 * Killing used to ask `Kill session "x"?` from every entry point, and the
 * answer to a modal is either "yes" or a gesture nobody meant. The window
 * replaces it: the card stays in the sidebar, dimmed, nothing reaches tmux-api
 * for 8 seconds (GRACE_MS), and Cmd+Z inside that window is a full retraction
 * with no server call at either end. Past it the kill has landed, and undo has
 * to bring the session back from the record the kill left instead.
 *
 * So every case here is about WHEN, and the clock is fake
 * (vi.advanceTimersByTimeAsync, the way test/lobby.store.test.ts drives the
 * create burst). What the assertions watch is the fake api's `kills` — the
 * DELETE is the irreversible half, so "did anything reach the server yet" is
 * the question the window exists to answer.
 *
 * The store is the real one and so is the stack: these drive `store.kill`,
 * `store.create` and `stack.undo()` end to end, because the entry has to
 * describe what the action actually did. The handlers reach back into the store
 * through the ports registered in createLobbyStore (store/undo.kill.ts).
 */
import { describe, expect, it, afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { GRACE_MS, createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { createUndoStore, type UndoResult, type UndoStore } from "../src/store/undo";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import {
  emptyLayout,
  type Layout,
  type RestoreSelection,
  type Session,
  type Snapshot,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

/**
 * A tmux-api that SNAPSHOTS BEFORE IT KILLS, which is what makes a landed kill
 * undoable: the DELETE answers with the record to restore from, and POST
 * /restore recreates the session from it (types/lobby.ts RestoreSelection, the
 * body tmux-api/snapshots.go restoreFromSelection already takes).
 *
 * `snapshots: false` is the other server this client has to work with — the one
 * deployed today, which answers 204 with no body. A kill there still holds its
 * window, and undoing it past the window refuses rather than pretending.
 */
class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  /** Every DELETE that reached the server, in order. */
  kills: string[] = [];
  /** Every kill fired from `pagehide` (keepalive, no promise to await). */
  exits: string[] = [];
  restores: RestoreSelection[] = [];
  /** Does the DELETE answer with a record? */
  snapshots = true;
  /** Fail the next DELETE, as a 500 from tmux-api does. */
  killError = false;
  /** Answer the next DELETE with a 404, as tmux-api does for a name no session
   *  has — the state a session renamed behind a stale list leaves behind. */
  killMissing = false;
  /**
   * Hold the next DELETE open until this resolves, so a test can press undo
   * while the request is in flight.
   *
   * That gap is not hypothetical: the DELETE snapshots the whole box before it
   * kills (tmux-api/snapshots.go resurrectRecordFor), which tmux-persist's own
   * measurement puts at 345 ms idle and seconds under memory pressure.
   */
  killHold: Promise<void> | null = null;
  /** Fail the next restore. */
  restoreError = false;
  /**
   * Does the restore file the session back into its project itself?
   *
   * tmux-api does (assignments.go placeRestoredSessions, off the assignment it
   * remembered when the kill came through), and it says in its own comment
   * that the write is best-effort. Off by default here, so these cases run
   * against the server that restored the session and lost the placement, which
   * is the half the client has to cover.
   */
  placesRestored = false;
  /** Which group each killed session was in, so a placing restore can put it
   *  back the way the server would. */
  private killedFrom = new Map<string, string>();

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
  async killSession(name: string): Promise<RestoreSelection | null> {
    if (this.killHold) {
      const hold = this.killHold;
      this.killHold = null;
      await hold;
    }
    if (this.killError) {
      this.killError = false;
      throw new ApiError(500, "x");
    }
    if (this.killMissing) {
      this.killMissing = false;
      throw new ApiError(404, "session not found");
    }
    this.kills.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
    this.killedFrom.set(
      name,
      this.layoutVal.projects.find((p) => p.sessions.includes(name))?.name ?? "",
    );
    this.layoutVal = {
      ...this.layoutVal,
      ungrouped: this.layoutVal.ungrouped.filter((n) => n !== name),
      projects: this.layoutVal.projects.map((p) => ({
        ...p,
        sessions: p.sessions.filter((n) => n !== name),
      })),
    };
    if (!this.snapshots) return null;
    return { snapshot: "20260910-120000", sessions: [name] };
  }
  killSessionKeepalive(name: string) {
    this.exits.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
  }
  /** POST /restore: the session comes back, and its placement comes back too
   *  when this server manages it (see `placesRestored`). */
  async restoreSessions(sel?: RestoreSelection) {
    if (this.restoreError) {
      this.restoreError = false;
      throw new ApiError(500, "x");
    }
    if (!sel) return;
    this.restores.push(sel);
    for (const name of sel.sessions) {
      if (this.sessionsVal.some((s) => s.name === name)) continue;
      this.sessionsVal = [...this.sessionsVal, sess(name)];
      if (!this.placesRestored) continue;
      const group = this.killedFrom.get(name) ?? "";
      this.layoutVal =
        group === ""
          ? { ...this.layoutVal, ungrouped: [...this.layoutVal.ungrouped, name] }
          : {
              ...this.layoutVal,
              projects: this.layoutVal.projects.map((p) =>
                p.name === group ? { ...p, sessions: [...p.sessions, name] } : p,
              ),
            };
    }
  }
  async setSessionOrigin() {}
  async setSessionTitle(_name: string, _title: string) {}
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
  async listSnapshots() {
    return { snapshots: [] as Snapshot[], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot(_ts: string) {
    return [] as SnapshotRow[];
  }
}

interface Wired {
  store: LobbyStore;
  stack: UndoStore;
  api: FakeApi;
}

/** The store as App wires it, with this tab's stack behind it. */
async function wire(names: string[], api = new FakeApi()): Promise<Wired> {
  api.sessionsVal = names.map((n) => sess(n));
  api.layoutVal = { ...emptyLayout(), ungrouped: [...names] };
  const stack = createUndoStore({ storage: null });
  let store!: LobbyStore;
  const dispose = createRoot((d) => {
    const [order] = createSignal<"manual">("manual");
    store = createLobbyStore({
      api,
      autoStart: false,
      syncHash: false,
      sessionOrder: order,
      undo: stack,
    });
    return d;
  });
  onTestFinished(() => {
    store.dispose();
    dispose();
  });
  await store.refresh();
  return { store, stack, api };
}

/** The names the sidebar would draw, in order. */
const cards = (store: LobbyStore): string[] =>
  store.model().groups.flatMap((g) => g.sessions.map((s) => s.name));

const expectOk = async (r: Promise<UndoResult>): Promise<void> => {
  expect(await r).toEqual({ ok: true });
};

const expectRefusal = async (r: Promise<UndoResult>, why: RegExp): Promise<void> => {
  const out = await r;
  expect(out.ok).toBe(false);
  expect(out.ok === false ? out.reason : null).toMatch(why);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the kill grace window", () => {
  it("sends nothing to the server before the window is up", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(w.api.kills).toEqual([]);
    expect(w.api.puts).toEqual([]); // nor the layout PUT that follows it
    // The card stays where it was, dimmed. One that vanished would leave the
    // undo press with nothing on screen to point at.
    expect(cards(w.store)).toEqual(["alpha", "beta"]);
    expect(w.store.killing("alpha")).toBe(true);
    expect(w.store.killing("beta")).toBe(false);
  });

  it("kills once, when the window is up", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual(["alpha"]);
    expect(cards(w.store)).toEqual(["beta"]);
    expect(w.store.killing("alpha")).toBe(false);
    // The client PUTs the layout itself: a kill that 404s leaves the server's
    // entry behind, and the next poll would pull the card back.
    expect(w.api.puts.at(-1)!.ungrouped).toEqual(["beta"]);

    // And exactly once — the timer is gone with it.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
    expect(w.api.kills).toEqual(["alpha"]);
  });

  it("takes the whole kill back when undo lands one millisecond inside it", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);

    await expectOk(w.stack.undo());

    // Nothing ever reached the server, so nothing has to be put back.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
    expect(w.api.kills).toEqual([]);
    expect(w.api.puts).toEqual([]);
    expect(w.api.restores).toEqual([]);
    expect(cards(w.store)).toEqual(["alpha", "beta"]);
    expect(w.store.killing("alpha")).toBe(false);
  });

  it("gives the open session back when undo cancels its kill", async () => {
    const w = await wire(["alpha", "beta"]);
    w.store.select("alpha");
    await w.store.kill("alpha");
    // Deselected on the press, because the person asked for it to go: leaving
    // the terminal in front of them for 8 seconds reads as a kill that missed.
    expect(w.store.selected()).toBeNull();

    await expectOk(w.stack.undo());
    expect(w.store.selected()?.name).toBe("alpha");
  });

  it("leaves a session nobody had open deselected on undo", async () => {
    const w = await wire(["alpha", "beta"]);
    w.store.select("beta");
    await w.store.kill("alpha");

    await expectOk(w.stack.undo());
    expect(w.store.selected()?.name).toBe("beta");
  });

  it("holds two kills on separate clocks", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(3000);
    await w.store.kill("beta");

    await vi.advanceTimersByTimeAsync(GRACE_MS - 3000);
    expect(w.api.kills).toEqual(["alpha"]);
    expect(w.store.killing("beta")).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(w.api.kills).toEqual(["alpha", "beta"]);
  });

  it("ignores a second press on a session already on its way out", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await w.store.kill("alpha");

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual(["alpha"]);
    // One press, one entry: two would make the person press Cmd+Z twice to
    // take back one kill.
    await expectOk(w.stack.undo());
    expect(w.stack.canUndo()).toBe(false);
  });

  it("keeps the session, and toasts, when the DELETE fails", async () => {
    const w = await wire(["alpha"]);
    w.api.killError = true;
    await w.store.kill("alpha");

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual([]);
    expect(w.store.toast()).toBe("Couldn't kill session");
    expect(cards(w.store)).toEqual(["alpha"]);
    expect(w.store.killing("alpha")).toBe(false);
  });

  it("follows a rename that lands inside the window", async () => {
    // Eight seconds is long enough for a fresh session's first title to land,
    // and tmux-api renames the session when it does (ADR-0022). Without the
    // carry the timer would DELETE a name nothing answers to and the session
    // would survive its own kill.
    const w = await wire([]);
    w.api.sessionsVal = [sess("k7m2q9x4tp0v", { id: "$1" })];
    w.api.layoutVal = { ...emptyLayout(), ungrouped: ["k7m2q9x4tp0v"] };
    await w.store.refresh();
    await w.store.kill("k7m2q9x4tp0v");

    w.api.sessionsVal = [sess("fix-the-deploy", { id: "$1", title: "Fix the deploy" })];
    await w.store.refresh();
    expect(w.store.killing("fix-the-deploy")).toBe(true);

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual(["fix-the-deploy"]);
  });
});

describe("the kill that has to survive the page", () => {
  it("fires every pending kill on pagehide", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");
    await w.store.kill("beta");

    window.dispatchEvent(new Event("pagehide"));

    // keepalive, so the request outlives the document — an ordinary fetch is
    // cancelled with the page before it can settle.
    expect(w.api.exits).toEqual(["alpha", "beta"]);
    // And the timers are gone with them: the DELETE has already been sent.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(w.api.kills).toEqual([]);
  });

  it("sends nothing on pagehide when no kill is waiting", async () => {
    const w = await wire(["alpha"]);
    window.dispatchEvent(new Event("pagehide"));
    expect(w.api.exits).toEqual([]);
  });

  it("stops listening once the store is disposed", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    w.store.dispose();

    window.dispatchEvent(new Event("pagehide"));
    expect(w.api.exits).toEqual([]);
  });
});

describe("undoing a kill that has landed", () => {
  it("brings the session back from the record the kill left", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(cards(w.store)).toEqual(["beta"]);

    await expectOk(w.stack.undo());
    expect(w.api.restores).toEqual([{ snapshot: "20260910-120000", sessions: ["alpha"] }]);
    expect(cards(w.store)).toContain("alpha");
  });

  it("kills it again on redo, on a window of its own", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await expectOk(w.stack.undo());

    await expectOk(w.stack.redo());
    // The same eight seconds the first press bought, because Cmd+Shift+Z is as
    // easy to mean by accident as the kill was. What the redo does NOT do is
    // record an entry of its own (test/undo.resurrect.test.ts holds that half).
    expect(w.api.kills).toEqual(["alpha"]);
    expect(w.store.killing("alpha")).toBe(true);

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual(["alpha", "alpha"]);
    expect(cards(w.store)).toEqual([]);
  });

  it("refuses when the server kept no record to restore from", async () => {
    // The tmux-api deployed today: DELETE answers 204 with no body, so the
    // window is the whole of the undo and past it there is nothing to bring
    // back. Refusing says so instead of reporting a resurrection that did not
    // happen.
    const w = await wire(["alpha"]);
    w.api.snapshots = false;
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    await expectRefusal(w.stack.undo(), /bring that session back/);
    expect(w.api.restores).toEqual([]);
  });

  it("refuses when the restore does not go through", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    w.api.restoreError = true;

    await expectRefusal(w.stack.undo(), /could not be brought back/);
    expect(cards(w.store)).toEqual([]);
  });

  /**
   * The press that lands between the timer and the answer.
   *
   * `armKill`'s timer drops the pending record and calls `killNow`, which does
   * not prune the session from the list until the DELETE has answered — and
   * the DELETE waits on a whole-box `tmux-persist save` first. In that window
   * the session is neither pending nor gone, and reading it as "live" told the
   * user their session was still running, dropped the entry, and let the kill
   * land a moment later with nothing left to bring it back.
   */
  it("waits for a DELETE in flight rather than calling the session still running", async () => {
    const w = await wire(["alpha"]);
    let answer!: () => void;
    w.api.killHold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    // The window is over, the request is out, and nothing has answered yet.
    expect(w.store.killing("alpha")).toBe(false);
    expect(w.api.kills).toEqual([]);

    const pressed = w.stack.undo();
    answer();

    await expectOk(pressed);
    expect(w.api.restores).toEqual([{ snapshot: "20260910-120000", sessions: ["alpha"] }]);
    expect(cards(w.store)).toContain("alpha");
  });

  it("hands the session back rather than resurrecting it when that DELETE fails", async () => {
    // The kill did not go through, so the session never left: there is nothing
    // to restore, and the undo has only the selection to give back. Reporting
    // "nothing to bring it back from" would be a refusal for a session that is
    // sitting there.
    const w = await wire(["alpha"]);
    let answer!: () => void;
    w.api.killHold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    w.api.killError = true;
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    const pressed = w.stack.undo();
    answer();

    await expectOk(pressed);
    expect(w.api.restores).toEqual([]);
    expect(cards(w.store)).toContain("alpha");
  });

  it("refuses when the kill never went out and the session is still running", async () => {
    // What a tab that crashed mid-window comes back to: the entry survives in
    // sessionStorage, the timer does not, and the session is alive. There is
    // nothing to undo, and saying so is better than a silent no-op.
    const w = await wire(["alpha"]);
    w.stack.push({ kind: "kill", session: "alpha", group: "", index: 0 });

    await expectRefusal(w.stack.undo(), /still running/);
    expect(w.api.kills).toEqual([]);
  });
});

/**
 * The ↺ on the dimmed card, which is the phone's whole undo: no Cmd+Z on a
 * touch screen, and no confirm in front of the right swipe any more.
 *
 * It used to press the top of the stack, the same as the chord. Eight seconds
 * is long enough for anything else to land on top of it, and then the arrow on
 * one card undid something else — silently, since a working undo says nothing
 * — while the session it was drawn on went on dying.
 */
describe("taking one card's kill back", () => {
  it("undoes THIS kill, not whatever happened after it", async () => {
    const w = await wire(["alpha", "beta"]);
    await w.store.kill("alpha");
    // Two seconds into the window, somebody makes a project. That entry is now
    // the top of the stack.
    await vi.advanceTimersByTimeAsync(2000);
    await w.store.createProject("notes");

    await expectOk(w.store.takeBackKill("alpha"));

    expect(w.store.killing("alpha")).toBe(false);
    expect(w.store.layout().projects.map((p) => p.name)).toEqual(["notes"]);
    // ...and the window is gone with the entry, so nothing reaches the server
    // when the eight seconds would have been up.
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual([]);
    expect(cards(w.store)).toEqual(["alpha", "beta"]);
  });

  it("leaves the entries around it in place, in order", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await w.store.createProject("notes");

    await expectOk(w.store.takeBackKill("alpha"));
    // The next chord press reaches the project, which is what was left.
    await expectOk(w.stack.undo());
    expect(w.store.layout().projects).toEqual([]);
    // And nothing below it: the kill entry is off the undo stack, so a third
    // press has nothing to take.
    expect(await w.stack.undo()).toEqual({ ok: false, reason: null });
  });

  it("kills again on redo, since the arrow is an undo like any other", async () => {
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");

    await expectOk(w.store.takeBackKill("alpha"));
    await expectOk(w.stack.redo());

    expect(w.store.killing("alpha")).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(w.api.kills).toEqual(["alpha"]);
  });

  it("retracts the window in a tab that has no stack at all", async () => {
    // A lens tab (`?as=bob`) runs with undo off, and it is the one tab where
    // the session belongs to somebody else. Retracting a kill that has sent
    // nothing needs no history to do it.
    const api = new FakeApi();
    api.sessionsVal = [sess("alpha")];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["alpha"] };
    let store!: LobbyStore;
    const dispose = createRoot((d) => {
      const [order] = createSignal<"manual">("manual");
      store = createLobbyStore({ api, autoStart: false, syncHash: false, sessionOrder: order });
      return d;
    });
    onTestFinished(() => {
      store.dispose();
      dispose();
    });
    await store.refresh();
    await store.kill("alpha");

    await expectOk(store.takeBackKill("alpha"));

    expect(store.killing("alpha")).toBe(false);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(api.kills).toEqual([]);
  });

  it("says nothing and does nothing when that kill has already landed", async () => {
    // The arrow is only drawn while the card is dimmed, so this is the race
    // between a finger and the timer rather than an ordinary press.
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    // The entry is still on the stack and the chord can still resurrect it;
    // what the arrow must not do is take a different entry instead.
    await w.store.createProject("notes");

    expect(await w.store.takeBackKill("beta")).toEqual({ ok: false, reason: null });
    expect(w.store.layout().projects.map((p) => p.name)).toEqual(["notes"]);
  });
});

describe("undoing a create", () => {
  it("kills the session, and brings it back on redo", async () => {
    const w = await wire([]);
    const id = await w.store.create("Fix the deploy", "");
    // The create is the browser's own act — it PUTs the layout and the ttyd
    // attach is what makes the session — so the list has it from an optimistic
    // card, and the server hears about it for the first time on the DELETE.
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();

    await expectOk(w.stack.undo());
    // Straight away, with no window of its own: a create can be undone an hour
    // later, and a second eight-second wait would mean the press did nothing
    // visible and then something invisible.
    expect(w.api.kills).toEqual([id]);
    expect(cards(w.store)).toEqual([]);

    await expectOk(w.stack.redo());
    expect(w.api.restores).toEqual([{ snapshot: "20260910-120000", sessions: [id] }]);
    expect(cards(w.store)).toContain(id);
  });

  it("refuses when the DELETE it sends comes back 404", async () => {
    // The name has moved. tmux-api renames a session as soon as its first
    // title lands (ADR-0022) and the list is cached, so a create undone a few
    // seconds later can DELETE a name nothing answers to while the session
    // itself runs on under another one. Reporting that as a kill hid a live
    // session behind a card that came back on the next poll, and left the redo
    // with no record to restore from.
    const w = await wire([]);
    const id = await w.store.create("Fix the deploy", "");
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();
    w.api.killMissing = true;

    await expectRefusal(w.stack.undo(), /did not go through/);
    expect(w.api.kills).toEqual([]);
  });

  it("refuses when the DELETE it sends fails outright", async () => {
    // A 500 from tmux-api. The session is still there, so the undo has to say
    // it did not happen rather than dropping the card.
    const w = await wire([]);
    const id = await w.store.create("Fix the deploy", "");
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();
    w.api.killError = true;

    await expectRefusal(w.stack.undo(), /did not go through/);
    expect(cards(w.store)).toContain(id);
  });

  it("records nothing of its own while undoing", async () => {
    // The inverse reaches BELOW `kill`, at the plain write under it: going
    // through the action would push a kill entry and wipe the redo half the
    // press is about to fill.
    const w = await wire([]);
    const id = await w.store.create("Fix the deploy", "");
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();

    await expectOk(w.stack.undo());
    expect(w.stack.canUndo()).toBe(false);
    expect(w.stack.canRedo()).toBe(true);
    // No grace window either, so nothing lands on a later tick.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(w.api.kills).toEqual([id]);
  });

  it("puts the session back in the group it was created in", async () => {
    const w = await wire([]);
    w.api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }] };
    await w.store.refresh();
    const id = await w.store.create("Fix the deploy", "work");
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();

    await expectOk(w.stack.undo());
    await expectOk(w.stack.redo());
    // The document came back from a restore that did not file the session
    // anywhere, so the client's own gap-filler is what puts it in "work".
    const work = w.store.model().groups.find((g) => g.name === "work");
    expect(work?.sessions.map((s) => s.name)).toEqual([id]);
  });

  it("leaves the document alone when the server placed the session itself", async () => {
    // The rule the whole feature rests on: PUT /layout replaces the WHOLE
    // document with no version check, so an undo writes only when it has
    // something to add. A restore tmux-api placed has nothing left to fix.
    const w = await wire([]);
    w.api.placesRestored = true;
    w.api.layoutVal = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }] };
    await w.store.refresh();
    const id = await w.store.create("Fix the deploy", "work");
    w.api.sessionsVal = [sess(id)];
    await w.store.refresh();
    await expectOk(w.stack.undo());
    const putsAfterKill = w.api.puts.length;

    await expectOk(w.stack.redo());

    expect(w.api.puts.length).toBe(putsAfterKill);
    const work = w.store.model().groups.find((g) => g.name === "work");
    expect(work?.sessions.map((s) => s.name)).toEqual([id]);
  });

  it("refuses when the session is already gone", async () => {
    // Pushed by hand, because the store cannot get here on its own: an
    // optimistic card counts as live until a poll that KNOWS the session prunes
    // it (store/lobby.ts load), so a create's own session is always there to
    // kill. What this is about is the entry that outlived its session in
    // sessionStorage — a tab reloaded after somebody killed it elsewhere.
    const w = await wire(["alpha"]);
    w.stack.push({ kind: "create", session: "ghost", group: "" });

    await expectRefusal(w.stack.undo(), /already gone/);
    expect(w.api.kills).toEqual([]);
  });
});
