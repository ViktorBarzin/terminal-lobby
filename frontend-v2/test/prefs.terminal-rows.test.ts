import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PREF_DEFAULTS,
  TAP_FOCUS_TARGETS,
  WHEEL_SPEEDS,
  applyPatch,
  changedPrefPaths,
  coercePrefs,
  composeDoc,
  mergeAdopt,
} from "../src/store/prefs";

/**
 * term.html, read rather than remembered.
 *
 * The cases below that name it assert against the page's own source, because
 * "the schema matches PREF_VALID" is a claim about another file and a claim
 * about another file rots. Sliced by the two `const` declarations rather than by
 * line number: a key name appears in BOTH tables, and a line number in a
 * 1.5 MB file that other people edit is a citation nobody can trust.
 */
const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
let cachedHtml: string | null = null;
const html = (): string => (cachedHtml ??= readFileSync(TERM_HTML, "utf8"));
const slice = (from: string, to: string): string => {
  const a = html().indexOf(from);
  const b = html().indexOf(to, a);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return html().slice(a, b);
};
/** term.html's PREF_DEFAULTS (:2713), the values it serves a doc that is silent. */
const vanillaDefaults = (): string =>
  slice("const PREF_DEFAULTS = Object.freeze({", "const PREF_VALID = {");
/** term.html's PREF_VALID (:2862), the values it will accept from a doc. */
const vanillaValid = (): string =>
  slice("const PREF_VALID = {", "function readRawPrefs()");

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
 * The three keys the native terminal's own modules read, which the roamed doc
 * has carried all along and this store used to pass through as unknown.
 *
 * `terminal/touchscroll.ts` needs `gestures.scrollSpeedV2` on every feed and
 * `gestures.scrollMomentum` at the lift; its focus action and
 * `terminal/dragselect.ts`' both need `input.tapFocus`. Typing them is what lets
 * a component read them at all, and the whole risk of typing them is the
 * DEFAULT: every device that never set one of these has term.html's value
 * today, so a different default here changes how those devices scroll without
 * anybody touching a setting. Hence the assertions against the page's source.
 */
describe("the native terminal's three prefs — term.html owns the defaults", () => {
  it("takes each default from the vanilla PREF_DEFAULTS, not from taste", () => {
    // Read the page, then assert this store agrees with what it says.
    expect(vanillaDefaults()).toContain("scrollSpeedV2: 1,");
    expect(vanillaDefaults()).toContain("scrollMomentum: true,");
    expect(vanillaDefaults()).toContain("tapFocus: 'field'");
    expect(PREF_DEFAULTS.gestures.scrollSpeedV2).toBe(1);
    expect(PREF_DEFAULTS.gestures.scrollMomentum).toBe(true);
    expect(PREF_DEFAULTS.input.tapFocus).toBe("field");
  });

  /**
   * `scrollMomentumOn()` is `!!getPrefs().gestures.scrollMomentum`, which reads
   * like a default of FALSE. It is not one: `getPrefs` goes through
   * `normalizePrefs`, which rebuilds every namespace from PREF_DEFAULTS before
   * any subkey is read, so the `!!` only ever narrows a boolean that is there.
   * A port that copied the reader and skipped the normalize would ship momentum
   * off for everyone, which is why the default is asserted from the page above
   * and the mechanism is asserted here.
   */
  it("keeps momentum ON for a doc that never mentions it", () => {
    expect(vanillaValid()).toContain("scrollMomentum: v => typeof v === 'boolean'");
    expect(coercePrefs({}).gestures.scrollMomentum).toBe(true);
    expect(coercePrefs({ gestures: {} }).gestures.scrollMomentum).toBe(true);
    expect(coercePrefs({ gestures: { scrollMomentum: "off" } }).gestures.scrollMomentum).toBe(
      true,
    );
    // ...and an explicit false is a setting, not an absence.
    expect(coercePrefs({ gestures: { scrollMomentum: false } }).gestures.scrollMomentum).toBe(
      false,
    );
  });

  it("accepts exactly the four speeds the page accepts, for both speed prefs", () => {
    // One predicate in term.html serves wheelSpeed and scrollSpeedV2, which is
    // why one type and one table serve both here.
    const predicate = "v => v === 1 || v === 1.5 || v === 2 || v === 3";
    expect(vanillaValid()).toContain(`scrollSpeedV2: ${predicate}`);
    expect(vanillaValid()).toContain(`wheelSpeed: ${predicate}`);
    expect(WHEEL_SPEEDS).toEqual([1, 1.5, 2, 3]);
    for (const v of WHEEL_SPEEDS) {
      expect(coercePrefs({ gestures: { scrollSpeedV2: v } }).gestures.scrollSpeedV2).toBe(v);
    }
    // A value the page rejects must not survive here either: it would be a
    // setting that silently does nothing on the shipped terminal.
    for (const junk of [0, 2.5, 4, -1, "2", null, Number.NaN]) {
      expect(coercePrefs({ gestures: { scrollSpeedV2: junk } }).gestures.scrollSpeedV2).toBe(1);
    }
  });

  it("accepts exactly the two tap targets the page accepts", () => {
    expect(vanillaValid()).toContain("tapFocus: v => v === 'field' || v === 'terminal'");
    expect(TAP_FOCUS_TARGETS).toEqual(["field", "terminal"]);
    expect(coercePrefs({ input: { tapFocus: "terminal" } }).input.tapFocus).toBe("terminal");
    expect(coercePrefs({ input: { tapFocus: "compose" } }).input.tapFocus).toBe("field");
    expect(coercePrefs({ input: 42 }).input.tapFocus).toBe("field");
  });

  /**
   * `input.bar` is left out on purpose. Its default `'auto'` is a never-touched
   * marker resolved per DEVICE at apply time, so writing a value from here
   * would answer a question the roamed doc is meant to leave open. It has to
   * survive a write regardless, which the neighbours case below covers.
   */
  it("does not type input.bar, and the page still has a marker to resolve", () => {
    expect(vanillaDefaults()).toContain("bar: 'auto'");
    expect(vanillaValid()).toContain("bar: v => v === 'auto' || v === 'on' || v === 'off'");
    expect("bar" in coercePrefs({ input: { bar: "on" } }).input).toBe(false);
  });

  /**
   * The re-key the page went through (#9642): v1's `gestures.scrollSpeed` was a
   * deltaY multiplier already serialized into roamed docs as 2 or 3, so it was
   * dropped from PREF_VALID and replaced by a fresh key. Nothing on this side
   * may read or write the old name, or a doc carrying 3 would mean triple speed
   * again.
   */
  it("never reads the burned v1 scrollSpeed key", () => {
    expect(vanillaValid()).not.toContain("scrollSpeed:");
    const p = coercePrefs({ gestures: { scrollSpeed: 3 } });
    expect(p.gestures.scrollSpeedV2).toBe(1);
    expect("scrollSpeed" in p.gestures).toBe(false);
    // Unknown, so a write still carries it: dropping keys is the vanilla
    // normalize's job, not this store's.
    const doc = composeDoc({ gestures: { scrollSpeed: 3 } }, p) as Record<string, any>;
    expect(doc.gestures.scrollSpeed).toBe(3);
    expect(doc.gestures.scrollSpeedV2).toBe(1);
  });
});

