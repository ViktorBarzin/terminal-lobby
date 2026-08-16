import { describe, it, expect } from "vitest";
import {
  PREF_DEFAULTS,
  applyPatch,
  changedPrefPaths,
  coercePrefs,
  composeDoc,
  mergeAdopt,
} from "../src/store/prefs";

/**
 * The terminal-rendering prefs the v2 Settings panel dropped relative to the
 * vanilla page: line height, letter spacing, cursor style/blink, bold weight,
 * the link copy chip, and desktop smooth-wheel.
 *
 * These are NOT new keys. `term.html` has been reading every one of them all
 * along, from the shared-origin `tl:prefs:v1` localStorage doc that the lobby
 * writes; only the editing UI was missing. So the schema here has to match the
 * vanilla page's PREF_VALID exactly — a value this SPA writes that the terminal
 * page rejects would be a setting that silently does nothing.
 */

describe("terminal prefs — schema matches the vanilla page's PREF_VALID", () => {
  it("defaults match the vanilla PREF_DEFAULTS", () => {
    expect(PREF_DEFAULTS.lineHeight).toBe(1);
    expect(PREF_DEFAULTS.letterSpacing).toBe(0);
    expect(PREF_DEFAULTS.cursorStyle).toBe("block");
    expect(PREF_DEFAULTS.cursorBlink).toBe(true);
    expect(PREF_DEFAULTS.fontWeightBold).toBe("700");
    expect(PREF_DEFAULTS.links.copyChip).toBe(true);
    expect(PREF_DEFAULTS.gestures.wheelSmooth).toBe(true);
    expect(PREF_DEFAULTS.gestures.wheelSpeed).toBe(1);
  });

  it("accepts the values the terminal page accepts", () => {
    const p = coercePrefs({
      lineHeight: 1.4,
      letterSpacing: 0.5,
      cursorStyle: "underline",
      cursorBlink: false,
      fontWeightBold: "600",
      links: { copyChip: false },
      gestures: { wheelSmooth: false, wheelSpeed: 3 },
    });
    expect(p.lineHeight).toBe(1.4);
    expect(p.letterSpacing).toBe(0.5);
    expect(p.cursorStyle).toBe("underline");
    expect(p.cursorBlink).toBe(false);
    expect(p.fontWeightBold).toBe("600");
    expect(p.links.copyChip).toBe(false);
    expect(p.gestures.wheelSmooth).toBe(false);
    expect(p.gestures.wheelSpeed).toBe(3);
  });

  it("rejects out-of-range numbers rather than writing something the terminal drops", () => {
    // vanilla: lineHeight 1..1.4, letterSpacing 0..1
    for (const v of [0.9, 1.5, 99, NaN, Infinity, "1.2", null]) {
      expect(coercePrefs({ lineHeight: v }).lineHeight).toBe(1);
    }
    for (const v of [-0.1, 1.01, 5, NaN, "0.5", null]) {
      expect(coercePrefs({ letterSpacing: v }).letterSpacing).toBe(0);
    }
  });

  it("rejects values outside the enumerations", () => {
    for (const v of ["beam", "BLOCK", "", 1, null]) {
      expect(coercePrefs({ cursorStyle: v }).cursorStyle).toBe("block");
    }
    for (const v of ["800", 700, "bold", null]) {
      expect(coercePrefs({ fontWeightBold: v }).fontWeightBold).toBe("700");
    }
    // wheelSpeed is an enumeration, not a range — 2.5 is not a valid step.
    for (const v of [2.5, 4, 0, "2", null]) {
      expect(coercePrefs({ gestures: { wheelSpeed: v } }).gestures.wheelSpeed).toBe(1);
    }
    expect(coercePrefs({ gestures: { wheelSpeed: 1.5 } }).gestures.wheelSpeed).toBe(1.5);
    expect(coercePrefs({ gestures: { wheelSpeed: 2 } }).gestures.wheelSpeed).toBe(2);
  });

  it("requires real booleans", () => {
    for (const v of ["true", 1, null, {}]) {
      expect(coercePrefs({ cursorBlink: v }).cursorBlink).toBe(true); // default true
      expect(coercePrefs({ links: { copyChip: v } }).links.copyChip).toBe(true);
      expect(coercePrefs({ gestures: { wheelSmooth: v } }).gestures.wheelSmooth).toBe(true);
    }
    expect(coercePrefs({ cursorBlink: false }).cursorBlink).toBe(false);
  });
});

