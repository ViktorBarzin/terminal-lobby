/**
 * The chrome a Tile wears.
 *
 * Roughly 24px, and the design names everything that may sit on it: the
 * session's title, its state dot, a watch marker when the tile is read-only,
 * and a close control. Nothing else — the context meter and the spend figure
 * stay on the session bar, which shows the FOCUSED tile and follows focus
 * around (docs/plans/2026-09-12-multi-session-workspaces-design.md, "Everything
 * else, and what changes"; CONTEXT.md, "Tile").
 *
 * Two of those four are asserted here as REUSE rather than as new behaviour.
 * The title is `sessionLabel`, the same fallback ladder every other surface
 * goes through, and the dot is `StateDot`, the component the sidebar already
 * draws. A header that re-derived either would be a second copy of a rule that
 * has moved twice already (ADR-0019 made a name an opaque id, ADR-0022 made a
 * title rename it), and the copy nobody remembered to move is the one a person
 * ends up reading.
 *
 * The focused treatment is split across the two halves it lives in. The DOM
 * carries `data-focused`, which is the contract and is asserted by rendering.
 * How LOUD that reads is a stylesheet question jsdom cannot answer — it applies
 * no external CSS and runs no layout — so the bottom of this file reads
 * src/tiles.css directly, the way test/card.longpress.css.test.ts reads
 * sidebar.css and for the same reason.
 *
 * The kill window is split the same way, and is asserted against the card it
 * copies. The design says a killed member "dims its tile and strikes it through
 * with the `↺` arrow and the seconds counting down, exactly as a sidebar card
 * does" ("Death and restore"), so what is checked here is the sameness: the
 * same `data-killing` contract, the same rounding, the same `aria-hidden`
 * number, the same swap of one control for another — with
 * test/SessionCard.killing.test.tsx asserting the row's half of the identical
 * pair.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createSignal, type Accessor } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TileHeader, type TileSession } from "../src/components/TileHeader";
import { isEditingTarget } from "../src/keybindings/editing";

/** A minted name: 12 characters of Crockford base32 (src/lib/session-id.ts). */
const MINTED = "k3f9m2zq7abc";

const session = (over: Partial<TileSession> = {}): TileSession => ({ name: MINTED, ...over });

interface Mounted {
  header: HTMLElement;
  /** The title text as a reader sees it. */
  title: string;
  /** The state dot, which is `StateDot`'s own span. */
  dot: HTMLElement;
  watch: HTMLElement | null;
  close: HTMLButtonElement;
  onClose: ReturnType<typeof vi.fn>;
  onUndoKill: ReturnType<typeof vi.fn>;
  onRename: ReturnType<typeof vi.fn>;
}

function mount(
  o: {
    session?: Partial<TileSession>;
    focused?: boolean;
    watching?: boolean;
    /** Inside its kill window, the answer `store.killing(name)` gives. */
    killing?: boolean;
    /** The instant the kill lands, as `store.killingUntil(name)` reports it. */
    until?: number;
    /** The sidebar's 1Hz tick, so a case can step the countdown by hand. */
    tick?: Accessor<number>;
    /**
     * FALSE for a session that is not this reader's to retitle, which is the
     * shape App.tsx passes for a foreign tile: the handler is simply absent.
     */
    rename?: boolean;
  } = {},
): Mounted {
  const onClose = vi.fn();
  const onUndoKill = vi.fn();
  const onRename = vi.fn();
  const { container } = render(() => (
    <TileHeader
      session={session(o.session)}
      focused={o.focused}
      watching={o.watching}
      onClose={onClose}
      onRename={o.rename === false ? undefined : onRename}
      killing={o.killing}
      killingUntil={o.until}
      tick={o.tick}
      onUndoKill={onUndoKill}
    />
  ));
  return {
    header: container.querySelector<HTMLElement>(".tl-tile-header")!,
    title: container.querySelector<HTMLElement>(".tl-tile-title")!.textContent ?? "",
    dot: container.querySelector<HTMLElement>(".tl-state-dot")!,
    watch: container.querySelector<HTMLElement>(".tl-tile-watch"),
    close: container.querySelector<HTMLButtonElement>(".tl-tile-close")!,
    onClose,
    onUndoKill,
    onRename,
  };
}

