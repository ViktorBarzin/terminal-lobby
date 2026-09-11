/**
 * The rules for what a hover is allowed to attach before the click.
 *
 * Every case here drives its own clock and its own scheduler, so the suite
 * never waits 250 ms for a dwell or 60 s for a TTL. The two values that do the
 * deciding (ADR-0026: starting values, not measurements) are pinned below, so
 * changing one is a deliberate edit to a test rather than a silent drift.
 *
 * The case that is easiest to get wrong is the one about leaving: a preload
 * that has LANDED survives the pointer leaving, because hover, glance away,
 * click is a common mouse path, and one that is still IN FLIGHT does not.
 */
import { describe, it, expect } from "vitest";
import {
  createPreloadStore,
  DWELL_MS,
  SLOT_TTL_MS,
  type PreloadStore,
  type Schedule,
} from "../src/store/preload";
import type { Selected } from "../src/store/keepalive";

const T0 = 1_700_000_000_000;
const ME = "wizard";

const alpha: Selected = { name: "alpha" };
const beta: Selected = { name: "beta" };

/**
 * A clock and a scheduler the test drives. `advance` fires everything due
 * inside the window in due order, including timers scheduled while it runs, so
 * a dwell that fills the slot and starts a TTL behaves as it would in a tab.
 */
function fakeTime(start = T0) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const schedule: Schedule = (fn, ms) => {
    const id = seq++;
    timers.set(id, { at: t + ms, fn });
    return () => {
      timers.delete(id);
    };
  };
  function advance(ms: number): void {
    const until = t + ms;
    for (;;) {
      let dueId = -1;
      let due: { at: number; fn: () => void } | undefined;
      for (const [id, timer] of timers) {
        if (timer.at <= until && (due === undefined || timer.at < due.at)) {
          dueId = id;
          due = timer;
        }
      }
      if (due === undefined) break;
      timers.delete(dueId);
      t = due.at;
      due.fn();
    }
    t = until;
  }
  return { now: () => t, schedule, advance, pending: () => timers.size };
}

interface Harness {
  store: PreloadStore;
  advance(ms: number): void;
  now(): number;
  setCoarse(on: boolean): void;
  /** session names the lobby already has mounted or selected. */
  open: Set<string>;
  /** timers still armed — a leaked dwell shows up here. */
  pending(): number;
}

function harness(opts: { coarse?: boolean; open?: string[]; me?: string } = {}): Harness {
  const time = fakeTime();
  let coarse = opts.coarse ?? false;
  const open = new Set(opts.open ?? []);
  const store = createPreloadStore({
    isCoarsePointer: () => coarse,
    alreadyOpen: (sel) => open.has(sel.name),
    me: () => opts.me ?? ME,
    now: time.now,
    schedule: time.schedule,
  });
  return {
    store,
    advance: time.advance,
    now: time.now,
    setCoarse: (on) => {
      coarse = on;
    },
    open,
    pending: time.pending,
  };
}

/** Rest the pointer on a card long enough to fill the slot. */
function dwellOn(h: Harness, sel: Selected): void {
  h.store.hoverEnter(sel);
  h.advance(DWELL_MS);
}

describe("the dwell", () => {
  it("uses the values ADR-0026 decided", () => {
    expect(DWELL_MS).toBe(250);
    expect(SLOT_TTL_MS).toBe(60_000);
  });

  it("sends nothing when the pointer leaves before the dwell expires", () => {
    const h = harness();
    h.store.hoverEnter(alpha);
    h.advance(DWELL_MS - 1);
    h.store.hoverLeave(alpha);
    h.advance(10_000);
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0);
  });

  it("fills the slot when the pointer rests for the whole dwell", () => {
    const h = harness();
    dwellOn(h, alpha);
    expect(h.store.preloaded()?.name).toBe("alpha");
    expect(h.store.preloaded()?.filledAt).toBe(T0 + DWELL_MS);
  });

  it("is cancelled by a click on the same card, so nothing speculative goes out", () => {
    const h = harness();
    h.store.hoverEnter(alpha);
    h.advance(DWELL_MS - 100);
    expect(h.store.select(alpha)).toBe(false); // nothing to promote yet
    h.advance(10_000);
    expect(h.store.preloaded()).toBeNull();
  });

  it("re-checks eligibility at expiry, not only when the pointer arrives", () => {
    const h = harness();
    h.store.hoverEnter(alpha);
    h.open.add("alpha"); // the user opened it in the 250 ms
    h.advance(DWELL_MS);
    expect(h.store.preloaded()).toBeNull();
  });
});

