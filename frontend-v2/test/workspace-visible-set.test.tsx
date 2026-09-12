/**
 * WHAT IS ON SCREEN, AND WHICH TILE THE KEYSTROKES GO TO.
 *
 * Until 2026-09-12 the shell asked one question of every mounted session,
 * `k.key === selectedKey()`, and that single equality was the whole of the
 * single-session assumption (design, "What this costs, and why it is less than
 * it looks"). A Workspace replaces it with a membership test against a visible
 * set, and this file pins the three things that rest on it:
 *
 *  1. The visible set itself. Zero, one and four members, and the rule that a
 *     workspace of fewer than two live members is not a workspace — which is
 *     also what makes a lone session, and every phone, behave exactly as they
 *     did before tiles existed.
 *  2. The slot is a BOX. `app.css` kept `.tl-session-slot { display: contents }`
 *     so a session view stayed a direct flex child of the shell column; a slot
 *     with no box of its own cannot be given a rectangle, and ADR-0027 names
 *     that one line as the CSS half of its first decision. Asserted against the
 *     stylesheet because there is no layout in jsdom to observe it in.
 *  3. The `window.__tl*` handles follow FOCUS, not visibility. Four visible
 *     tiles all pass `ownWhile`'s `active`, so before the focus gate the last
 *     one to mount won a race nobody arranged, and a paste meant for the
 *     session you are typing into landed in a neighbour.
 *
 * What is deliberately NOT here: the rect maths (test/workspace-tree.test.ts
 * owns `toRects`), the divider drag (test/workspace-canvas.test.tsx owns the
 * skeleton), and the stored arrangements (test/workspaces.store.test.ts). This
 * file is the shell's own half — which slots are on screen and which one is
 * holding the handles.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSignal, type Accessor, type Component } from "solid-js";
import { render } from "@solidjs/testing-library";
import { keyOf } from "../src/store/keepalive";
import { ownWhile, TileFocusContext } from "../src/lib/ownwhile";
import {
  visibleSet,
  workspaceTilesFor,
  type WorkspaceTiles,
  type WorkspaceTilesInput,
} from "../src/components/App";
import { emptyWorkspaces, type WorkspaceMember, type Workspaces } from "../src/types/lobby";

/** A session's keepalive key: what the mounted slots and the tree's tiles are
 *  both keyed by, so a tile and its live terminal match without a second
 *  identity concept. Own sessions have no owner. */
const key = (name: string): string => keyOf({ name });

/** Members of your own: an absent owner is what "mine" means in the document
 *  (types/lobby.ts, `WorkspaceMember.owner`). */
const ms = (...names: string[]): WorkspaceMember[] => names.map((name) => ({ name }));

/** The sessions the lobby says are running, as the KEYS `workspaceTilesFor`
 *  compares members by. Own sessions by name; anything foreign as a member. */
const live = (...refs: (string | WorkspaceMember)[]): ReadonlySet<string> =>
  new Set(refs.map((ref) => (typeof ref === "string" ? key(ref) : keyOf(ref))));

/** A membership document as tmux-api serves it, in the order the sessions were
 *  arranged. */
function doc(...groups: { id: string; members: WorkspaceMember[] }[]): Workspaces {
  return { ...emptyWorkspaces(), workspaces: groups };
}

/** Everything `workspaceTilesFor` reads, with the boring half filled in: a
 *  desktop, and a lobby that has answered and lists every session mentioned.
 *  `live` is a set of KEYS, so the default is built with `keyOf` rather than
 *  from the names — a foreign member is alive under its owner, not under
 *  yours. */
function ask(over: Partial<WorkspaceTilesInput> & { doc: Workspaces }): WorkspaceTiles | null {
  const named = new Set(over.doc.workspaces.flatMap((w) => w.members).map(keyOf));
  return workspaceTilesFor({
    selected: null,
    live: named,
    solo: false,
    ...over,
  });
}

