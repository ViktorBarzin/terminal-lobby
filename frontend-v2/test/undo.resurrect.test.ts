/**
 * The SECOND TIER of undoing a kill: the eight seconds are up, the DELETE has
 * landed, and Cmd+Z has to bring a dead session back rather than call a timer
 * off. Tier one — the window itself — is test/undo.kill.test.ts.
 *
 * What comes back is the point of this file. The undo POSTs /restore with the
 * record the DELETE answered with, verbatim (tmux-api snapshots before it kills
 * and hands back exactly POST /restore's body), and tmux-persist recreates one
 * window with one pane in the old cwd running `claude --resume <uuid>`. The
 * conversation comes back; the process tree, the scrollback and anything typed
 * and not sent do not (store/undo.kill.ts says it in full). So these cases
 * watch what reaches the server and what lands on screen, and they are strict
 * about the two refusals: an undo that quietly did nothing is the failure this
 * whole tier exists to avoid.
 *
 * The restore is also SLOW. It shells out, and a cold claude start runs on a
 * 30-second deadline of its own (lib/lobby-api.ts RESTORE_TIMEOUT_MS), so this
 * is the one press on the stack that says something while it works. The last
 * three cases hold the restore open and watch the loading toast come and go.
 *
 * The store is the real one and so is the stack, as in test/undo.kill.test.ts,
 * and the clock is fake. What is faked is tmux-api.
 */
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { GRACE_MS, createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { toasts } from "../src/store/toast";
import { createUndoStore, type UndoResult, type UndoStore } from "../src/store/undo";
import {
  emptyLayout,
  type Layout,
  type RestoreSelection,
  type Session,
  type Snapshot,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

/** The snapshot tmux-persist would have written, in its own timestamp format
 *  (`sudo tmux-restore-user wizard list` prints `20260910T220501`). */
const SNAP = "20260910T220501";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

/**
 * A tmux-api that snapshots before it kills, and whose restore can be HELD
 * OPEN.
 *
 * Holding it is what makes the slow path testable: the real one takes seconds
 * (tmux-persist spawns the session and claude reads its transcript back), and
 * the toast under test is the only thing on screen for that whole time.
 */
class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  /** Every DELETE that reached the server, in order. */
  kills: string[] = [];
  /** Every POST /restore body, exactly as it was sent. */
  restores: RestoreSelection[] = [];
  /** Does the DELETE answer with a record? false is the server deployed before
   *  the snapshot-first kill, which answers 204 with no body. */
  snapshots = true;
  /** Fail the next restore, as a 500 from tmux-api does. */
  restoreError = false;
  /** While true, a restore parks until `letRestoreFinish` is called. */
  holdRestore = false;
  private release: (() => void) | null = null;

  /** Let a held restore run to its end. */
  letRestoreFinish(): void {
    const go = this.release;
    this.release = null;
    go?.();
  }

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
  async killSession(name: string): Promise<RestoreSelection | null> {
    this.kills.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
    this.layoutVal = {
      ...this.layoutVal,
      ungrouped: this.layoutVal.ungrouped.filter((n) => n !== name),
      projects: this.layoutVal.projects.map((p) => ({
        ...p,
        sessions: p.sessions.filter((n) => n !== name),
      })),
    };
    return this.snapshots ? { snapshot: SNAP, sessions: [name] } : null;
  }
  killSessionKeepalive(name: string) {
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
  }
  async restoreSessions(sel?: RestoreSelection) {
    if (this.holdRestore) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.restoreError) {
      this.restoreError = false;
      throw new ApiError(500, "x");
    }
    if (!sel) return;
    this.restores.push(sel);
    // Under the SAME name (tmux-persist:672-676). tmux's own session_id would
    // be a fresh one, which is why nothing keys off it.
    for (const name of sel.sessions) {
      if (this.sessionsVal.some((s) => s.name === name)) continue;
      this.sessionsVal = [...this.sessionsVal, sess(name)];
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

/** Kill it and let the window elapse, which is where every case here starts. */
async function killAndLand(w: Wired, name: string): Promise<void> {
  await w.store.kill(name);
  await vi.advanceTimersByTimeAsync(GRACE_MS);
}

const expectOk = async (r: Promise<UndoResult>): Promise<void> => {
  expect(await r).toEqual({ ok: true });
};

const expectRefusal = async (r: Promise<UndoResult>, why: RegExp): Promise<void> => {
  const out = await r;
  expect(out.ok).toBe(false);
  expect(out.ok === false ? out.reason : null).toMatch(why);
};

/** Let a promise chain already in flight run up to its next real wait. The
 *  restore is held open, so `await`ing the press itself would deadlock. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const loadingToasts = (): string[] =>
  toasts
    .toasts()
    .filter((t) => t.kind === "loading")
    .map((t) => t.message);

beforeEach(() => {
  vi.useFakeTimers();
  toasts.clear();
});

afterEach(() => {
  vi.useRealTimers();
  toasts.clear();
});

describe("undoing a kill the server already took", () => {
  it("posts the record back exactly as the DELETE handed it over", async () => {
    const w = await wire(["alpha", "beta"]);
    await killAndLand(w, "alpha");
    expect(w.api.kills).toEqual(["alpha"]);
    expect(cards(w.store)).toEqual(["beta"]);

    await expectOk(w.stack.undo());

    // Verbatim, with no translation on the way: the inner half of the kill's
    // answer IS this body (tmux-api/snapshots.go restoreFromSelection), which
    // is the whole reason the server sends that shape.
    expect(w.api.restores).toEqual([{ snapshot: SNAP, sessions: ["alpha"] }]);
    // In its old seat, not appended: this restore filed the session nowhere, so
    // the entry's own slot is what the client fills in (store/lobby.ts
    // placeSession, which writes only when the document came back without it).
    expect(cards(w.store)).toEqual(["alpha", "beta"]);
  });

  it("hands the session back to the person who had it open", async () => {
    const w = await wire(["alpha", "beta"]);
    w.store.select("alpha");
    await killAndLand(w, "alpha");
    // Deselected on the press, eight seconds before this restore.
    expect(w.store.selected()).toBeNull();

    await expectOk(w.stack.undo());

    expect(w.store.selected()?.name).toBe("alpha");
  });

  it("leaves the selection alone when the killed session was not the open one", async () => {
    const w = await wire(["alpha", "beta"]);
    w.store.select("beta");
    await killAndLand(w, "alpha");

    await expectOk(w.stack.undo());

    // A resurrection is not a reason to move somebody off what they are
    // reading. The entry records which it was, so this needs no guessing.
    expect(w.store.selected()?.name).toBe("beta");
  });

  it("refuses when the kill left no record to bring the session back from", async () => {
    // Two ways to get here: a tmux-api that predates the snapshot-first kill
    // (204, no body), and one whose pre-kill snapshot failed, which it answers
    // as `{}` rather than failing a kill that has already happened
    // (tmux-api/session_mutate.go resurrectRecordFor). Both read as no record.
    const w = await wire(["alpha"]);
    w.api.snapshots = false;
    await killAndLand(w, "alpha");

    await expectRefusal(w.stack.undo(), /nothing left to bring that session back/);
    expect(w.api.restores).toEqual([]);
  });

  it("refuses when the session is somehow running again", async () => {
    // Somebody else restored it — another tab, another device, the restore
    // picker. The record is still here and would post fine, and posting it
    // would restore a second copy of the conversation over a session that is
    // already back.
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    w.api.sessionsVal = [sess("alpha")];
    await w.store.refresh();

    await expectRefusal(w.stack.undo(), /still running/);
    expect(w.api.restores).toEqual([]);
  });

  it("refuses when the restore does not go through, and says so in words", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    w.api.restoreError = true;

    await expectRefusal(w.stack.undo(), /could not be brought back/);
    expect(cards(w.store)).toEqual([]);
  });
});

describe("redoing a kill that undo brought back", () => {
  it("gives the second kill its own eight seconds", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    await expectOk(w.stack.undo());

    await expectOk(w.stack.redo());

    // Through the ordinary grace path, not straight to the server: the redo is
    // as easy to press by accident as the kill was, and the window is what
    // replaced the confirm in front of both.
    expect(w.api.kills).toEqual(["alpha"]);
    expect(w.store.killing("alpha")).toBe(true);
    expect(cards(w.store)).toEqual(["alpha"]);

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(w.api.kills).toEqual(["alpha"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.api.kills).toEqual(["alpha", "alpha"]);
    expect(cards(w.store)).toEqual([]);
  });

  it("takes the redo back with no server call when undo lands inside that window", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    await expectOk(w.stack.undo());
    await expectOk(w.stack.redo());

    await expectOk(w.stack.undo());

    // The entry the redo put back on the undo stack is what cancels the timer,
    // so this costs nothing at either end: no second DELETE, and no second
    // restore either, because the session never left.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(w.api.kills).toEqual(["alpha"]);
    expect(w.api.restores).toHaveLength(1);
    expect(w.store.killing("alpha")).toBe(false);
    expect(cards(w.store)).toEqual(["alpha"]);
  });

  it("records nothing of its own, so the stack stays one press deep", async () => {
    // The window it opens reaches BELOW `store.kill` (store/lobby.ts armKill).
    // Going through the action would push a second kill entry and clear the
    // redo stack this press is walking down.
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    await expectOk(w.stack.undo());
    await expectOk(w.stack.redo());

    expect(w.stack.canRedo()).toBe(false);
    expect(w.stack.canUndo()).toBe(true);
    await expectOk(w.stack.undo());
    expect(w.stack.canUndo()).toBe(false);
  });

  it("refuses to redo a kill of a session that has gone on its own", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    await expectOk(w.stack.undo());
    w.api.sessionsVal = [];
    await w.store.refresh();

    // The sentence a person gets here is the undo-flavoured one, and that is a
    // known cost of the contract rather than an accident: `check` runs before
    // BOTH directions (store/undo.ts UndoHandler) and this world — dead, with
    // its record already spent by the undo — reads the same whichever way the
    // press was going, so one sentence has to serve both. What matters is that
    // it refuses: nothing is killed twice and nothing is invented.
    await expectRefusal(w.stack.redo(), /nothing left to bring that session back/);
    expect(w.api.kills).toEqual(["alpha"]);
  });
});

describe("the one undo that speaks while it works", () => {
  it("holds a loading toast for as long as the restore is out", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    w.api.holdRestore = true;

    const press = w.stack.undo();
    await settle();
    // Named, because the tab may have several dimmed cards and the person
    // pressing Cmd+Z is owed which one this is about.
    expect(loadingToasts()).toEqual(["Bringing alpha back…"]);

    w.api.letRestoreFinish();
    await expectOk(press);

    // Gone the moment the session is back on screen, since `settleRestore`
    // refreshes before the toast is dismissed.
    expect(loadingToasts()).toEqual([]);
    expect(cards(w.store)).toEqual(["alpha"]);
  });

  it("clears the toast when the restore fails too", async () => {
    const w = await wire(["alpha"]);
    await killAndLand(w, "alpha");
    w.api.holdRestore = true;
    w.api.restoreError = true;

    const press = w.stack.undo();
    await settle();
    expect(loadingToasts()).toEqual(["Bringing alpha back…"]);

    w.api.letRestoreFinish();
    await expectRefusal(press, /could not be brought back/);

    // A sticky toast has no timer to save it: one left behind by a failure
    // would sit on screen for the rest of the page life.
    expect(loadingToasts()).toEqual([]);
  });

  it("says nothing for an undo inside the window, where nothing is out", async () => {
    // The rule this is the exception to: undo is silent when it works
    // (store/undo.ts). A retraction inside the window touches no server at all,
    // so there is nothing to wait for and nothing to say.
    const w = await wire(["alpha"]);
    await w.store.kill("alpha");
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);

    await expectOk(w.stack.undo());

    expect(toasts.toasts()).toEqual([]);
    expect(w.api.restores).toEqual([]);
  });
});
