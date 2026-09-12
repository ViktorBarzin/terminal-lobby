/**
 * The shell's half of a Workspace: what a tile write does to the two stores, and
 * what a change to the visible set does to tmux.
 *
 * Four things are pinned here, and each of them is a promise made somewhere
 * other than in the code that keeps it.
 *
 * A KILL KEEPS MEMBERSHIP, A CLOSE DOES NOT. The asymmetry is deliberate and is
 * the whole reason a restored session finds its tile again (ADR-0027, and
 * `assignments/<user>.json` does the same for project placement). The frontend
 * renders live sessions only, so a killed member simply has no tile — and the
 * write that follows must not read "no tile" as "take its seat away", because
 * only a deliberate close or a drag-out means that.
 *
 * A SESSION BELONGS TO AT MOST ONE WORKSPACE. tmux-api refuses a document where
 * two groups name the same session, so moving a session from A into B is ONE
 * write carrying both halves — there is no intermediate state to send.
 *
 * EVERY VISIBLE TILE RE-CLAIMS ITS GRID when the visible set moves. A pinned
 * tmux window re-reads its clients on an attach, a detach or a resize and on
 * nothing else, so revealing a slot or closing its neighbour leaves a window at
 * whatever size the last tile to speak left it. Measured on 2026-09-06, by the
 * same mechanism and before tiles existed: a desktop reading at 231x62 sat
 * inside a 60-column window, and a page reload was the only way out. A watching
 * tile still never claims, which is the one thing the pin exists to stop.
 *
 * A TILE IS DRAGGED BY ITS HEADER, which is also the strip that names it, so the
 * press that focuses a tile and the press that lifts it are one press until the
 * pointer moves.
 *
 * What is NOT here: the tree arithmetic (test/workspace-tree.test.ts), the drop
 * geometry (test/dnd.tiles.test.ts), the stored arrangements
 * (test/workspaces.store.test.ts), the visible set itself
 * (test/workspace-visible-set.test.tsx) and the undo entries
 * (test/undo.workspace.test.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";

/**
 * The terminal is scenery, and expensive scenery: a real one boots xterm, which
 * calls `matchMedia`, which jsdom does not ship. The stub keeps the one lever
 * this file needs — the grid claim a landed fit makes.
 */
const native = vi.hoisted(() => ({
  claim: null as null | ((cols: number, rows: number) => void),
}));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: { onGrid?: (cols: number, rows: number) => void }) => {
    native.claim = (cols, rows) => props.onGrid?.(cols, rows);
    return <div class="tl-terminal-native" />;
  },
}));

/** Every grid claim that reached the wire, as "SESSION COLSxROWS". Only this
 *  one export is replaced: a whole-module mock would take the session list and
 *  the layout with it. */
const grids = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/lobby-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/lobby-api")>()),
  setSessionGrid: async (name: string, cols: number, rows: number) => {
    grids.push(`${name} ${cols}x${rows}`);
  },
}));

import { SessionView } from "../src/components/SessionView";
import {
  nearestSurvivor,
  sameMembership,
  TILE_DRAG_SLOP_PX,
  watchTileDrag,
  writeMembership,
} from "../src/components/App";
import { WATCH_KEY_PREFIX } from "../src/store/watchmode";
import { keyOf } from "../src/store/keepalive";
import { emptyWorkspaces, type WorkspaceMember, type Workspaces } from "../src/types/lobby";

/**
 * Members of your own, which is what an ABSENT owner means — never `""`
 * (types/lobby.ts, `WorkspaceMember.owner`). Written as a helper because these
 * tests are about seats moving between groups, and a wall of `{name: "auth"}`
 * would bury that under punctuation. `mine("a", "b")` reads as two sessions.
 */
const ms = (...names: string[]): WorkspaceMember[] => names.map((name) => ({ name }));

const key = (name: string): string => keyOf({ name });

/** A membership document as tmux-api serves it. */
const doc = (...groups: { id: string; members: WorkspaceMember[] }[]): Workspaces => ({
  ...emptyWorkspaces(),
  workspaces: groups,
});

