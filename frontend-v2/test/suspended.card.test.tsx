import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { stateLabel } from "../src/components/lobby.logic";
import { StateDot } from "../src/components/StateDot";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * A session nobody has driven for 72 hours is SUSPENDED: tmux-api killed its
 * claude process to get the ~800MB back, the tmux session stays in the list
 * with its scrollback frozen, and clicking the row runs `claude --resume`.
 *
 * The row has to say both things at once. The dot is the precise signal — a
 * fourth state beside running/awaiting/done — and the whole row dims, which is
 * what reads at a glance down a sidebar of forty. Dimmed is not disabled: the
 * row is the way back in, so its last-active number stays on it and its
 * contrast stays readable.
 *
 * A resume costs ~800MB, so only a CLICK may spend it. Hover must not: the
 * preload hover (ADR-0026) crosses every row between the pointer and its
 * target, and waking each one on the way past is the failure this guards.
 */

const session = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 0,
  created: 0,
  ...over,
});

const suspended = (name = "a", over: Partial<Session> = {}): Session =>
  session(name, { state: "suspended", suspendedAt: 1_700_000_000, ...over });

/** Only the members the card's render and activation paths read. */
function cardStore(over: Partial<LobbyStore> = {}): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard", realUser: "wizard" }),
    hold: () => () => {},
    workingSince: () => null,
    lastDriven: () => null,
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
    select: () => {},
    resume: async () => true,
    ...over,
  } as unknown as LobbyStore;
}

function renderCard(s: Session, store: LobbyStore = cardStore(), showLastActive = true) {
  return render(() => (
    <SessionCard
      store={store}
      session={s}
      groupName=""
      tick={() => 0}
      isUnseen={() => false}
      showLastActive={() => showLastActive}
    />
  ));
}

describe("<StateDot> — the fourth state", () => {
  it("renders the suspended class, like every other state", () => {
    const { container, unmount } = render(() => <StateDot state="suspended" />);
    expect(container.querySelector(".tl-state-dot.tl-state-suspended")).not.toBeNull();
    unmount();
  });

  it("says suspended in words, for a tooltip and a screen reader", () => {
    // The dot is a coloured mark. Colour alone cannot carry a state, so the
    // same sentence has to reach a screen reader.
    const { container, unmount } = render(() => <StateDot state="suspended" />);
    const dot = container.querySelector(".tl-state-dot");
    expect(dot?.getAttribute("aria-label")).toBe(stateLabel("suspended"));
    expect(stateLabel("suspended")).toContain("Suspended");
    unmount();
  });
});

describe("<SessionCard> — a suspended row", () => {
  it("dims the whole row", () => {
    const { container, unmount } = renderCard(suspended());
    expect(container.querySelector(".tl-card")?.classList.contains("tl-card-suspended")).toBe(true);
    unmount();
  });

  it("leaves a live row undimmed", () => {
    const { container, unmount } = renderCard(session("a", { state: "done" }));
    expect(container.querySelector(".tl-card")?.classList.contains("tl-card-suspended")).toBe(
      false,
    );
    unmount();
  });

  it("carries the fourth state's dot", () => {
    const { container, unmount } = renderCard(suspended());
    expect(container.querySelector(".tl-state-suspended")).not.toBeNull();
    unmount();
  });

  it("says suspended in the row's own aria-label", () => {
    const { container, unmount } = renderCard(suspended());
    expect(container.querySelector(".tl-card")?.getAttribute("aria-label")).toContain("Suspended");
    unmount();
  });

  it("keeps showing how long ago it was driven", () => {
    // The whole point of the row staying in the list: a suspended session is
    // found by the same number a live one is found by. `relativeTime` of a
    // three-day-old stamp is what the corner reads.
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const { container, unmount } = renderCard(suspended("a", { lastDrive: threeDaysAgo }));
    expect(container.querySelector(".tl-card-time")?.textContent).toBe("3d ago");
    unmount();
  });
});

describe("<SessionCard> — resuming", () => {
  it("resumes before selecting, when the row is suspended", async () => {
    const order: string[] = [];
    const store = cardStore({
      resume: vi.fn(async (name: string) => {
        order.push("resume:" + name);
      }) as unknown as LobbyStore["resume"],
      select: vi.fn((name: string) => {
        order.push("select:" + name);
      }) as unknown as LobbyStore["select"],
    });
    const { container, unmount } = renderCard(suspended("a"), store);
    fireEvent.click(container.querySelector(".tl-card")!);
    expect(order).toEqual(["resume:a", "select:a"]);
    unmount();
  });

  it("spends nothing on a live row", () => {
    const resume = vi.fn(async () => true);
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(session("a", { state: "done" }), store);
    fireEvent.click(container.querySelector(".tl-card")!);
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });

  it("does not resume on hover", () => {
    // A pointer crossing the sidebar must not wake every session it passes.
    const resume = vi.fn(async () => true);
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(suspended("a"), store);
    fireEvent.pointerEnter(container.querySelector(".tl-card")!);
    fireEvent.pointerLeave(container.querySelector(".tl-card")!);
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });

  it("asks once however many times the row is clicked", async () => {
    // The poll is 5s behind, so the row stays marked suspended for several
    // clicks' worth of time after the first one landed.
    const resume = vi.fn(async () => true);
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(suspended("a"), store);
    const card = container.querySelector(".tl-card")!;
    fireEvent.click(card);
    fireEvent.click(card);
    fireEvent.click(card);
    expect(resume).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("lets the next click try again when the resume was refused", async () => {
    // The row stays marked suspended whether the resume is in flight or
    // failed, so a flag the poll alone could clear would latch on: tmux-api
    // answers 500 for a transcript that went away between the sweep and the
    // click, and 502 while it restarts. Every click after that would send
    // nothing, with no toast to say why, until the page was reloaded.
    const resume = vi.fn(async () => false);
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(suspended("a"), store);
    const card = container.querySelector(".tl-card")!;
    fireEvent.click(card);
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(card);
    expect(resume).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("still asks only once while a resume is in flight", async () => {
    // Not cleared on settle: the request resolves when respawn-pane was
    // issued, seconds before claude has loaded, so a second click inside that
    // window would respawn over the claude the first one just started.
    let settle: (ok: boolean) => void = () => {};
    const resume = vi.fn(() => new Promise<boolean>((r) => (settle = r)));
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(suspended("a"), store);
    const card = container.querySelector(".tl-card")!;
    fireEvent.click(card);
    settle(true);
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(card);
    expect(resume).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("resumes from the keyboard too", () => {
    const resume = vi.fn(async () => true);
    const store = cardStore({ resume: resume as unknown as LobbyStore["resume"] });
    const { container, unmount } = renderCard(suspended("a"), store);
    fireEvent.keyDown(container.querySelector(".tl-card")!, { key: "Enter" });
    expect(resume).toHaveBeenCalledWith("a");
    unmount();
  });
});
