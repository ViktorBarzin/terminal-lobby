import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initialAttention,
  isHidden,
  reduce,
  type AttentionEvent,
  type AttentionKind,
  type AttentionState,
} from "../src/terminal/attention";

/**
 * When a session deserves the lobby's attention (term.html:5676-5781).
 *
 * TWO SIGNALS WITH TWO DIFFERENT RULES, which is the thing to hold on to while
 * reading these:
 *   bell   is reported unconditionally. term.html:5772 is
 *          `term.onBell(() => signalAttention('bell'))` and there is no
 *          visibility test anywhere on that path. The lobby decides what a bell
 *          is worth, because its notion of "away" is WIDER than this module's
 *          notion of hidden (notify/attention.ts: `document.hidden ||
 *          !document.hasFocus()`).
 *   output is reported only while nobody can see the terminal, and only once
 *          per hidden period. It is on the hot path, so it pays two booleans.
 *
 * AND ONE SHAPE RULE: the tab's visibility is an argument to every decision,
 * never a field of the state, because term.html reads `document.hidden` live
 * inside `attentionHidden()` (:5740) and inside the re-arm (:5744, :5754). The
 * browser flips that flag and QUEUES the visibilitychange, so a module that
 * remembered the flag instead would judge anything processed inside that window
 * on the old value. `the tab flag is read at the decision` below is that case,
 * and the differential at the bottom has the flip and its queued event as
 * SEPARATE steps so the window is inside the search space.
 *
 * TWO PARITY DESCRIBES AND A CITATION TABLE WENT FROM HERE ON 2026-09-05, with
 * `frontend/term.html`. They sliced the SHIPPED kernel out of that page, ran it
 * in a `node:vm` context, and compared it against this module over every walk
 * of up to five steps from four different starts — 19,607 walks and 94,773
 * steps — plus a table checking that every `term.html:NNNN` line this module's
 * comments cite really said what they claimed. All three needed the file. The
 * rules they proved are still asserted below, as this module's own behaviour;
 * what is gone is the second implementation to compare against, and the
 * citations are now provenance rather than checked claims.
 */

/**
 * Event constructors. The tab flag defaults to "on screen" so a case that does
 * not care about the tab reads as the common case, and the cases that do care
 * say so at the call site.
 */
const BELL: AttentionEvent = { type: "bell" };
const out = (tabHidden = false): AttentionEvent => ({ type: "output", tabHidden });
const tab = (tabHidden: boolean): AttentionEvent => ({ type: "tab", tabHidden });
const view = (viewHidden: boolean, tabHidden = false): AttentionEvent => ({
  type: "view",
  viewHidden,
  tabHidden,
});

/** Feed a run of events through reduce, collecting what it asked the lobby for. */
function run(
  events: readonly AttentionEvent[],
  start: AttentionState = initialAttention(),
): { state: AttentionState; signals: AttentionKind[] } {
  let state = start;
  const signals: AttentionKind[] = [];
  for (const event of events) {
    const r = reduce(state, event);
    state = r.state;
    for (const action of r.actions) signals.push(action.kind);
  }
  return { state, signals };
}