describe("the visible set", () => {
  it("is empty with nothing selected and no workspace", () => {
    // The composer is on screen. No session is visible behind it, and every
    // mounted slot asks and is told no.
    expect([...visibleSet([], null)]).toEqual([]);
  });

  it("is the selected session alone when it is in no workspace", () => {
    expect([...visibleSet([], key("auth"))]).toEqual([key("auth")]);
  });

  it("is every member of the workspace, the focused one included", () => {
    const tiles = [key("auth"), key("deploy"), key("docs"), key("logs")];
    const set = visibleSet(tiles, key("deploy"));
    expect(set.size).toBe(4);
    for (const k of tiles) expect(set.has(k)).toBe(true);
  });

  it("answers a mounted session that is in neither with no", () => {
    // The point of a set rather than a list: a tab can hold a day of mounts
    // (store/keepalive.ts) and all but the visible ones stay hidden.
    const set = visibleSet([key("auth"), key("deploy")], key("auth"));
    expect(set.has(key("kept-yesterday"))).toBe(false);
  });

  it("prefers the tiles over the selection, never both", () => {
    // The selected session is a member by construction — `workspaceTilesFor`
    // refuses a group that does not contain it — so there is nothing to add.
    const set = visibleSet([key("auth"), key("deploy")], key("auth"));
    expect(set.size).toBe(2);
  });
});

describe("which workspace is on screen", () => {
  it("finds the group holding the selected session", () => {
    const tiles = ask({
      doc: doc({ id: "w1", members: ms("auth", "deploy", "docs", "logs") }),
      selected: { name: "docs" },
    });
    expect(tiles?.id).toBe("w1");
    expect(tiles?.keys).toEqual([key("auth"), key("deploy"), key("docs"), key("logs")]);
  });

  it("leaves the workspace when a non-member is selected", () => {
    // Clicking a sidebar session that belongs to no workspace shows it alone.
    // The workspace is not lost: clicking any member brings the whole thing
    // back, because membership lives on the server.
    const membership = doc({ id: "w1", members: ms("auth", "deploy") });
    expect(ask({ doc: membership, selected: { name: "notes" }, live: live("notes") })).toBe(null);
    expect(ask({ doc: membership, selected: { name: "auth" } })?.id).toBe("w1");
  });

  it("shows nothing while the composer is open", () => {
    expect(ask({ doc: doc({ id: "w1", members: ms("auth", "deploy") }), selected: null })).toBe(
      null,
    );
  });

  it("gives a session somebody shared with you its workspace, like any other", () => {
    // THE JOB THE DESIGN OPENS WITH: emo's `auth` open beside two of your own.
    // A member carries `{name, owner?}` (types/lobby.ts, `WorkspaceMember`) and
    // tmux-api resolves it to the same `SessionRef` the project store keys by,
    // so there is nothing about a foreign session the server cannot remember.
    // Until 2026-09-12 this bailed on `selected.owner` before it looked, and
    // clicking a shared tile left whatever workspace was on screen.
    const emosAuth: WorkspaceMember = { name: "auth", owner: "emo" };
    const tiles = ask({
      doc: doc({ id: "w1", members: [emosAuth, ...ms("deploy", "docs")] }),
      selected: emosAuth,
      live: live(emosAuth, "deploy", "docs"),
    });
    expect(tiles?.id).toBe("w1");
    expect(tiles?.keys).toEqual([keyOf(emosAuth), key("deploy"), key("docs")]);
  });

  it("does not answer for emo's session with one of your own of that name", () => {
    // A tmux name is unique only inside one user's server, which is why the key
    // carries the owner. Two groups, and the same NAME in both: asked by name,
    // `find` stops at the first and puts emo's workspace on screen when you
    // clicked your own session.
    const tiles = ask({
      doc: doc(
        { id: "w1", members: [{ name: "auth", owner: "emo" }, ...ms("docs")] },
        { id: "w2", members: ms("auth", "deploy") },
      ),
      selected: { name: "auth" },
      live: live({ name: "auth", owner: "emo" }, "auth", "deploy", "docs"),
    });
    expect(tiles?.id).toBe("w2");
    expect(tiles?.keys).toEqual([key("auth"), key("deploy")]);
  });

  it("does not keep emo's dead tile alive because you have a session of that name", () => {
    // The other direction of the same mistake, and the one a KILL KEEPS
    // MEMBERSHIP makes dangerous: emo's `auth` is gone, yours is running. Read
    // by name the group still has three live members and draws a tile over a
    // terminal that is not there.
    const membership = doc({
      id: "w1",
      members: [{ name: "auth", owner: "emo" }, ...ms("deploy", "docs")],
    });
    const tiles = ask({
      doc: membership,
      selected: { name: "deploy" },
      live: live("auth", "deploy", "docs"),
    });
    expect(tiles?.keys).toEqual([key("deploy"), key("docs")]);
  });

  it("still leaves the workspace for a foreign session no group holds", () => {
    const tiles = ask({
      doc: doc({ id: "w1", members: ms("auth", "deploy") }),
      selected: { name: "notes", owner: "emo" },
      live: live("auth", "deploy", { name: "notes", owner: "emo" }),
    });
    expect(tiles).toBe(null);
  });
});

