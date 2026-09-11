/**
 * The card of a session on its way out, and the arrow that takes the kill back.
 *
 * A kill sends nothing for eight seconds (store/lobby.ts GRACE_MS). That window
 * is what replaced the `Kill session "x"?` confirm on every entry point, and it
 * only works if the row it is about SAYS SO: a card that vanished on the press
 * would leave the person with a window they cannot see and an undo they have no
 * reason to reach for. So the row keeps its seat, fades, strikes its title
 * through, and grows an arrow.
 *
 * THE ARROW IS THE PHONE'S WHOLE UNDO. There is no Cmd+Z on a touch screen and
 * no confirm in front of the right-swipe any more, so this button is the only
 * way back from a swipe nobody meant. It presses THIS card's kill through
 * `store.takeBackKill`, which finds that kill's own entry on the stack rather
 * than taking whatever is on top of it (store/lobby.ts; test/undo.kill.test.ts
 * drives the store end of it).
 *
 * Rendering is asserted here. What fades, and how big the target is under a
 * finger, are asserted against the stylesheet at the bottom instead, for the
 * reason test/card.longpress.css.test.ts gives: jsdom does no layout and
 * evaluates no media query.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionCard } from "../src/components/SessionCard";
import { toasts } from "../src/store/toast";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";
import type { UndoResult } from "../src/store/undo";

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  attached: 0,
  lastActivity: 0,
  created: 0,
  ...over,
});

interface Mounted {
  container: HTMLElement;
  select: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  takeBackKill: ReturnType<typeof vi.fn>;
}

/**
 * One card, with the two store members this file is about: `killing`, which the
 * row reads to decide it is going away, and `takeBackKill`, which the arrow
 * presses. The store owns both, and what `takeBackKill` does with the stack is
 * its business rather than the card's (store/lobby.ts).
 */
function mount(
  o: {
    killing?: boolean;
    answer?: UndoResult;
    /** The instant the kill lands, as store/lobby.ts `killingUntil` reports it. */
    until?: number;
    /** The sidebar's 1Hz tick, so a case can step the countdown by hand. */
    tick?: () => number;
  } = {},
): Mounted {
  const select = vi.fn();
  const kill = vi.fn(async () => {});
  const takeBackKill = vi.fn(async (): Promise<UndoResult> => o.answer ?? { ok: true });
  const store = {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard" }),
    workingSince: () => undefined,
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => o.killing ?? false,
    killingUntil: () => o.until,
    select,
    kill,
    takeBackKill,
  } as unknown as LobbyStore;
  const { container } = render(() => (
    <SessionCard store={store} session={session()} groupName="" tick={o.tick ?? (() => 0)} />
  ));
  return { container, select, kill, takeBackKill };
}

const card = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-card")!;
const arrow = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("button.tl-card-undo");
const dots = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("button.tl-card-actions");

/**
 * One finger down, across to the right and up: the gesture that kills.
 *
 * Two moves is enough: the row settles the axis on the first 10px and decides
 * the rest on distance alone. test/SessionCard.swipe.test.tsx drives the full
 * classifier; this only needs a swipe that would land (SWIPE_MIN_PX is 64).
 */
function swipeRight(el: Element): void {
  const at = (type: string, dx: number) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 300 + dx,
        clientY: 200,
        pointerType: "touch",
      }),
    );
  at("pointerdown", 0);
  at("pointermove", 70);
  at("pointermove", 140);
  at("pointerup", 140);
}

beforeEach(() => {
  toasts.clear();
});