describe("the bell", () => {
  /**
   * THE ONE THAT LOOKS WRONG AND IS NOT. "You are already looking at it" is a
   * real rule, but it is the LOBBY's rule, not the terminal's: term.html posts
   * every ring upward and `notify/attention.ts` drops the ones that arrive
   * while the tab is not away. Moving that test in here would silence the bell
   * for a tab that is visible but UNFOCUSED (the lobby on a second monitor),
   * which is a case the lobby does latch for.
   */
  it("rings through even while the terminal is on screen", () => {
    expect(run([BELL]).signals).toEqual(["bell"]);
  });

  it("rings through while the tab is away as well", () => {
    expect(run([tab(true), BELL]).signals).toEqual(["bell"]);
  });

  /**
   * No latch on this path at all: `hiddenOutputSignaled` is the output one-shot
   * and the bell never reads or writes it. Three rings are three messages, and
   * the lobby's own latch is what stops three badges.
   */
  it("does not latch, so every ring is its own signal", () => {
    expect(run([view(true), BELL, BELL, BELL]).signals).toEqual(["bell", "bell", "bell"]);
  });

  it("leaves the output one-shot armed behind it", () => {
    expect(run([view(true), BELL, out()]).signals).toEqual(["bell", "output"]);
  });

  it("is not silenced by an output one-shot that has already been spent", () => {
    expect(run([view(true), out(), BELL]).signals).toEqual(["output", "bell"]);
  });

  /**
   * The order inside ONE frame, which is fixed by the page and worth pinning
   * because it is the component that has to reproduce it: term.html calls
   * `noteHiddenOutput()` at :10388 and only then writes the bytes into xterm
   * (:10391-10392), so a BEL in that frame reaches `onBell` AFTER the output
   * signal. The lobby unions the two latches, so nothing downstream depends on
   * the order, but a component that wrote first would report them the other way
   * round and no test would have said so.
   */
  it("follows the output signal when the same frame carried a BEL", () => {
    expect(run([out(true), BELL]).signals).toEqual(["output", "bell"]);
  });

  it("changes nothing about the state", () => {
    const latched = run([view(true), out()]).state;
    expect(reduce(latched, BELL).state).toBe(latched);
    const fresh = initialAttention();
    expect(reduce(fresh, BELL).state).toBe(fresh);
  });

  it("carries a reason for the log line", () => {
    const actions = reduce(initialAttention(), BELL).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.why).not.toBe("");
  });
});

describe("output, and the one-shot per hidden period", () => {
  /**
   * The cheap case, and the common one: you are watching the terminal, so
   * output is not news. term.html pays two boolean reads per output frame for
   * this, which is why the check lives at the top of `noteHiddenOutput`
   * (:5764-5770) rather than anywhere near the lobby.
   */
  it("says nothing while the tab and the view are both on screen", () => {
    expect(run([out(), out(), out()]).signals).toEqual([]);
  });

  it("signals once while the tab is away, however many frames arrive", () => {
    expect(run([out(true), out(true), out(true)]).signals).toEqual(["output"]);
  });

  /**
   * "Nobody is looking" is bigger than `document.hidden`. The lobby keeps this
   * terminal MOUNTED and CSS-hidden while its text view shows, so the tab is
   * wide open and the terminal is not on screen. Gating on the tab alone is
   * what kept the [Terminal] segment's dot from ever lighting.
   */
  it("signals once while the lobby shows its text view over the terminal", () => {
    expect(run([view(true), out(), out()]).signals).toEqual(["output"]);
  });

  it("re-arms when the terminal comes fully back, so the next burst signals again", () => {
    expect(run([view(true), out(), view(false), out(), view(true), out()]).signals).toEqual([
      "output",
      "output",
    ]);
  });

  it("leaves nothing armed once the terminal is fully back on screen", () => {
    const back = run([view(true), out(), view(false)]).state;
    expect(back.latched).toBe(false);
    expect(isHidden(back, false)).toBe(false);
  });

  it("carries a reason naming which kind of hidden it was", () => {
    const [tabAway] = reduce(initialAttention(), out(true)).actions;
    const [viewAway] = reduce(run([view(true)]).state, out()).actions;
    expect(tabAway!.why).toContain("tab");
    expect(viewAway!.why).toContain("view");
  });
});

/** The four ways the two reasons for being hidden can stand. */
const HIDDEN_MATRIX: ReadonlyArray<readonly [string, boolean, boolean, boolean]> = [
  ["the terminal on screen in a shown tab", false, false, false],
  ["the tab away", true, false, true],
  ["the lobby showing its text view", false, true, true],
  ["the tab away over a hidden view", true, true, true],
];

describe.each(HIDDEN_MATRIX)("with %s", (_label, tabHidden, viewHidden, hidden) => {
  /**
   * Only the view half is state, so only the view half is reached by an event.
   * The tab half rides in on whatever decision is being made, which is the
   * shape argued in the module header.
   */
  const start = (): AttentionState =>
    viewHidden ? run([view(true, tabHidden)]).state : initialAttention();

  it(`counts as ${hidden ? "hidden" : "on screen"}`, () => {
    expect(isHidden(start(), tabHidden)).toBe(hidden);
  });

  it(`${hidden ? "signals" : "says nothing"} on an output frame`, () => {
    expect(run([out(tabHidden)], start()).signals).toEqual(hidden ? ["output"] : []);
  });

  it("reports a bell either way", () => {
    expect(run([BELL], start()).signals).toEqual(["bell"]);
  });
});