describe("a workspace of one is a session", () => {
  it("is not a workspace at all", () => {
    // The server rejects a stored group of one, and a client that failed to
    // finish a removal can still present one. Either way it is a session.
    const tiles = ask({
      doc: doc({ id: "w1", members: ms("auth") }),
      selected: { name: "auth" },
    });
    expect(tiles).toBe(null);
    expect([...visibleSet([], key("auth"))]).toEqual([key("auth")]);
  });

  it("is what a workspace becomes when its members are killed down to one", () => {
    // A KILL KEEPS MEMBERSHIP, so the document still lists all three and the
    // survivor shows on its own. Restoring either of the others puts the tiles
    // back with no write to the server at all.
    const membership = doc({ id: "w1", members: ms("auth", "deploy", "docs") });
    expect(ask({ doc: membership, selected: { name: "auth" }, live: live("auth") })).toBe(null);
    expect(
      ask({ doc: membership, selected: { name: "auth" }, live: live("auth", "docs") })?.keys,
    ).toEqual([key("auth"), key("docs")]);
  });

  it("trusts the document while the lobby has not answered yet", () => {
    // `live: null` is "I do not know", not "nothing is alive". Filtering
    // against an empty set before the first poll lands would collapse every
    // workspace on every page load for as long as that request takes.
    const tiles = ask({
      doc: doc({ id: "w1", members: ms("auth", "deploy") }),
      selected: { name: "auth" },
      live: null,
    });
    expect(tiles?.keys).toEqual([key("auth"), key("deploy")]);
  });
});

describe("a phone sees no workspaces", () => {
  it("shows exactly one session however many members the group has", () => {
    // A coarse pointer at 720px or narrower (mobile/pointer.ts, FLIP_QUERY):
    // a tree of four columns describes a 32-inch monitor and is unrenderable
    // here, so tapping a member opens that session alone (ADR-0027).
    const membership = doc({ id: "w1", members: ms("auth", "deploy", "docs", "logs") });
    expect(ask({ doc: membership, selected: { name: "deploy" }, solo: true })).toBe(null);
    expect([...visibleSet([], key("deploy"))]).toEqual([key("deploy")]);
  });

  it("is the first thing read, so the group is never even looked up", () => {
    // Rotating a phone crosses the query live, and the answer has to be the
    // same on a device whose membership fetch failed as on one where it landed.
    expect(ask({ doc: emptyWorkspaces(), selected: { name: "auth" }, solo: true })).toBe(null);
  });
});