// Queried through the header rather than captured at mount, because the two
// controls and the number come and go: `<Show>` builds a new node each time,
// and a reference taken once would be the node from before the kill started.
const closeBtn = (h: HTMLElement) => h.querySelector<HTMLButtonElement>("button.tl-tile-close");
const undoArrow = (h: HTMLElement) => h.querySelector<HTMLButtonElement>("button.tl-tile-undo");
const countdown = (h: HTMLElement) => h.querySelector<HTMLElement>(".tl-tile-countdown");

describe("what a tile calls its session", () => {
  it("shows the title, which is the only name anyone reads", () => {
    expect(mount({ session: { title: "Deploy the thing" } }).title).toBe("Deploy the thing");
  });

  // The rung below the title. A name that was never minted here still says
  // something — a session from before ids, a shell somebody named by hand — so
  // it is shown rather than thrown away.
  it("falls back to a readable name when the session has no title", () => {
    expect(mount({ session: { name: "deploy-the-thing" } }).title).toBe("deploy-the-thing");
  });

  // The bottom rung, and the one that matters: twelve random characters tell a
  // reader nothing, and four tiles of them tell them nothing four times over.
  it("never shows a minted id, which says nothing", () => {
    const shown = mount().title;
    expect(shown).toBe("New session");
    expect(shown).not.toContain(MINTED);
  });

  // An empty title is a session with no title, not a session titled "".
  it("treats an empty title as no title at all", () => {
    expect(mount({ session: { name: "shell", title: "" } }).title).toBe("shell");
  });

  // The name is invisible everywhere else now, and it is what `tmux ls` and the
  // status bar show — so it stays reachable for anyone mapping a tile back to a
  // shell. The pane's own title follows it, as it does on a sidebar card.
  it("keeps the tmux name on hover, where a clamped title can be read in full", () => {
    const plain = mount({ session: { title: "Deploy the thing" } });
    expect(plain.header.querySelector(".tl-tile-title")!.getAttribute("title")).toBe(MINTED);

    const running = mount({ session: { title: "Deploy", pane_title: "npm test" } });
    expect(running.header.querySelector(".tl-tile-title")!.getAttribute("title")).toBe(
      `${MINTED} · npm test`,
    );
  });
});

describe("the state dot", () => {
  it("is the sidebar's own dot, carrying this session's state", () => {
    expect(mount({ session: { state: "running" } }).dot.className).toContain("tl-state-running");
    expect(mount({ session: { state: "awaiting" } }).dot.className).toContain("tl-state-awaiting");
    expect(mount({ session: { state: "done" } }).dot.className).toContain("tl-state-done");
  });

  // A session with no live Claude has no state, and the dot says so by being
  // plain rather than by disappearing: a header whose dot came and went would
  // shuffle its title sideways every time a shell landed in a tile.
  it("stays put, unstated, for a session with no live Claude", () => {
    const dot = mount({ session: { state: "" } }).dot;
    expect(dot).toBeTruthy();
    expect(dot.className).not.toMatch(/tl-state-(running|awaiting|done)/);
  });

  it("says in words what it is drawing, for a tooltip and a screen reader", () => {
    const working = mount({ session: { state: "running", bg: { agents: 2 } } }).dot;
    expect(working.getAttribute("title")).toBe("Working · 2 agents");
    expect(working.getAttribute("aria-label")).toBe("Working · 2 agents");
  });
});