/**
 * THE DEAD PATH, and the reason the one-shot remembers WHY it was spent.
 *
 * The lobby only latches its tab badge for a signal that arrives while the tab
 * is away. So when a view-hidden period opened with a frame of output (the
 * attach paint, or the redraw the view switch itself causes) the one-shot was
 * burned on a signal nobody could use, and every later frame was silent,
 * including the first one after you tabbed away. term.html:5745-5756 fixes it
 * by re-arming when a NEW reason for being hidden becomes true.
 */
describe("hidden for a NEW reason opens a new period", () => {
  it("the tab going away re-arms an already-hidden view", () => {
    expect(run([view(true), out(), tab(true), out(true)]).signals).toEqual(["output", "output"]);
  });

  it("the view going away re-arms an already-away tab", () => {
    expect(run([out(true), view(true, true), out(true)]).signals).toEqual(["output", "output"]);
  });

  it("is still one signal per away period, not one per output frame", () => {
    expect(
      run([view(true), tab(true), out(true), out(true), out(true)]).signals,
    ).toEqual(["output"]);
  });

  /**
   * The reverse of the dead path is NOT a new period: you still cannot see the
   * terminal, so nothing has changed about whether the last signal did its job.
   */
  it("the tab coming back over a still-hidden view is not a new period", () => {
    expect(run([view(true), tab(true), out(true), tab(false), out()]).signals).toEqual(["output"]);
  });

  it("the view coming back while the tab is still away is not a new period", () => {
    expect(
      run([view(true, true), out(true), view(false, true), out(true)]).signals,
    ).toEqual(["output"]);
  });

  it("does not re-arm on a repeat of the reason it was spent under", () => {
    expect(run([view(true), out(), view(true), out()]).signals).toEqual(["output"]);
    expect(run([out(true), tab(true), out(true)]).signals).toEqual(["output"]);
  });

  /**
   * The plain tab case, with the terminal view on screen throughout: away,
   * back, away again is two periods and two signals.
   */
  it("gives a second signal when the tab hides again after coming back", () => {
    expect(run([out(true), tab(false), tab(true), out(true)]).signals).toEqual([
      "output",
      "output",
    ]);
  });
});

/**
 * THE FLAG IS READ AT THE DECISION, NOT REMEMBERED. The browser flips
 * `document.hidden` and QUEUES the visibilitychange, so a socket frame or a
 * `tl-view` message can be processed in between. term.html is judged on the new
 * value in that window because it reads the flag live (:5740, :5744, :5754);
 * these are the two cases where remembering it instead would differ, and both
 * are reachable inside the differential's search space as well.
 */
describe("the tab flag is read at the decision", () => {
  it("signals for an output frame that lands before the visibilitychange runs", () => {
    // No `tab` event has been seen at all: the flag came in on the frame.
    const { state, signals } = run([out(true)]);
    expect(signals).toEqual(["output"]);
    // And the queued event, landing next, must NOT re-arm: the shot was already
    // spent under a hidden tab, so this is the same period (:5754).
    expect(reduce(state, tab(true)).state.latched).toBe(true);
    expect(run([tab(true), out(true)], state).signals).toEqual([]);
  });

  it("re-arms on a tl-view that repeats its value, when the tab went away since the spend", () => {
    // The shot is spent with the view hidden and the tab on screen, so the
    // lobby dropped it.
    const spent = run([view(true), out()]).state;
    expect(spent.latched).toBe(true);
    expect(spent.spentTabHidden).toBe(false);
    // Now the tab goes away, and the lobby re-posts `tl-view` with the value it
    // already had before the visibilitychange task runs. `setViewHidden` re-arms
    // unconditionally (:5759-5760) and its re-arm reads the live flag, so this
    // opens the new period even though the view flag did not move.
    const after = reduce(spent, view(true, true)).state;
    expect(after.latched).toBe(false);
    expect(run([out(true)], after).signals).toEqual(["output"]);
  });

  /**
   * The background-boot case, which is why nothing is seeded at mount: a tab
   * opened into the background fires no visibilitychange until it is first
   * shown, and the page still signals because it never needed to be told.
   */
  it("needs no seed for a tab that booted hidden", () => {
    const fresh = initialAttention();
    expect(isHidden(fresh, true)).toBe(true);
    expect(run([out(true)], fresh).signals).toEqual(["output"]);
  });
});