describe("the one slot", () => {
  it("keeps the slot object IDENTICAL while one session holds it", () => {
    // The wiring hangs a hidden terminal off this value. A new object for the
    // same session would tear that terminal down and rebuild it, which is the
    // 627 ms the preload exists to avoid.
    const h = harness();
    dwellOn(h, alpha);
    const first = h.store.preloaded();
    h.store.markLanded(alpha);
    h.store.hoverLeave(alpha);
    h.store.hoverEnter(alpha);
    h.advance(DWELL_MS);
    expect(h.store.preloaded()).toBe(first);
  });

  it("is replaced by the next hover that reaches its dwell", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    dwellOn(h, beta);
    expect(h.store.preloaded()?.name).toBe("beta");
  });

  it("still holds the first card while the second is only dwelling", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.store.hoverLeave(alpha);
    h.store.hoverEnter(beta);
    h.advance(DWELL_MS - 1);
    expect(h.store.preloaded()?.name).toBe("alpha");
  });

  it("keeps a LANDED preload when the pointer leaves", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.store.hoverLeave(alpha);
    expect(h.store.preloaded()?.name).toBe("alpha");
  });

  it("aborts a preload still IN FLIGHT when the pointer leaves", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.hoverLeave(alpha);
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0); // the TTL went with it
  });

  it("drops a preload whose attach failed, and takes its TTL with it", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markFailed(alpha);
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0);
    h.advance(SLOT_TTL_MS * 2); // and nothing fires later on a slot that is gone
    expect(h.store.preloaded()).toBeNull();
  });

  it("drops a preload that FAILED AFTER IT LANDED, unlike the pointer leaving", () => {
    // The asymmetry is the point. `hoverLeave` keeps a landed preload, and
    // `markFailed` never does, because both reports arrive after the terminal
    // has drawn: a socket says `closed` whenever it drops later, and the
    // read-only check is a reactive effect whose answer can change under a
    // mount that is already up. A `!landed` guard here, symmetrical with the
    // one in `hoverLeave`, would leave the store naming a session whose
    // terminal is gone for the rest of the 60 s — and the click that followed
    // would be promoted onto nothing.
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.store.markFailed(alpha);
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0);
    expect(h.store.select(alpha)).toBe(false); // nothing left to hand over
  });

  it("ignores landed/failed reports for a session that is not in the slot", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markFailed(beta);
    expect(h.store.preloaded()?.name).toBe("alpha");
    h.store.markLanded(beta);
    h.store.hoverLeave(alpha);
    expect(h.store.preloaded()).toBeNull(); // alpha was still in flight
  });

  it("drops the slot when the TTL runs out", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.advance(SLOT_TTL_MS - 1);
    expect(h.store.preloaded()?.name).toBe("alpha");
    h.advance(1);
    expect(h.store.preloaded()).toBeNull();
  });

  it("runs the TTL from the fill, and a re-hover does not extend it", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.advance(SLOT_TTL_MS - 1_000);
    h.store.hoverEnter(alpha); // resting on it again
    h.advance(1_000);
    expect(h.store.preloaded()).toBeNull();
  });
});