describe("the watch marker", () => {
  // The one mark that says this tile cannot type, and it is the same 👁 a
  // sidebar card wears. A watching tile also never claims its session's Grid
  // (SessionView's own refusal), so this is what tells a person why their tile
  // is not the size of the terminal drawn in it.
  it("appears when the tile is read-only", () => {
    const m = mount({ watching: true });
    expect(m.watch).toBeTruthy();
    expect(m.watch!.textContent).toContain("👁");
  });

  it("is absent on a tile that drives, which is the ordinary case", () => {
    expect(mount().watch).toBeNull();
    expect(mount({ watching: false }).watch).toBeNull();
  });

  it("says what it means, rather than leaving a screen reader an emoji", () => {
    const watch = mount({ watching: true }).watch!;
    expect(watch.getAttribute("aria-label")).toMatch(/view/i);
    expect(watch.getAttribute("title")).toMatch(/watch/i);
  });
});

describe("the close control", () => {
  it("asks its owner to close, and does nothing itself", () => {
    const m = mount();
    fireEvent.click(m.close);
    expect(m.onClose).toHaveBeenCalledTimes(1);
    // The header is still standing: removal is the workspace's to do, and this
    // control only says so.
    expect(m.header.isConnected).toBe(true);
  });

  it("is a real button, so it is reachable by keyboard and by a screen reader", () => {
    const close = mount({ session: { title: "Deploy the thing" } }).close;
    expect(close.tagName).toBe("BUTTON");
    expect(close.type).toBe("button");
    expect(close.getAttribute("aria-label")).toContain("Deploy the thing");
  });

  // Closing a tile leaves the session running and in the sidebar where it was,
  // which is the whole difference between this and a kill. The control has to
  // say so before it is pressed, because nothing asks afterwards.
  it("promises the session keeps running", () => {
    expect(mount().close.getAttribute("title")).toMatch(/keeps running/i);
  });

  it("stays out of the way of a click meant for the tile", () => {
    const m = mount();
    fireEvent.click(m.header);
    expect(m.onClose).not.toHaveBeenCalled();
  });
});

/**
 * Renaming a session from the tile it is drawn in.
 *
 * Viktor, 2026-09-13: *"let's allow renaming of the sessions - i should be able
 * to double click on the pane and that should tirgger a text box that will
 * allow me to change the name which will rename the session in there"*.
 *
 * THE SIDEBAR CARD'S GESTURE, ON THE OTHER SURFACE THAT NAMES A SESSION. The
 * card has had this since long before workspaces existed (SessionCard
 * `beginRename`), and a workspace is exactly the state where the sidebar is the
 * thing you are NOT looking at: four terminals are, and each wears the only
 * label it has. So the pair is asserted the way the kill window is asserted
 * further down, as sameness. Same double click, same Enter to commit, same
 * Escape to abandon, same blur that abandons rather than commits, same "empty
 * clears the title".
 *
 * It reports the press rather than doing the rename, like every other control
 * on this strip. What `onRename` reaches is `store.rename(name, title)`, and it
 * is the TITLE that changes: the tmux name is an opaque id minted at creation
 * (ADR-0019) which the server moves on its own (ADR-0022). Nothing here knows
 * that, which is the point of not writing it twice.
 */