/**
 * STATE LIFETIME. The page's kernel dies with its document, and TerminalView
 * navigates the iframe on an args change, so the latch and the spent pair reset
 * there. TerminalNative reads `props.args` once inside `onMount` and never
 * re-attaches, so there is nothing to diverge from today; this pins what a
 * component that grows re-attach has to do, since carrying the state over would
 * silence the first output frame of the new session.
 */
describe("a re-attach starts a fresh period", () => {
  it("forgets a one-shot spent by the session before it", () => {
    const spent = run([view(true), out()]).state;
    expect(spent.latched).toBe(true);
    const reattached = initialAttention();
    expect(reattached.latched).toBe(false);
    expect(reattached.spentTabHidden).toBe(false);
    expect(reattached.spentViewHidden).toBe(false);
    // The lobby re-posts `tl-view` on every attach, which is what puts the view
    // flag back; the first frame after that is news again.
    expect(run([view(true), out()], reattached).signals).toEqual(["output"]);
  });
});

/**
 * The spent pair is read ONLY while the one-shot is spent, which is the claim
 * both the state comment and term.html's lean on: neither clears the pair on a
 * re-arm (:5745-5757), so stale values are left lying around and it matters
 * that nothing reads them. Exhaustive over every unlatched state and every
 * event, rather than argued.
 */
describe("the spent pair while nothing is latched", () => {
  it("changes no decision, whatever it was left holding", () => {
    const events: readonly AttentionEvent[] = [
      BELL,
      out(false),
      out(true),
      tab(false),
      tab(true),
      view(false, false),
      view(false, true),
      view(true, false),
      view(true, true),
    ];
    for (const viewHidden of [false, true]) {
      for (const spentTabHidden of [false, true]) {
        for (const spentViewHidden of [false, true]) {
          const stale: AttentionState = {
            viewHidden,
            latched: false,
            spentTabHidden,
            spentViewHidden,
          };
          const clean: AttentionState = { ...stale, spentTabHidden: false, spentViewHidden: false };
          for (const event of events) {
            const left = reduce(stale, event);
            const right = reduce(clean, event);
            const label = `spent [${spentTabHidden},${spentViewHidden}], view ${viewHidden}, on ${event.type}`;
            expect(
              left.actions.map((a) => a.kind),
              label,
            ).toEqual(right.actions.map((a) => a.kind));
            expect(left.state.latched, label).toBe(right.state.latched);
            expect(left.state.viewHidden, label).toBe(right.state.viewHidden);
          }
        }
      }
    }
  });
});

describe("identity when nothing moved", () => {
  it("returns the same state for a view event that changes neither flag", () => {
    const fresh = initialAttention();
    expect(reduce(fresh, view(false)).state).toBe(fresh);
    expect(reduce(fresh, tab(false)).state).toBe(fresh);
    expect(reduce(fresh, tab(true)).state).toBe(fresh);
  });

  it("returns the same state for a repeat of the reason the one-shot was spent under", () => {
    const latched = run([view(true), out()]).state;
    expect(reduce(latched, view(true)).state).toBe(latched);
  });

  it("returns the same state for an output frame nobody needed", () => {
    const fresh = initialAttention();
    expect(reduce(fresh, out()).state).toBe(fresh);
    const latched = run([out(true)]).state;
    expect(reduce(latched, out(true)).state).toBe(latched);
  });

  it("emits no action for anything but a signal", () => {
    for (const event of [tab(true), tab(false), view(true), view(false)]) {
      expect(reduce(initialAttention(), event).actions).toEqual([]);
    }
  });
});

// ---- parity against the shipped page ---------------------------------------