describe("<SessionCard> — a session inside its kill window", () => {
  it("marks the row, so the dim and the strike-through have something to hang on", () => {
    const { container } = mount({ killing: true });
    expect(card(container).hasAttribute("data-killing")).toBe(true);
  });

  it("renders exactly as it always did when nothing is being killed", () => {
    const { container } = mount({ killing: false });
    expect(card(container).hasAttribute("data-killing")).toBe(false);
    expect(arrow(container)).toBeNull();
    expect(dots(container)).not.toBeNull();
  });

  it("offers an arrow that says what it undoes", () => {
    const { container } = mount({ killing: true });
    expect(arrow(container)).not.toBeNull();
    expect(arrow(container)!.getAttribute("aria-label")).toBe("Undo kill");
  });

  it("is a real button, so a keyboard reaches it", () => {
    const { container } = mount({ killing: true });
    // Not a div with a click handler: tab order, Enter and Space all come free
    // from the element, and every one of them is how this gets pressed without
    // a mouse.
    expect(arrow(container)!.tagName).toBe("BUTTON");
    expect(arrow(container)!.hasAttribute("disabled")).toBe(false);
  });

  it("takes back THIS session's kill when the arrow is clicked", async () => {
    // By name, not by "the last thing that happened". Anything can land on the
    // stack during the eight seconds — a group collapsing, another card's
    // rename, a second kill — and the arrow on this card must reach this
    // card's kill through all of it (store/lobby.ts takeBackKill).
    const { container, takeBackKill } = mount({ killing: true });

    arrow(container)!.click();

    await waitFor(() => expect(takeBackKill).toHaveBeenCalledTimes(1));
    expect(takeBackKill).toHaveBeenCalledWith("main");
  });

  /**
   * The click bubbles, and the row's own handler runs after this one. By then
   * the retraction has already flipped `killing` back to false, so without a
   * stopPropagation the press that rescued the session would also open it.
   */
  it("does not open the session on the way to the arrow", async () => {
    const { container, select } = mount({ killing: true });

    arrow(container)!.click();

    await new Promise((r) => setTimeout(r, 0));
    expect(select).not.toHaveBeenCalled();
  });

  it("says nothing when the undo works", async () => {
    const { container } = mount({ killing: true });

    arrow(container)!.click();

    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.toasts()).toEqual([]);
  });

  /**
   * The store never toasts. The caller does (store/undo.ts UndoResult), and on
   * this path the caller is the card. A refusal that said nothing would look
   * exactly like a button that does not work.
   */
  it("says why when the store refuses, under a lead-in", async () => {
    // The sentence is written lower case to read after one (store/undo.ts
    // UndoHandler.check), and the two affordances that show it — this arrow
    // and the chord's toast in keybindings/commands.ts — build the same
    // prefix, so one string cannot read two ways.
    const answer: UndoResult = { ok: false, reason: "that session is already gone" };
    const { container } = mount({ killing: true, answer });

    arrow(container)!.click();

    await waitFor(() =>
      expect(toasts.toasts().map((t) => t.message)).toEqual([
        "Can't undo: that session is already gone",
      ]),
    );
  });

  /** `reason: null` is the store's silent no-op: nothing of this kill to take
   *  back, which is what a press racing the timer gets. */
  it("stays silent when the refusal has nothing to say", async () => {
    const { container } = mount({ killing: true, answer: { ok: false, reason: null } });

    arrow(container)!.click();

    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.toasts()).toEqual([]);
  });

  it("draws the arrow whenever the window is running, stack or no stack", () => {
    // Including a lens tab (`?as=bob`), which runs with undo off. Retracting a
    // kill that has sent nothing needs no history to do it, and that tab is
    // the one where the session belongs to somebody else.
    const { container } = mount({ killing: true });
    expect(arrow(container)).not.toBeNull();
    expect(card(container).hasAttribute("data-killing")).toBe(true);
  });

  it("hides the ⋯ menu, since nothing in it applies to a session that is leaving", () => {
    const { container } = mount({ killing: true });
    expect(dots(container)).toBeNull();
  });

  it("does not open the session when the row is clicked", async () => {
    const { container, select } = mount({ killing: true });

    card(container).click();

    await new Promise((r) => setTimeout(r, 0));
    expect(select).not.toHaveBeenCalled();
  });

  it("still opens the session when the row is clicked and nothing is dying", async () => {
    const { container, select } = mount({ killing: false });

    card(container).click();

    await waitFor(() => expect(select).toHaveBeenCalledWith("main", undefined));
  });

  it("does not open the session on Enter either", async () => {
    const { container, select } = mount({ killing: true });

    card(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));
    expect(select).not.toHaveBeenCalled();
  });

  /**
   * A right swipe kills, and a card already inside its window has nothing left
   * to kill: a second press would either open a window on top of a window or,
   * once the first one lands, kill the session the arrow was still offering to
   * bring back.
   */
  it("is inert to a swipe", () => {
    const { container, kill } = mount({ killing: true });

    swipeRight(card(container));

    expect(kill).not.toHaveBeenCalled();
  });

  it("still kills on a right swipe when it is not already dying", () => {
    const { container, kill } = mount({ killing: false });

    swipeRight(card(container));

    expect(kill).toHaveBeenCalledWith("main");
  });
});

/**
 * The countdown beside the arrow.
 *
 * The dim and the strike say a row is leaving. They cannot say how long is
 * left, and eight seconds is short enough that the difference between "plenty
 * of time" and "about to go" is the whole decision. So the row counts the
 * seconds down.
 *
 * The number is computed here, not published by the store: the store hands out
 * the DEADLINE (`killingUntil`) and the sidebar's existing 1Hz tick is what
 * makes this re-read it, so no second timer exists and nothing has to be
 * pushed every second.
 */