describe("renaming a session from its tile", () => {
  /** The box, which only exists while one is being typed into. */
  const box = (h: HTMLElement) => h.querySelector<HTMLInputElement>("input.tl-tile-rename");
  const titleEl = (h: HTMLElement) => h.querySelector<HTMLElement>(".tl-tile-title");
  /** `beginRename` focuses and selects on the microtask queue, as the card does. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("opens a box on a double click, holding the title ready to be replaced", async () => {
    const m = mount({ session: { title: "Deploy the thing" } });
    expect(box(m.header)).toBeNull();
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    const input = box(m.header)!;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Deploy the thing");
    // Focused and selected, so the next keystroke replaces the title rather
    // than landing somewhere in the middle of it.
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Deploy the thing".length);
  });

  // The box stands where the title stood. A strip that swapped a span for an
  // input of another size would jump under the cursor that opened it.
  it("puts the box in the title's place, and the title back when it closes", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    expect(titleEl(m.header)).toBeNull();
    fireEvent.keyDown(box(m.header)!, { key: "Escape" });
    expect(box(m.header)).toBeNull();
    expect(titleEl(m.header)!.textContent).toBe("Deploy");
  });

  // A minted id is shown as "New session" and opens an EMPTY box: twelve random
  // characters are not a draft anybody wants to edit (types/lobby.ts
  // `sessionTitleDraft`, which the card opens with too).
  it("opens empty on a session that has only a minted id", async () => {
    const m = mount();
    expect(m.title).toBe("New session");
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    expect(box(m.header)!.value).toBe("");
  });

  it("asks its owner to rename on Enter, and closes the box", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    const input = box(m.header)!;
    fireEvent.input(input, { target: { value: "Ship it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(m.onRename).toHaveBeenCalledWith("Ship it");
    expect(box(m.header)).toBeNull();
  });

  // Emptying the box clears the title, handing the session back to whatever
  // summary lands next. The card's own contract, and the reason this is an
  // empty string rather than a refusal.
  it("clears the title when the box is emptied", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    const input = box(m.header)!;
    fireEvent.input(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(m.onRename).toHaveBeenCalledWith("");
  });

  it("says nothing to its owner when the text came back unchanged", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    fireEvent.keyDown(box(m.header)!, { key: "Enter" });
    expect(m.onRename).not.toHaveBeenCalled();
  });

  it("abandons on Escape, leaving the title where it was", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    const input = box(m.header)!;
    fireEvent.input(input, { target: { value: "Ship it" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(m.onRename).not.toHaveBeenCalled();
    expect(titleEl(m.header)!.textContent).toBe("Deploy");
  });

  // Clicking away abandons rather than commits, which is the card's answer and
  // the safer one: a half-typed title left on screen while you go and read
  // another tile should not become the session's name because you looked away.
  it("abandons when the box loses focus", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    const input = box(m.header)!;
    fireEvent.input(input, { target: { value: "Ship it" } });
    fireEvent.blur(input);
    expect(m.onRename).not.toHaveBeenCalled();
    expect(box(m.header)).toBeNull();
  });

  /**
   * Cmd+Z while retyping a title walks the BOX back, not the workspace.
   *
   * The keybinding engine's one listener is capture-phase on `window`
   * (keybindings/engine.ts), so nothing the box does to the event can shield
   * it — the refusal has to happen at the binding table, and it does, through
   * `isEditingTarget` (keybindings/editing.ts). Every other lobby chord sits in
   * the Alt+Shift namespace for the same reason. This asserts the box lands on
   * the right side of that answer, which is a property of its being a plain
   * text `<input>` and would quietly stop being true if it became anything
   * else.
   */
  it("owns the undo chord while it is open, as every other text field does", async () => {
    const m = mount({ session: { title: "Deploy" } });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    expect(isEditingTarget(box(m.header))).toBe(true);
    fireEvent.keyDown(box(m.header)!, { key: "Escape" });
    // And hands it straight back: a closed box is a title again, and Cmd+Z
    // there is the workspace's own undo.
    expect(isEditingTarget(titleEl(m.header))).toBe(false);
  });

  // A foreign session belongs to somebody else, and its title is theirs. The
  // gesture is hidden rather than allowed to fail at the server, which is what
  // the absent handler means.
  it("offers no box on a session that is not the reader's to retitle", async () => {
    const m = mount({ session: { title: "Deploy" }, rename: false });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    expect(box(m.header)).toBeNull();
    expect(titleEl(m.header)!.hasAttribute("data-rename")).toBe(false);
  });

  // Nor a title on a session that is leaving. The card refuses the same way
  // while its kill window runs, and the press worth having in those eight
  // seconds is the arrow.
  it("offers no box while the session is dying", async () => {
    const m = mount({ session: { title: "Deploy" }, killing: true });
    fireEvent.dblClick(titleEl(m.header)!);
    await flush();
    expect(box(m.header)).toBeNull();
  });

  /**
   * The gesture Viktor asked for is a double click, and until this strip had a
   * key as well a rename from a workspace was mouse-only: the title was a
   * `<span>`, so there was no tab stop to reach and nothing to press.
   */
  it("opens on Enter and on F2, so the gesture is not mouse-only", async () => {
    for (const key of ["Enter", "F2"]) {
      const m = mount({ session: { title: "Deploy" } });
      const title = titleEl(m.header)!;
      expect(title.getAttribute("role")).toBe("button");
      expect(title.tabIndex).toBe(0);
      expect(title.getAttribute("aria-label")).toBe("Rename Deploy");
      fireEvent.keyDown(title, { key });
      await flush();
      expect(box(m.header), `${key} opens the box`).toBeTruthy();
    }
  });

  // A title nobody may edit is a label, not a control. Announcing it as a
  // button would promise a press that does nothing.
  it("is a plain label on a session that is not the reader's", () => {
    const title = titleEl(mount({ session: { title: "Deploy" }, rename: false }).header)!;
    expect(title.hasAttribute("role")).toBe(false);
    expect(title.tabIndex).toBe(-1);
  });

  // The cursor is the only thing that advertises the gesture, so it is on the
  // titles that have it and off the ones that do not.
  it("marks a renameable title, where the stylesheet can key a cursor on it", () => {
    expect(mount().header.querySelector(".tl-tile-title")!.hasAttribute("data-rename")).toBe(true);
  });
});