/**
 * The gestures namespace is mostly TOUCH prefs this panel does not edit, and
 * `links` has exactly one key today. A write from here must not disturb either
 * — the vanilla terminal page owns those and would lose them.
 *
 * `gestures.scrollSpeedV2`, `gestures.scrollMomentum` and `input.tapFocus` moved
 * from unknown to typed when the native terminal's scroller needed them, so the
 * assertion on those three changed shape without changing its point: they used
 * to ride through untouched, and are now written back at the value the doc held.
 * Either way a device that set one keeps it.
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
    const base = coercePrefs(raw);
    const next = {
      ...base,
      gestures: { ...base.gestures, wheelSmooth: false, wheelSpeed: 2 as const },
    };
    const doc = composeDoc(raw, next) as Record<string, any>;
    expect(doc.gestures.wheelSmooth).toBe(false);
    expect(doc.gestures.wheelSpeed).toBe(2);
    // ...and the seven touch flags nothing here types are untouched.
    expect(doc.gestures.keyRepeat).toBe(true);
    expect(doc.gestures.cardLongPress).toBe(true);
    expect(doc.gestures.overlaySwipe).toBe(true);
    expect(doc.gestures.bottomSheet).toBe(true);
    expect(doc.gestures.swipeSessionOptIn).toBe(false);
    expect(doc.gestures.twoFingerTap).toBe(true);
    expect(doc.gestures.haptics).toBe(true);
    // The scroller's two are typed now, so they leave through the write rather
    // than through the spread. A momentum this device turned OFF is the case
    // that matters: it must not come back as the default on the way out.
    expect(doc.gestures.scrollSpeedV2).toBe(1);
    expect(doc.gestures.scrollMomentum).toBe(false);
    // `input` is partly typed now: `tapFocus` is written, `bar` still rides the
    // spread, and the namespace comes out identical either way.
    expect(doc.input).toEqual({ bar: "auto", tapFocus: "field" });
    expect(doc.session.reopenLast).toBe(true);
  });

  it("writes a real doc back losing nothing and inventing only its own keys", () => {
    // What the preserve-unknown posture is FOR, asserted whole rather than key
    // by key: everything term.html put in the doc comes back, and the only
    // additions are the namespaces this SPA owns and this doc has never carried.
    const raw = realDoc();
    expect(composeDoc(raw, coercePrefs(raw))).toEqual({
      ...raw,
      session: {
        ...raw.session,
        newProject: "",
        newModel: "default",
        newEffort: "default",
        newCodexModel: "default",
        newCodexEffort: "default",
      },
      sidebar: { showLastActive: false, order: PREF_DEFAULTS.sidebar.order },
    });
  });

  it("deep-merges input on adoption too, now that a subkey of it is typed", () => {
    // Without `input` in mergeAdopt's namespace list, a server doc with an
    // opinion about `tapFocus` would replace the whole namespace and take this
    // device's `bar` with it.
    const merged = mergeAdopt(
      { input: { bar: "on", tapFocus: "terminal" } },
      { input: { tapFocus: "field" } },
    ) as Record<string, any>;
    expect(merged.input).toEqual({ bar: "on", tapFocus: "field" });
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