describe("the promotion", () => {
  it("hands the slot over on a click and empties it", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    expect(h.store.select(alpha)).toBe(true);
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0); // and takes the TTL with it
  });

  it("promotes a preload that has not landed yet, because it is the same socket", () => {
    const h = harness();
    dwellOn(h, alpha);
    expect(h.store.select(alpha)).toBe(true);
  });

  it("tells the caller when the click was not on the preloaded session", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    expect(h.store.select(beta)).toBe(false);
    expect(h.store.preloaded()?.name).toBe("alpha"); // beta's click is not a replacement
    expect(h.store.select(null)).toBe(false);
  });

  it("tells a session apart from the same name owned by someone else", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    expect(h.store.select({ name: "alpha", owner: "bob" })).toBe(false);
    expect(h.store.select({ name: "alpha", owner: ME })).toBe(false);
    expect(h.store.select(alpha)).toBe(true);
  });
});

describe("what a hover is never allowed to attach", () => {
  const cases: Array<{ what: string; sel: Selected; h: () => Harness }> = [
    {
      what: "anything at all on a coarse pointer, where hover does not exist",
      sel: alpha,
      h: () => harness({ coarse: true }),
    },
    {
      what: "a session that is already mounted or selected",
      sel: alpha,
      h: () => harness({ open: ["alpha"] }),
    },
    {
      what: "a session owned by somebody else",
      sel: { name: "alpha", owner: "bob" },
      h: () => harness(),
    },
    {
      what: "a foreign session while whoami has not answered yet",
      sel: { name: "alpha", owner: "bob" },
      h: () => harness({ me: "" }),
    },
  ];

  for (const c of cases) {
    it(`never preloads ${c.what}`, () => {
      const h = c.h();
      h.store.hoverEnter(c.sel);
      h.advance(DWELL_MS * 4);
      expect(h.store.preloaded()).toBeNull();
      expect(h.pending()).toBe(0); // not even a dwell was armed
    });
  }

  it("does preload one of my own sessions carrying my name as its owner", () => {
    const h = harness();
    dwellOn(h, { name: "alpha", owner: ME });
    expect(h.store.preloaded()?.owner).toBe(ME);
  });

  it("stops when the pointer turns coarse mid-dwell (a 2-in-1 folding shut)", () => {
    const h = harness();
    h.store.hoverEnter(alpha);
    h.setCoarse(true);
    h.advance(DWELL_MS);
    expect(h.store.preloaded()).toBeNull();
  });
});

describe("a sweep down the sidebar", () => {
  const swept = ["card1", "card2", "card3", "card4"].map((name) => ({ name }));
  const rested: Selected = { name: "card5" };

  it("leaves nothing behind when no card is rested on", () => {
    const h = harness();
    for (const c of swept) {
      h.store.hoverEnter(c);
      h.advance(DWELL_MS - 50);
      h.store.hoverLeave(c);
    }
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0);
  });

  it("leaves exactly one slot, holding the last card, when every dwell completes", () => {
    const h = harness();
    for (const c of [...swept, rested]) {
      h.store.hoverEnter(c);
      h.advance(DWELL_MS);
      h.store.markLanded(c);
      h.store.hoverLeave(c);
    }
    expect(h.store.preloaded()?.name).toBe("card5");
    expect(h.pending()).toBe(1); // one TTL, not five
  });

  it("cancels the card left behind rather than arming two dwells", () => {
    const h = harness();
    h.store.hoverEnter(alpha);
    h.advance(100);
    h.store.hoverEnter(beta); // enter before leave, as a fast pointer delivers it
    expect(h.pending()).toBe(1);
    h.advance(DWELL_MS);
    expect(h.store.preloaded()?.name).toBe("beta");
  });
});

describe("dispose", () => {
  it("drops the slot and disarms every timer", () => {
    const h = harness();
    dwellOn(h, alpha);
    h.store.markLanded(alpha);
    h.store.hoverEnter(beta);
    h.store.dispose();
    expect(h.store.preloaded()).toBeNull();
    expect(h.pending()).toBe(0);
    h.advance(SLOT_TTL_MS * 2);
    expect(h.store.preloaded()).toBeNull();
  });
});