/** The source between a pair of `// >>> name` / `// <<< name` sentinels. */
describe("the contract handed to the component", () => {
  const SRC = resolve(__dirname, "../src/terminal/attention.ts");
  const source = readFileSync(SRC, "utf8");
  /**
   * The owes list as one line, because a sentence in it wraps wherever the
   * comment ran out of room and a guard that only matched unwrapped phrases
   * would be a guard on the line breaks.
   */
  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("*/", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source
      .slice(start, end)
      .replace(/^\s*\*/gm, " ")
      .replace(/\s+/g, " ");
  };

  /** Comments and the code, told apart the same way for every guard below. */
  const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /**
   * Anything that would make this module impure, as bare identifiers rather
   * than as `document.` — a destructured `const { hidden } = document` reads
   * nothing off a dotted path and slipped past the earlier version of this
   * guard, which is the whole reason it names identifiers now.
   */
  const IMPURE =
    /\b(?:document|window|globalThis|self|navigator|location|localStorage|sessionStorage|fetch|postMessage|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|performance|Date)\b/;

  /**
   * The module reads no clock, no DOM and no socket, which is what lets these
   * rules be tested without a browser. Comments are stripped first, so a
   * comment that NAMES one of these (the header names several) is not read as
   * a call to it.
   */
  it("touches nothing outside its arguments", () => {
    expect(strip(source)).not.toMatch(IMPURE);
  });

  /**
   * And the guard above is worth what it claims: every one of these is a read
   * the module must never grow, including the destructured form, while a line
   * of the module's own arithmetic is not a false positive.
   */
  it.each([
    ["a destructured DOM read", "const { hidden } = document;"],
    ["a dotted DOM read", "const away = document.hidden;"],
    ["a read through window", "const away = window.document.hidden;"],
    ["a clock", "const at = Date.now();"],
    ["a timer", "setTimeout(() => {}, 0);"],
    ["a post upward", "parent.postMessage({}, origin);"],
  ])("would catch %s", (_what, line) => {
    expect(strip(line)).toMatch(IMPURE);
  });

  it("does not call a pure line impure", () => {
    expect(strip("return tabHidden || state.viewHidden;")).not.toMatch(IMPURE);
  });

  /**
   * The live read is the thing term.html never had to think about and the
   * component has to do at three call sites. A component that passes a
   * remembered flag instead loses the first output frame of a hidden period
   * whenever the visibilitychange task has not run yet, and nothing else in the
   * codebase would say so.
   */
  it("names the live document.hidden read every decision takes", () => {
    expect(owes()).toContain("document.hidden");
    expect(owes()).toContain("read at that");
  });

  /**
   * One event per OUTPUT frame, at the same place the page calls
   * noteHiddenOutput, and before the bytes reach xterm. A title or prefs frame
   * is not news, and attach.ts's `write` is already the callback that fires for
   * output frames alone.
   */
  it("names the once-per-output-frame call site, and where it sits in the frame", () => {
    expect(owes()).toContain("write");
    expect(owes()).toContain("output frame");
    expect(owes()).toContain("BEFORE handing the bytes to xterm");
  });

  /** The title and the favicon stay the lobby's, or the two fight over them. */
  it("says the title and the favicon are not this module's to touch", () => {
    expect(owes()).toMatch(/title/);
    expect(owes()).toMatch(/favicon/);
  });

  /** A component that keeps this state across a re-attach silences the first frame. */
  it("names the re-attach a component has to re-seed", () => {
    expect(owes()).toContain("initialAttention");
    expect(owes()).toContain("re-attach");
  });

  // ---- the citations, checked against the files they name -------------------

  const componentSource = (name: string): string =>
    readFileSync(resolve(__dirname, `../src/components/${name}`), "utf8");

  /**
   * The `visibilitychange` listener is NEW work. TerminalNative.tsx has none
   * today, so the owes list must not send a wiring agent looking for one to add
   * a line to; this guard goes quiet on its own once the listener lands.
   */
  it("does not promise a visibilitychange listener the component does not have", () => {
    expect(owes()).toContain("visibilitychange");
    if (!componentSource("TerminalNative.tsx").includes("visibilitychange")) {
      expect(owes(), "the component has no listener yet, so the owes list must say so").toContain(
        "none today",
      );
    }
  });

  /**
   * A line-number citation that nobody checks drifts, and this one already had
   * to be corrected by one line. The failure message carries the new number.
   */
  it("cites the line SessionView really passes `active` on", () => {
    const wanted = 'active={mode() === "terminal" && onScreen()}';
    const lines = componentSource("SessionView.tsx").split("\n");
    const at = lines.findIndex((line) => line.includes(wanted));
    expect(at, `${wanted} in SessionView.tsx`).toBeGreaterThan(-1);
    const cited = /SessionView\.tsx:(\d+)/.exec(source);
    expect(cited?.[1], "the citation in attention.ts, against the live line").toBe(String(at + 1));
  });

});