/** What the caller knows about which sessions are running, as the keepalive
 *  KEYS membership is compared by: one name under two owners is two terminals,
 *  so a name-shaped answer would let either stand in for the other. */
const live = (...names: string[]): ReadonlySet<string> => new Set(names.map((n) => key(n)));

/** The same, for a mix that includes a session somebody else owns. */
const liveOf = (...refs: WorkspaceMember[]): ReadonlySet<string> => new Set(refs.map(keyOf));

// ---------------------------------------------------------------------------
// Membership: the server half of a workspace write
// ---------------------------------------------------------------------------

describe("a kill keeps membership, a close takes it away", () => {
  it("keeps a member that has died and has no tile", () => {
    // `deploy` was killed. The tree renders live sessions only, so the tiles
    // are auth and docs — and if that were read as "remove deploy", restoring
    // it would put it back in the sidebar and NOT back in its workspace.
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("auth", "deploy", "docs") }),
      id: "w1",
      tiles: ms("auth", "docs"),
      live: live("auth", "docs"),
    });
    expect(next.workspaces).toEqual([{ id: "w1", members: ms("auth", "deploy", "docs") }]);
  });

  it("takes the seat of a LIVE member the tiles no longer show", () => {
    // The close control, or a drag out of the tiles. Both act on a session that
    // is running, which is exactly what tells them apart from a kill.
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("auth", "deploy", "docs") }),
      id: "w1",
      tiles: ms("auth", "docs"),
      live: live("auth", "deploy", "docs"),
    });
    expect(next.workspaces).toEqual([{ id: "w1", members: ms("auth", "docs") }]);
  });

  it("keeps a dead member's place in the order rather than appending it", () => {
    // The order is what a device that has never seen this workspace
    // auto-arranges from, so a restored session comes back to the tile it had
    // rather than to the end of the row.
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("auth", "deploy", "docs") }),
      id: "w1",
      tiles: ms("docs", "auth"),
      live: live("auth", "docs"),
    });
    expect(next.workspaces[0]?.members).toEqual(ms("auth", "deploy", "docs"));
  });

  it("still ends the workspace when the tiles fall below two", () => {
    // Closing back to one tile ends the workspace, dead members included: one
    // tile is not a workspace and tmux-api rejects a document that says it is.
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("auth", "deploy") }),
      id: "w1",
      tiles: ms("auth"),
      live: live("auth", "deploy"),
    });
    expect(next.workspaces).toEqual([]);
  });
});