describe("the focused tile", () => {
  // Where the keystrokes are going. Exactly one tile is focused, so exactly one
  // header carries this, and lib/ownwhile.ts gates the window handles on the
  // same answer — the highlight and the paste target cannot disagree.
  it("marks itself in the DOM, where the stylesheet can key on it", () => {
    expect(mount({ focused: true }).header.hasAttribute("data-focused")).toBe(true);
    expect(mount({ focused: false }).header.hasAttribute("data-focused")).toBe(false);
    expect(mount().header.hasAttribute("data-focused")).toBe(false);
  });
});

/**
 * A member inside its kill window.
 *
 * A kill sends nothing for eight seconds (store/lobby.ts GRACE_MS), and that
 * window is what replaced the `Kill session "x"?` confirm on every entry point.
 * It only works if the surface the person is looking at says so — and when a
 * workspace is up, that surface is the tile: the session was killed from it, it
 * is the biggest thing on the screen, and a sidebar row two hundred pixels away
 * quietly counting down is not where the eyes are.
 *
 * The tile keeps its rectangle for all eight seconds. The design's reflow
 * belongs to the moment the window CLOSES, so an undo has a tile to point at and
 * the terminal underneath goes on drawing until the session actually stops.
 */
describe("a tile whose session is on its way out", () => {
  it("marks the strip, so the dim and the strike-through have something to hang on", () => {
    expect(mount({ killing: true }).header.hasAttribute("data-killing")).toBe(true);
    expect(mount({ killing: false }).header.hasAttribute("data-killing")).toBe(false);
    expect(mount().header.hasAttribute("data-killing")).toBe(false);
  });

  // The swap, rather than a fifth item. Four tiles pay for this strip four
  // times in rows taken out of four live tmux windows, so the header that shows
  // a kill is the same 24px as the header that does not.
  it("gives the close control's slot to the arrow, and takes it back afterwards", () => {
    const dying = mount({ killing: true }).header;
    expect(undoArrow(dying)).not.toBeNull();
    expect(closeBtn(dying)).toBeNull();

    const alive = mount().header;
    expect(undoArrow(alive)).toBeNull();
    expect(closeBtn(alive)).not.toBeNull();
  });

  // Closing a tile leaves the session running; this rescues one that is about
  // to stop. Offering both at once, 6px apart, would put the two opposite
  // presses of this strip side by side.
  it("never offers both presses at once", () => {
    const buttons = mount({ killing: true }).header.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.className).toContain("tl-tile-undo");
  });

  it("asks its owner to take the kill back, and does nothing itself", () => {
    const m = mount({ killing: true });
    fireEvent.click(undoArrow(m.header)!);
    expect(m.onUndoKill).toHaveBeenCalledTimes(1);
    // The retraction is `store.takeBackKill`, which the shell holds. The header
    // is still standing and has closed nothing.
    expect(m.onClose).not.toHaveBeenCalled();
    expect(m.header.isConnected).toBe(true);
  });

  it("is a real button, so the only way back is reachable without a mouse", () => {
    const m = mount({ killing: true, session: { title: "Deploy the thing" } });
    const arrow = undoArrow(m.header)!;
    expect(arrow.tagName).toBe("BUTTON");
    expect(arrow.type).toBe("button");
    expect(arrow.textContent).toContain("↺");
    // Named, unlike the sidebar's, because a workspace can have four of these
    // strips on screen and "Undo kill" alone would not say which session.
    expect(arrow.getAttribute("aria-label")).toMatch(/^undo kill/i);
    expect(arrow.getAttribute("aria-label")).toContain("Deploy the thing");
  });

  // A store that reports `killing` with no deadline is the shape an older build
  // had, and the card treats it the same way: the strip still dims and still
  // offers the arrow, it just has no number to show.
  it("draws the arrow whenever the window is running, deadline or not", () => {
    const m = mount({ killing: true });
    expect(undoArrow(m.header)).not.toBeNull();
    expect(countdown(m.header)).toBeNull();
  });

  // Focus and death are different questions and the strip answers both: this is
  // the tile taking keystrokes AND the tile that is going.
  it("still says where the keystrokes are going while it dies", () => {
    const header = mount({ killing: true, focused: true }).header;
    expect(header.hasAttribute("data-focused")).toBe(true);
    expect(header.hasAttribute("data-killing")).toBe(true);
  });
});

