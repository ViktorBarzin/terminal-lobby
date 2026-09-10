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
 * way back from a swipe nobody meant. It presses the tab's stack
 * (store/undo.ts), the same thing the chord presses, rather than retracting
 * this one card's kill: the entry has to come off the stack, or a later Cmd+Z
 * would undo a kill that was already taken back (store/undo.kill.ts).
 *
 * Rendering is asserted here. What fades, and how big the target is under a
 * finger, are asserted against the stylesheet at the bottom instead, for the
 * reason test/card.longpress.css.test.ts gives: jsdom does no layout and
 * evaluates no media query.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionCard } from "../src/components/SessionCard";
import { toasts } from "../src/store/toast";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";
import type { UndoResult, UndoStore } from "../src/store/undo";

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  attached: 0,
  lastActivity: 0,
  created: 0,
  ...over,
});

/** A stack that accepts every press. Overridden per case. */
function stubStack(over: Partial<UndoStore> = {}): UndoStore {
  return {
    push: () => {},
    undo: async (): Promise<UndoResult> => ({ ok: true }),
    redo: async (): Promise<UndoResult> => ({ ok: true }),
    canUndo: () => true,
    canRedo: () => false,
    clear: () => {},
    carry: () => {},
    ...over,
  };
}

interface Mounted {
  container: HTMLElement;
  select: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

/**
 * One card, with the two store members this file is about: `killing`, which the
 * row reads to decide it is going away, and `undo`, this tab's stack. App owns
 * the one instance and hands it to the store, which is how a component that
 * holds a store reaches it (store/lobby.ts LobbyStore.undo).
 *
 * `stack: undefined` is a real state and not an omission: a page with no undo
 * at all, which is what a lens tab (`?as=bob`) has.
 */
function mount(o: { killing?: boolean; stack?: UndoStore } = {}): Mounted {
  const select = vi.fn();
  const kill = vi.fn(async () => {});
  const store = {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard" }),
    workingSince: () => undefined,
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => o.killing ?? false,
    undo: "stack" in o ? o.stack : stubStack(),
    select,
    kill,
  } as unknown as LobbyStore;
  const { container } = render(() => (
    <SessionCard store={store} session={session()} groupName="" tick={() => 0} />
  ));
  return { container, select, kill };
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

  it("presses this tab's stack when the arrow is clicked", async () => {
    const undo = vi.fn(async (): Promise<UndoResult> => ({ ok: true }));
    const { container } = mount({ killing: true, stack: stubStack({ undo }) });

    arrow(container)!.click();

    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
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
  it("says why when the stack refuses", async () => {
    const stack = stubStack({
      undo: async (): Promise<UndoResult> => ({ ok: false, reason: "that session is already gone" }),
    });
    const { container } = mount({ killing: true, stack });

    arrow(container)!.click();

    await waitFor(() =>
      expect(toasts.toasts().map((t) => t.message)).toEqual(["that session is already gone"]),
    );
  });

  /** `reason: null` is the store's silent no-op: an empty stack, or a lens tab. */
  it("stays silent when the refusal has nothing to say", async () => {
    const stack = stubStack({ undo: async (): Promise<UndoResult> => ({ ok: false, reason: null }) });
    const { container } = mount({ killing: true, stack });

    arrow(container)!.click();

    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.toasts()).toEqual([]);
  });

  it("draws no arrow on a page that has no undo at all", () => {
    // A lens tab (`?as=bob`), and today also an App that has not wired a stack.
    // An arrow that did nothing would be worse than the dim on its own.
    const { container } = mount({ killing: true, stack: undefined });
    expect(arrow(container)).toBeNull();
    expect(card(container).hasAttribute("data-killing")).toBe(true);
  });

  it("draws no arrow when there is nothing on the stack to press", () => {
    const { container } = mount({ killing: true, stack: stubStack({ canUndo: () => false }) });
    expect(arrow(container)).toBeNull();
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
    expect(css).toContain(".tl-card[data-killing] > *:not(.tl-card-undo)");
    expect(body(".tl-card[data-killing]::before")).toMatch(/opacity:\s*0?\.\d+/);
  });

  it("strikes the title through, because a dim row alone reads as disabled", () => {
    expect(body(".tl-card[data-killing] .tl-card-name")).toMatch(
      /text-decoration:\s*line-through/,
    );
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