describe("a session slot is a box", () => {
  const css = readFileSync(resolve(__dirname, "../src/app.css"), "utf8");

  /** One rule's declarations, by exact selector. */
  function rule(selector: string): string {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} is missing from app.css`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    return css.slice(open + 1, css.indexOf("}", open));
  }

  it("is laid out rather than skipped", () => {
    // `display: contents` kept the wrapper out of the layout entirely. A slot
    // that is not a box cannot be positioned, and positioning the slot is how
    // the split tree arranges tiles WITHOUT moving a live terminal in the DOM.
    const slot = rule(".tl-session-slot");
    expect(slot).not.toMatch(/display:\s*contents/);
    expect(slot).toMatch(/display:\s*flex/);
    expect(slot).toMatch(/flex-direction:\s*column/);
    // What `display: contents` was standing in for: the session view took the
    // shell body's free height directly, and now takes the slot's.
    expect(slot).toMatch(/flex:\s*1 1 auto/);
    expect(slot).toMatch(/min-height:\s*0/);
  });

  it("takes a rectangle when the tree gives it one", () => {
    const tiled = rule(".tl-session-slot.tl-tiled");
    expect(tiled).toMatch(/position:\s*absolute/);
    // The four numbers are inline, from `toRects`. Pinning them in the
    // stylesheet would be a second source of truth for the geometry.
    expect(tiled).not.toMatch(/\bleft:/);
    expect(tiled).not.toMatch(/\btop:/);
  });

  it("still hides a slot outright rather than moving it away", () => {
    // Hidden is `display: none`, which is what makes a kept session free to
    // come back to; a tile that is off screen has no box at all.
    expect(rule(".tl-hidden")).toMatch(/display:\s*none/);
  });
});

describe("the window handles follow the focused tile", () => {
  /** Which claimant currently holds `window.__tlOpenFind`. */
  let heard = "";

  /**
   * One view's claim on a handle, written the way `SessionView` writes its
   * five: from the component body, where Solid has an owner and `ownWhile` can
   * read the focus context.
   */
  const Claim: Component<{ active: Accessor<boolean>; tag: string }> = (props) => {
    ownWhile(
      () => props.active(),
      "__tlOpenFind",
      () => {
        heard = props.tag;
        return true;
      },
    );
    return null;
  };

  /** A tile: a claim inside the focus provider App.tsx wraps each slot in. */
  const Tile: Component<{
    focused: Accessor<boolean>;
    active: Accessor<boolean>;
    tag: string;
  }> = (props) => (
    <TileFocusContext.Provider value={props.focused}>
      <Claim active={props.active} tag={props.tag} />
    </TileFocusContext.Provider>
  );

  beforeEach(() => {
    heard = "";
  });
  afterEach(() => {
    window.__tlOpenFind = undefined;
  });

  it("gives the handle to the focused tile, not to whichever mounted last", () => {
    const [focus, setFocus] = createSignal("auth");
    const on = (): boolean => true;
    render(() => (
      <>
        <Tile tag="auth" active={on} focused={() => focus() === "auth"} />
        <Tile tag="deploy" active={on} focused={() => focus() === "deploy"} />
        <Tile tag="docs" active={on} focused={() => focus() === "docs"} />
      </>
    ));
    // Three tiles on screen, all three `active`. Before the gate the third one
    // held the handle because it mounted last.
    expect(window.__tlOpenFind?.()).toBe(true);
    expect(heard).toBe("auth");

    setFocus("docs");
    expect(window.__tlOpenFind?.()).toBe(true);
    expect(heard).toBe("docs");
  });

  it("hands back cleanly when focus moves twice, in either order", () => {
    // The order-independence the original claim was built on still holds: a
    // cleanup only restores the previous value if the handle is still ITS
    // value, so an install that already happened is never clobbered.
    const [focus, setFocus] = createSignal("auth");
    const on = (): boolean => true;
    render(() => (
      <>
        <Tile tag="auth" active={on} focused={() => focus() === "auth"} />
        <Tile tag="deploy" active={on} focused={() => focus() === "deploy"} />
      </>
    ));
    setFocus("deploy");
    setFocus("auth");
    expect(window.__tlOpenFind?.()).toBe(true);
    expect(heard).toBe("auth");
  });

  it("leaves the handle unclaimed while the focused tile is off screen", () => {
    // Focus is necessary, not sufficient. A parked or hidden view still fails
    // `active`, which is the gate that was there before tiles.
    const [live, setLive] = createSignal(false);
    render(() => <Tile tag="auth" active={live} focused={() => true} />);
    expect(window.__tlOpenFind).toBe(undefined);
    setLive(true);
    expect(window.__tlOpenFind?.()).toBe(true);
    expect(heard).toBe("auth");
  });

  it("claims on `active` alone outside a workspace", () => {
    // The default the context carries is `true`, which is what keeps the
    // Ctrl+J dock's terminal, and every view rendered on its own, behaving
    // exactly as they did before the gate existed.
    render(() => <Claim tag="lone" active={() => true} />);
    expect(window.__tlOpenFind?.()).toBe(true);
    expect(heard).toBe("lone");
  });
});