describe("a session belongs to at most one workspace", () => {
  it("moves a session out of its old group in the same document", () => {
    const next = writeMembership({
      doc: doc(
        { id: "w1", members: ms("auth", "deploy", "docs") },
        { id: "w2", members: ms("a", "b") },
      ),
      id: "w2",
      tiles: ms("a", "b", "deploy"),
      live: live("auth", "deploy", "docs", "a", "b"),
    });
    expect(next.workspaces).toEqual([
      { id: "w1", members: ms("auth", "docs") },
      { id: "w2", members: ms("a", "b", "deploy") },
    ]);
  });

  it("drops a group the move left below two members", () => {
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("auth", "deploy") }, { id: "w2", members: ms("a", "b") }),
      id: "w2",
      tiles: ms("a", "b", "deploy"),
      live: live("auth", "deploy", "a", "b"),
    });
    expect(next.workspaces).toEqual([{ id: "w2", members: ms("a", "b", "deploy") }]);
  });

  it("creates a workspace that was not in the document, which is the first split", () => {
    const next = writeMembership({
      doc: emptyWorkspaces(),
      id: "wnew",
      tiles: ms("auth", "deploy"),
      live: live("auth", "deploy"),
    });
    expect(next.workspaces).toEqual([{ id: "wnew", members: ms("auth", "deploy") }]);
  });

  it("leaves an existing group where it was in the document", () => {
    const next = writeMembership({
      doc: doc({ id: "w1", members: ms("a", "b") }, { id: "w2", members: ms("c", "d") }),
      id: "w1",
      tiles: ms("a", "b", "e"),
      live: live("a", "b", "c", "d", "e"),
    });
    expect(next.workspaces.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("keeps the document's version, since the client speaks exactly one", () => {
    const before = doc({ id: "w1", members: ms("a", "b") });
    expect(
      writeMembership({ doc: before, id: "w1", tiles: ms("a", "b"), live: live("a", "b") }).version,
    ).toBe(before.version);
  });
});

/**
 * A SESSION IS `(owner, name)`, NOT A NAME, and membership is written in those
 * terms because a workspace may hold a session somebody shared with you
 * (design, "A member carries the same `{name, owner?}` the tree's tiles do").
 *
 * A tmux name is unique only inside one user's server, so your `auth` and emo's
 * `auth` are two terminals that may be two tiles of the same workspace. Every
 * rule above then has a second edge: the seat a kill keeps, the seat a close
 * takes, and the group a move empties all have to name the right one of the
 * two, and a write that compares names alone gets every one of them wrong in
 * the same direction — it treats the pair as one seat.
 */
describe("one name under two owners is two sessions", () => {
  const emosAuth: WorkspaceMember = { name: "auth", owner: "emo" };

  it("carries the owner into the document rather than writing a session of your own", () => {
    // The first split of a shared session beside one of your own. Dropping the
    // owner here writes `{name: "auth"}`, which tmux-api resolves to YOUR auth —
    // a session you may not even have — and the tile comes back as somebody
    // else's the next time the document is read.
    const next = writeMembership({
      doc: emptyWorkspaces(),
      id: "wnew",
      tiles: [emosAuth, ...ms("deploy")],
      live: liveOf(emosAuth, { name: "deploy" }),
    });
    expect(next.workspaces).toEqual([{ id: "wnew", members: [emosAuth, { name: "deploy" }] }]);
  });

  it("keeps both seats when the two sessions share a name", () => {
    // Deduping by name would collapse the pair to one member, which takes the
    // group below two and deletes it server-side on the very next write.
    const next = writeMembership({
      doc: emptyWorkspaces(),
      id: "wnew",
      tiles: [emosAuth, ...ms("auth")],
      live: liveOf(emosAuth, { name: "auth" }),
    });
    expect(next.workspaces).toEqual([{ id: "wnew", members: [emosAuth, { name: "auth" }] }]);
  });

  it("takes emo's seat without touching yours when emo's tile is closed", () => {
    // A close acts on a session that is running, and both of these are. Asked
    // by name, `claimed` already holds "auth" from your own tile, so emo's
    // member is kept and the close does nothing a person can see.
    const next = writeMembership({
      doc: doc({ id: "w1", members: [emosAuth, ...ms("auth", "deploy")] }),
      id: "w1",
      tiles: ms("auth", "deploy"),
      live: liveOf(emosAuth, { name: "auth" }, { name: "deploy" }),
    });
    expect(next.workspaces).toEqual([{ id: "w1", members: ms("auth", "deploy") }]);
  });

  it("keeps emo's dead seat while yours of the same name is the live tile", () => {
    // A KILL KEEPS MEMBERSHIP. emo's auth is gone and yours is a tile, so the
    // live set has your key and not emo's — which is the only thing that tells
    // the two apart, and by name it would read as "auth is alive, so the tile
    // that is missing was closed".
    const next = writeMembership({
      doc: doc({ id: "w1", members: [emosAuth, ...ms("auth", "deploy")] }),
      id: "w1",
      tiles: ms("auth", "deploy"),
      live: live("auth", "deploy"),
    });
    expect(next.workspaces).toEqual([{ id: "w1", members: [emosAuth, ...ms("auth", "deploy")] }]);
  });

  it("moves emo's session between groups and leaves your namesake where it was", () => {
    const next = writeMembership({
      doc: doc(
        { id: "w1", members: [emosAuth, ...ms("docs")] },
        { id: "w2", members: ms("auth", "deploy") },
      ),
      id: "w2",
      tiles: [...ms("auth", "deploy"), emosAuth],
      live: liveOf(emosAuth, { name: "auth" }, { name: "deploy" }, { name: "docs" }),
    });
    // w1 is left with one member and dropped; w2 gains emo's auth and keeps
    // yours, which is three seats under two names.
    expect(next.workspaces).toEqual([{ id: "w2", members: [...ms("auth", "deploy"), emosAuth] }]);
  });

  it("tells two documents apart when only the owner of one member moved", () => {
    // `sameMembership` is what lets a divider drag skip the server. Comparing
    // names, a write that swapped your auth for emo's would look like nothing
    // happened and never reach tmux-api.
    expect(
      sameMembership(
        doc({ id: "w1", members: [emosAuth, ...ms("deploy")] }),
        doc({ id: "w1", members: ms("auth", "deploy") }),
      ),
    ).toBe(false);
  });
});

describe("sameMembership — what lets a divider drag skip the server", () => {
  it("is true for two documents naming the same groups in the same order", () => {
    expect(
      sameMembership(
        doc({ id: "w1", members: ms("a", "b") }),
        doc({ id: "w1", members: ms("a", "b") }),
      ),
    ).toBe(true);
  });

  it("is false when the member ORDER moved, since that order decides a layout", () => {
    expect(
      sameMembership(
        doc({ id: "w1", members: ms("a", "b") }),
        doc({ id: "w1", members: ms("b", "a") }),
      ),
    ).toBe(false);
  });

  it("is false when a group arrived or left", () => {
    expect(sameMembership(doc({ id: "w1", members: ms("a", "b") }), emptyWorkspaces())).toBe(false);
  });
});

describe("where focus lands when the tile it was on closes", () => {
  const row = [key("a"), key("b"), key("c"), key("d")];

  it("takes the neighbour to the right", () => {
    expect(nearestSurvivor(row, 1, new Set([key("a"), key("c"), key("d")]))).toBe(key("c"));
  });

  it("falls back to the left when nothing survives to the right", () => {
    expect(nearestSurvivor(row, 3, new Set([key("a"), key("b"), key("c")]))).toBe(key("c"));
  });

  it("answers null when the closed tile was not in the arrangement", () => {
    expect(nearestSurvivor(row, -1, new Set([key("a")]))).toBeNull();
  });

  it("answers null when nothing at all survived, which leaves the selection alone", () => {
    // Unreachable through the close control — a workspace of one has no tiles
    // to close — and handled rather than trusted not to happen.
    expect(nearestSurvivor(row, 0, new Set())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The grid re-claim
// ---------------------------------------------------------------------------

/** How long the shell's re-claim waits for the terminal's own debounced fit to
 *  get there first. Longer than TerminalNative's 120 ms REFIT_DEBOUNCE_MS, so
 *  a tile whose box also changed has already claimed and the quiet window
 *  swallows this one. */
const RECLAIM_MS = 250;

describe("every visible tile re-claims its grid when the visible set moves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    grids.length = 0;
    native.claim = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("says its size again when a neighbouring tile closes", () => {
    const [stamp, setStamp] = createSignal("auth\0deploy");
    render(() => <SessionView session="qa-reclaim" visible visibleSet={stamp} />);

    // The boot fit, which claims on its own.
    native.claim?.(60, 40);
    expect(grids).toEqual(["qa-reclaim 60x40"]);

    // The neighbour closes. This tile's own box did not move, so nothing
    // refits — and without the re-claim the window keeps whatever the tile that
    // just went left it.
    vi.advanceTimersByTime(2000);
    setStamp("auth");
    vi.advanceTimersByTime(RECLAIM_MS);
    expect(grids).toEqual(["qa-reclaim 60x40", "qa-reclaim 60x40"]);
  });

  it("fires once per change rather than once per tick", () => {
    const [stamp, setStamp] = createSignal("a");
    render(() => <SessionView session="qa-reclaim-once" visible visibleSet={stamp} />);
    native.claim?.(60, 40);
    grids.length = 0;

    vi.advanceTimersByTime(2000);
    setStamp("b");
    vi.advanceTimersByTime(RECLAIM_MS * 4);
    expect(grids).toEqual(["qa-reclaim-once 60x40"]);
  });

  it("coalesces a burst of changes into one claim", () => {
    const [stamp, setStamp] = createSignal("a");
    render(() => <SessionView session="qa-reclaim-burst" visible visibleSet={stamp} />);
    native.claim?.(60, 40);
    grids.length = 0;
    vi.advanceTimersByTime(2000);

    // Entering a workspace of four moves the set several times in a frame.
    setStamp("b");
    setStamp("c");
    setStamp("d");
    vi.advanceTimersByTime(RECLAIM_MS * 2);
    expect(grids).toEqual(["qa-reclaim-burst 60x40"]);
  });

  it("says NOTHING while watching, which is what the pin exists to stop", () => {
    // A read-only client taking the size is the one thing Watch mode promises
    // cannot happen, and the server cannot tell two devices of one person
    // apart — so the caller declining is what keeps it.
    localStorage.setItem(`${WATCH_KEY_PREFIX}qa-reclaim-watch`, "ro");
    const [stamp, setStamp] = createSignal("a");
    render(() => <SessionView session="qa-reclaim-watch" visible visibleSet={stamp} />);
    native.claim?.(60, 40);
    expect(grids).toEqual([]);

    vi.advanceTimersByTime(2000);
    setStamp("b");
    vi.advanceTimersByTime(RECLAIM_MS * 2);
    expect(grids).toEqual([]);
  });

  it("says nothing for a tile that is not on screen", () => {
    const [stamp, setStamp] = createSignal("a");
    const [visible, setVisible] = createSignal(true);
    render(() => (
      <SessionView session="qa-reclaim-hidden" visible={visible()} visibleSet={stamp} />
    ));
    native.claim?.(60, 40);
    grids.length = 0;

    vi.advanceTimersByTime(2000);
    setVisible(false);
    setStamp("b");
    vi.advanceTimersByTime(RECLAIM_MS * 2);
    // A session nobody is showing keeps its last size until something shows it
    // again, which is the behaviour a lone session has always had.
    expect(grids).toEqual([]);
  });

  it("says nothing before the terminal has measured anything", () => {
    const [stamp, setStamp] = createSignal("a");
    render(() => <SessionView session="qa-reclaim-unfitted" visible visibleSet={stamp} />);
    setStamp("b");
    vi.advanceTimersByTime(RECLAIM_MS * 2);
    // The boot fit is about to claim for the first time; inventing a size to
    // beat it there would pin the window to a guess.
    expect(grids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tile drag
// ---------------------------------------------------------------------------

describe("a press on a tile header becomes a drag once it travels", () => {
  const press = (x: number, y: number): PointerEvent =>
    new MouseEvent("pointerdown", { clientX: x, clientY: y }) as unknown as PointerEvent;

  const move = (x: number, y: number): void => {
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
  };

  it("does not lift the tile for a press that barely moved", () => {
    let started = 0;
    watchTileDrag(press(100, 100), () => void started++);
    move(100 + TILE_DRAG_SLOP_PX - 1, 100);
    // That press is a click, and a click on a tile focuses it.
    expect(started).toBe(0);
    document.dispatchEvent(new MouseEvent("pointerup"));
  });

  it("lifts the tile once the pointer has travelled far enough to mean it", () => {
    let started = 0;
    watchTileDrag(press(100, 100), () => void started++);
    move(100 + TILE_DRAG_SLOP_PX + 1, 100);
    expect(started).toBe(1);
  });

  it("lifts it exactly once, however far the pointer then goes", () => {
    let started = 0;
    watchTileDrag(press(100, 100), () => void started++);
    move(140, 100);
    move(200, 160);
    // `dnd/tiles.ts` tracks the rest of the drag itself; a second start would
    // be a second drag over the top of the one in the air.
    expect(started).toBe(1);
  });

  it("gives up when the pointer lifts without travelling", () => {
    let started = 0;
    watchTileDrag(press(100, 100), () => void started++);
    document.dispatchEvent(new MouseEvent("pointerup"));
    move(300, 300);
    expect(started).toBe(0);
  });

  it("gives up when the platform takes the gesture away", () => {
    let started = 0;
    watchTileDrag(press(100, 100), () => void started++);
    document.dispatchEvent(new MouseEvent("pointercancel"));
    move(300, 300);
    expect(started).toBe(0);
  });
});