/**
 * The gestures namespace is mostly TOUCH prefs this panel does not edit, and
 * `links` has exactly one key today. A write from here must not disturb either
 * — the vanilla terminal page owns those and would lose them.
 */
describe("terminal prefs — a write never disturbs the neighbours", () => {
  const realDoc = () => ({
    cursorBlink: true,
    cursorStyle: "block",
    fontSize: 14,
    fontWeightBold: "700",
    gestures: {
      keyRepeat: true,
      cardLongPress: true,
      overlaySwipe: true,
      bottomSheet: true,
      swipeSessionOptIn: false,
      twoFingerTap: true,
      haptics: true,
      scrollSpeedV2: 1,
      scrollMomentum: false,
      wheelSmooth: true,
      wheelSpeed: 1,
    },
    input: { bar: "auto", tapFocus: "field" },
    letterSpacing: 0,
    lineHeight: 1,
    links: { copyChip: true },
    notify: { onDone: true, onAwaiting: true },
    session: { reopenLast: true, newCommand: "claude" },
  });

  it("keeps every touch gesture when only the wheel keys move", () => {
    const raw = realDoc();
    const next = {
      ...coercePrefs(raw),
      gestures: { wheelSmooth: false, wheelSpeed: 2 as const },
    };
    const doc = composeDoc(raw, next) as Record<string, any>;
    expect(doc.gestures.wheelSmooth).toBe(false);
    expect(doc.gestures.wheelSpeed).toBe(2);
    // ...and the eight this panel does not edit are untouched.
    expect(doc.gestures.keyRepeat).toBe(true);
    expect(doc.gestures.cardLongPress).toBe(true);
    expect(doc.gestures.overlaySwipe).toBe(true);
    expect(doc.gestures.bottomSheet).toBe(true);
    expect(doc.gestures.swipeSessionOptIn).toBe(false);
    expect(doc.gestures.twoFingerTap).toBe(true);
    expect(doc.gestures.haptics).toBe(true);
    expect(doc.gestures.scrollSpeedV2).toBe(1);
    expect(doc.gestures.scrollMomentum).toBe(false);
    // and so are the namespaces this panel never touches
    expect(doc.input).toEqual({ bar: "auto", tapFocus: "field" });
    expect(doc.session.reopenLast).toBe(true);
  });

  it("deep-merges gestures and links on adoption, like session and notify", () => {
    // A server doc that has an opinion about one subkey must not reset the
    // siblings this device knows about.
    const merged = mergeAdopt(
      { gestures: { haptics: true, wheelSpeed: 3 }, links: { copyChip: false } },
      { gestures: { wheelSpeed: 1 } },
    ) as Record<string, any>;
    expect(merged.gestures.wheelSpeed).toBe(1); // server wins
    expect(merged.gestures.haptics).toBe(true); // local survives
    expect(merged.links.copyChip).toBe(false);
  });

  it("patches one key at a time without resetting its namespace", () => {
    const cur = coercePrefs(realDoc());
    const next = applyPatch(cur, { gestures: { wheelSpeed: 2 } });
    expect(next.gestures.wheelSpeed).toBe(2);
    expect(next.gestures.wheelSmooth).toBe(true);
    const next2 = applyPatch(cur, { links: { copyChip: false } });
    expect(next2.links.copyChip).toBe(false);
    expect(next2.cursorStyle).toBe("block");
  });

  it("reports every new row's dotted path to telemetry", () => {
    const base = PREF_DEFAULTS;
    const paths = (p: Parameters<typeof applyPatch>[1]) =>
      changedPrefPaths(base, applyPatch(base, p)).map(([k]) => k);
    expect(paths({ lineHeight: 1.2 })).toEqual(["lineHeight"]);
    expect(paths({ letterSpacing: 0.5 })).toEqual(["letterSpacing"]);
    expect(paths({ cursorStyle: "bar" })).toEqual(["cursorStyle"]);
    expect(paths({ cursorBlink: false })).toEqual(["cursorBlink"]);
    expect(paths({ fontWeightBold: "600" })).toEqual(["fontWeightBold"]);
    expect(paths({ links: { copyChip: false } })).toEqual(["links.copyChip"]);
    expect(paths({ gestures: { wheelSmooth: false } })).toEqual([
      "gestures.wheelSmooth",
    ]);
    expect(paths({ gestures: { wheelSpeed: 2 } })).toEqual(["gestures.wheelSpeed"]);
  });
});