describe("<SessionCard> — the kill countdown", () => {
  // Scoped to this suite: the swipe cases above run on real timers.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const counter = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-card-countdown");

  it("opens on the whole window, so the first thing read is how long there is", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { container } = mount({ killing: true, until: 1_700_000_008_000 });
    expect(counter(container)?.textContent).toBe("8");
  });

  it("counts down as the tick advances", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const [tick, setTick] = createSignal(0);
    const { container } = mount({ killing: true, until: 1_700_000_008_000, tick });
    expect(counter(container)?.textContent).toBe("8");

    // A second of wall clock plus the tick that tells the row to look again.
    // Both are needed, and that is the point: the tick alone would re-render
    // the same number, and the clock alone would move nothing on screen.
    vi.setSystemTime(new Date(1_700_000_001_000));
    setTick(1);
    expect(counter(container)?.textContent).toBe("7");

    vi.setSystemTime(new Date(1_700_000_005_500));
    setTick(5);
    // Rounded UP: 2.5s left reads "3", because a row that says 2 with two and a
    // half seconds to go is lying in the direction that costs someone a session.
    expect(counter(container)?.textContent).toBe("3");
  });

  it("never shows a zero or a negative, however late the last tick lands", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const [tick, setTick] = createSignal(0);
    const { container } = mount({ killing: true, until: 1_700_000_008_000, tick });

    // The deadline has passed but this row has not been told yet: the store
    // clears `killing` from a timer, and a tick can land first.
    vi.setSystemTime(new Date(1_700_000_009_000));
    setTick(9);
    expect(counter(container)).toBeNull();
  });

  it("is absent when nothing is being killed", () => {
    const { container } = mount();
    expect(counter(container)).toBeNull();
  });

  it("is absent when a kill has no deadline, rather than rendering a guess", () => {
    // A store that reports `killing` and no deadline is the shape an older
    // build had. The row still dims and still offers the arrow; it just has no
    // number to show.
    const { container } = mount({ killing: true });
    expect(counter(container)).toBeNull();
    expect(arrow(container)).not.toBeNull();
  });

  it("stays out of the accessible name, so nothing announces every second", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { container } = mount({ killing: true, until: 1_700_000_008_000 });
    expect(counter(container)!.getAttribute("aria-hidden")).toBe("true");
    // The arrow keeps the one label a screen reader should read, unchanged by
    // the clock.
    expect(arrow(container)!.getAttribute("aria-label")).toBe("Undo kill");
  });
});

/**
 * The two halves that live in the stylesheet. Both are behaviour rather than
 * decoration: what fades decides whether the way out is still readable, and the
 * target size decides whether a thumb can hit it at all.
 */
describe("the killing card, in sidebar.css", () => {
  const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

  /** The declarations of the first rule whose selector ends `selector`. */
  const body = (selector: string, within = css): string => {
    const start = within.indexOf(selector + " {");
    expect(start, `${selector} in sidebar.css`).toBeGreaterThan(-1);
    return within.slice(start, within.indexOf("}", start));
  };

  /**
   * The `(pointer: coarse)` block that sizes the card's controls.
   *
   * Brace-matched, and picked by content: the file carries more than one such
   * query, so a rule found by searching forward from the first `@media` line
   * might sit outside every one of them.
   */
  const coarseBlock = (): string => {
    for (const m of css.matchAll(/@media \(pointer: coarse\) \{/g)) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          const inner = css.slice(open, i);
          if (inner.includes(".tl-card-undo")) return inner;
          break;
        }
      }
    }
    throw new Error("no (pointer: coarse) block sizes .tl-card-undo");
  };

  it("fades the row without taking the way out down with it", () => {
    // opacity makes a group, so a child cannot climb back out of a faded
    // parent: the fade has to skip the arrow rather than undo itself on it.
    // The countdown is exempt for the same reason — it is the half of the pair
    // that says how long there is, and it is unreadable first.
    expect(css).toContain(".tl-card[data-killing] > *:not(.tl-card-undo, .tl-card-countdown)");
    expect(body(".tl-card[data-killing]::before")).toMatch(/opacity:\s*0?\.\d+/);
  });

  it("holds the digits to one width, so the row does not jog as it counts", () => {
    // 8 and 7 are different widths in a proportional face, and a number that
    // shifts every second reads as the layout settling rather than a clock.
    expect(body(".tl-card-countdown")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("strikes the title through, because a dim row alone reads as disabled", () => {
    expect(body(".tl-card[data-killing] .tl-card-name")).toMatch(/text-decoration:\s*line-through/);
  });

  it("keeps the arrow visible without a hover, which a phone never sends", () => {
    expect(body(".tl-card-undo")).not.toMatch(/opacity:\s*0\b/);
  });

  it("gives a finger a 44px target", () => {
    // Past the 40px floor the rest of the block keeps, and it fits: the row is
    // 48px under the same query, so this target is smaller than its own row.
    const rule = body(".tl-card-undo", coarseBlock());
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
  });
});