/**
 * The seconds beside the arrow.
 *
 * The dim and the strike say the tile is leaving. They cannot say how long is
 * left, and eight seconds is short enough that the difference between "plenty
 * of time" and "about to go" is the whole decision.
 *
 * The number is computed in the header from the DEADLINE the shell passes, and
 * the sidebar's existing 1Hz tick is what makes it re-read the clock. No second
 * timer exists — four tiles each running their own interval would count in four
 * phases, so one kill would read 5 on two tiles and 4 on two others.
 */
describe("the kill countdown on a tile", () => {
  // Scoped to this suite: everything above runs on real timers.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on the whole window, so the first thing read is how long there is", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const m = mount({ killing: true, until: 1_700_000_008_000 });
    expect(countdown(m.header)?.textContent).toBe("8");
  });

  it("counts down on the sidebar's tick, and runs no clock of its own", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const [tick, setTick] = createSignal(0);
    const m = mount({ killing: true, until: 1_700_000_008_000, tick });
    expect(countdown(m.header)?.textContent).toBe("8");

    // Three seconds of clock AND every timer that wanted to fire inside them. A
    // header with an interval of its own would have re-read the clock here and
    // redrawn 5; this one has nothing to fire, so the strip still says 8.
    vi.advanceTimersByTime(3000);
    expect(countdown(m.header)?.textContent).toBe("8");

    // The tick the sidebar was already sending is the whole clock.
    setTick(3);
    expect(countdown(m.header)?.textContent).toBe("5");

    // Rounded UP: 2.5s left reads "3". A strip that said 2 with two and a half
    // seconds to go would be lying in the direction that costs someone a
    // session they were still deciding about.
    vi.setSystemTime(new Date(1_700_000_005_500));
    setTick(5);
    expect(countdown(m.header)?.textContent).toBe("3");
  });

  it("never shows a zero or a negative, however late the last tick lands", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const [tick, setTick] = createSignal(0);
    const m = mount({ killing: true, until: 1_700_000_008_000, tick });

    // The deadline has passed and this tile has not been told yet: the store
    // clears `killing` from a timer of its own, and a tick can land first. A 0
    // sitting on the strip reads as a countdown that stalled.
    vi.setSystemTime(new Date(1_700_000_009_000));
    setTick(9);
    expect(countdown(m.header)).toBeNull();
    // The way back is still drawn, because the store still says killing.
    expect(undoArrow(m.header)).not.toBeNull();
  });

  it("is absent when nothing is being killed", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    expect(countdown(mount({ until: 1_700_000_008_000 }).header)).toBeNull();
  });

  // A live number in the accessible tree announces itself every second, and a
  // workspace can have four of these strips. The arrow beside it carries the one
  // label worth reading, and that label does not change as the clock runs.
  it("stays out of the accessible tree, so nothing announces every second", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const [tick, setTick] = createSignal(0);
    const m = mount({ killing: true, until: 1_700_000_008_000, tick });
    expect(countdown(m.header)!.getAttribute("aria-hidden")).toBe("true");

    const label = undoArrow(m.header)!.getAttribute("aria-label");
    vi.setSystemTime(new Date(1_700_000_003_000));
    setTick(3);
    expect(countdown(m.header)?.textContent).toBe("5");
    expect(undoArrow(m.header)!.getAttribute("aria-label")).toBe(label);
  });
});

// --- The half that is CSS ----------------------------------------------------
//
// jsdom applies no external stylesheet and runs no layout, so nothing above can
// see how loud the focused header reads. These assert the rules themselves.

const css = readFileSync(resolve(process.cwd(), "src/tiles.css"), "utf8");

/**
 * Every top-level rule body whose selector is exactly `selector`, joined.
 *
 * Every one, not the first: the focused treatment is written as an ADDITION to
 * the rule that sets its border and text colour rather than as a rewrite of it,
 * and what a reader gets is the union the cascade computes.
 */
function ruleBodies(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) out.push(m[2]!);
  }
  if (out.length === 0) throw new Error(`no rule for ${selector}`);
  return out.join("\n");
}

/**
 * Viktor, 2026-09-13: *"the pane title is too smal to be readable. we need to
 * make it more easy to know what each session is about"*.
 *
 * The strip is the ONLY thing naming a tile and four of them are on screen at
 * once, so these numbers are the feature rather than decoration. Asserted
 * against the stylesheet because jsdom applies none and lays nothing out.
 */
describe("a strip sized to be read", () => {
  const header = ruleBodies(".tl-tile-header");

  it("is tall enough and set large enough to read at a glance", () => {
    expect(header).toMatch(/--tl-tile-header-h:\s*30px/);
    expect(header).toMatch(/font-size:\s*calc\(14px \*/);
  });

  // The complaint's other half. The title used to inherit the strip's muted
  // colour and only went primary when the tile was focused, so in a 2x2 three
  // of the four titles were the hard-to-read ones. Focus is carried by the
  // accent underline and the wash instead.
  it("sets the title in the primary colour whether the tile is focused or not", () => {
    expect(ruleBodies(".tl-tile-title")).toMatch(/color:\s*var\(--text-primary\)/);
  });

  // The box takes the title's own box, so the strip does not jump when it opens.
  it("gives the rename box the title's place in the strip", () => {
    const rename = ruleBodies(".tl-tile-rename");
    expect(rename).toMatch(/flex:\s*1 1 auto/);
    expect(ruleBodies(".tl-tile-title")).toMatch(/flex:\s*1 1 auto/);
    expect(rename).toMatch(/font:\s*inherit/);
  });
});

describe("the focused header, as it is painted", () => {
  const focused = ruleBodies(".tl-tile-header[data-focused]");

  // "Where do my keystrokes go" is the question this answers, and in a 2x2 of
  // live terminals a 1px line under one 24px strip is not an answer. The wash
  // is what carries it across the screen.
  it("washes the whole strip in the accent, not just its border", () => {
    expect(focused).toMatch(/(^|[\s;])background:/);
    expect(focused).toMatch(/var\(--accent\)/);
  });

  it("weights the focused title, the vocabulary the sidebar's active row uses", () => {
    expect(ruleBodies(".tl-tile-header[data-focused] .tl-tile-title")).toMatch(
      /font-weight:\s*[67]00/,
    );
  });

  // A marker that vanished into the muted text beside it would be a mark nobody
  // sees, and this one is the difference between a tile that types and one that
  // cannot.
  it("gives the watch marker a rule of its own", () => {
    expect(ruleBodies(".tl-tile-watch")).toMatch(/flex:/);
  });
});

/**
 * The kill window's other half, which is a stylesheet rather than a DOM
 * contract.
 *
 * What FADES decides whether the way back is still readable, and a small number
 * at 0.45 on a 24px strip is the first thing to become unreadable at a glance —
 * the one moment it matters. jsdom applies no external CSS, so these read
 * src/tiles.css the way the focused rules above are read.
 */
describe("the dying header, as it is painted", () => {
  /**
   * The value of one declaration in a rule body, or null. `min-width` cannot be
   * mistaken for `width`: the character before it is `-`, which is neither the
   * start of a line nor a `;`.
   */
  const decl = (body: string, prop: string): string | null => {
    const m = new RegExp(`(?:^|;|\\n)\\s*${prop}:\\s*([^;]+)`).exec(body);
    return m ? m[1]!.trim() : null;
  };

  it("tints the strip in the danger colour, at the 10% the sidebar row takes", () => {
    const killing = ruleBodies(".tl-tile-header[data-killing]");
    expect(killing).toMatch(/(^|[\s;])background:/);
    expect(killing).toMatch(/var\(--danger\)\s+10%/);
  });

  // `opacity` on the header itself would take the arrow down with it: opacity
  // makes a group, and no child climbs back out of one. So the fade is on the
  // children, minus the two that are the way out.
  it("fades the strip without taking the way out down with it", () => {
    const sel = ".tl-tile-header[data-killing] > *:not(.tl-tile-undo, .tl-tile-countdown)";
    expect(css).toContain(sel);
    expect(ruleBodies(sel)).toMatch(/opacity:\s*0?\.45/);
  });

  it("strikes the title through, because a dim strip alone reads as disabled", () => {
    expect(ruleBodies(".tl-tile-header[data-killing] .tl-tile-title")).toMatch(
      /text-decoration:\s*line-through/,
    );
  });

  // The digits are different widths in a proportional face, and a number that
  // shifts sideways every second reads as the layout settling rather than as a
  // clock running down.
  it("holds the digits to one width, and colours them as the half that says it is going", () => {
    const counter = ruleBodies(".tl-tile-countdown");
    expect(counter).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(counter).toMatch(/color:\s*var\(--danger\)/);
  });

  // The two are one slot at two moments. An arrow a pixel larger than the ✕
  // would shift the title beside it every time a kill started, and this strip is
  // 24px taken out of four live terminals' rows — it does not get to grow for a
  // control that is only there for eight seconds.
  it("gives the arrow the close control's exact box, since it stands in its slot", () => {
    const arrow = ruleBodies(".tl-tile-undo");
    const close = ruleBodies(".tl-tile-close");
    expect(decl(arrow, "width")).toBe(decl(close, "width"));
    expect(decl(arrow, "height")).toBe(decl(close, "height"));
    expect(decl(arrow, "width")).toBe("18px");
  });

  // A tile can be the focused one AND the dying one. Both selectors are one
  // class plus one attribute, so they weigh the same and the later rule paints:
  // the danger tint replaces the accent wash, and the accent underline — ~5:1,
  // against the wash's 1.19:1 — goes on saying where the keystrokes are going.
  // Written the other way round, a dying tile would paint as an ordinary
  // focused one.
  it("paints the tint over the focus wash on a tile that is both", () => {
    expect(css.lastIndexOf(".tl-tile-header[data-killing] {")).toBeGreaterThan(
      css.lastIndexOf(".tl-tile-header[data-focused] {"),
    );
  });
});
