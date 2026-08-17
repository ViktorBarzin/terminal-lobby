import { describe, it, expect } from "vitest";
import {
  completionFor,
  composeMessage,
  modeFromPane,
  modeLabel,
} from "../src/components/compose.logic";

const files = ["main.go", "main_test.go", "registry.go", "sub/"];

/** The names offered, in order. */
const values = (c: { items: { value: string }[] } | null): string[] =>
  (c?.items ?? []).map((i) => i.value);

describe("slash completion", () => {
  it("offers the commands that match what has been typed", () => {
    const c = completionFor("/co", 3, []);
    expect(c?.trigger).toBe("/");
    expect(values(c)).toContain("/compact");
    expect(values(c)).toContain("/config");
    // A prefix match comes first; /clear can still appear further down on a
    // description match, but never ahead of them.
    expect(values(c).indexOf("/compact")).toBeLessThan(values(c).indexOf("/clear") === -1 ? 99 : values(c).indexOf("/clear"));
  });

  it("carries each command's description into the menu", () => {
    // The row is what makes 148 commands usable: the name alone does not say
    // what /btw or /fork do.
    const c = completionFor("/compact", 8, []);
    expect(c?.items[0]?.value).toBe("/compact");
    expect(c?.items[0]?.description).toMatch(/summar/i);
  });

  // `cd /usr` should not open a command menu.
  it("only fires at the very start of the message", () => {
    expect(completionFor("cd /us", 6, [])).toBeNull();
  });

  it("goes quiet once the command is complete and a space follows", () => {
    expect(completionFor("/compact ", 9, [])).toBeNull();
  });
});

describe("@ path completion", () => {
  it("filters the listing by the stem typed so far", () => {
    const c = completionFor("look at @main", 13, files);
    expect(c?.trigger).toBe("@");
    expect(values(c)).toEqual(["@main.go", "@main_test.go"]);
  });

  it("keeps the directory prefix when completing a nested path", () => {
    const c = completionFor("@session-events/reg", 19, files);
    expect(c?.dir).toBe("session-events/");
    expect(values(c)).toEqual(["@session-events/registry.go"]);
  });

  it("offers everything for a bare @", () => {
    const c = completionFor("@", 1, files);
    expect(c?.items).toHaveLength(files.length);
  });

  // An email address in a prompt is not a file reference.
  it("does not fire mid-token", () => {
    expect(completionFor("mail me@example.com", 19, files)).toBeNull();
  });

  it("returns no items rather than throwing when nothing matches", () => {
    expect(values(completionFor("@zzz", 4, files))).toEqual([]);
  });
});

/**
 * Reading the mode off the pane.
 *
 * The transcript is not a live source: measured 2026-08-17, Shift+Tab moved a
 * session from bypass to auto in 40ms and the transcript still said bypass
 * twenty minutes later, because the CLI writes that record when a TURN happens,
 * not when the mode changes. These are the real status lines from that session,
 * one per stop of the CLI's own Shift+Tab cycle.
 */
describe("the permission mode, read off the pane", () => {
  const line = (s: string) => `\n\u2500\u2500\u2500\u2500\n  ${s} \u00b7 \u2190 for agents\n`;

  it("reads every stop of the cycle", () => {
    expect(modeFromPane(line("\u23f5\u23f5 bypass permissions on (shift+tab to cycle)")))
      .toBe("bypassPermissions");
    expect(modeFromPane(line("\u23f5\u23f5 auto mode on (shift+tab to cycle)"))).toBe("auto");
    // The one stop that carries no "(shift+tab to cycle)" tail.
    expect(modeFromPane(line("\u23f8 manual mode on"))).toBe("manual");
    expect(modeFromPane(line("\u23f5\u23f5 accept edits on (shift+tab to cycle)")))
      .toBe("acceptEdits");
    expect(modeFromPane(line("\u23f8 plan mode on (shift+tab to cycle)"))).toBe("plan");
  });

  it("says nothing when the pane says nothing", () => {
    expect(modeFromPane("")).toBe("");
    expect(modeFromPane("$ ls\nREADME.md\n$ ")).toBe("");
  });

  it("takes the LAST line, so scrollback cannot outrank the live one", () => {
    // A pane holds scrollback, and a transcript quoting an older status line is
    // ordinary content in it.
    const pane =
      "someone pasted: \u23f5\u23f5 bypass permissions on (shift+tab to cycle)\n" +
      "\u2026 lots of output \u2026\n" +
      "  \u23f8 plan mode on (shift+tab to cycle) \u00b7 \u2190 for agents\n";
    expect(modeFromPane(pane)).toBe("plan");
  });
});

describe("the mode chip's label", () => {
  // `bypassPermissions` beside the input crowded out both the message field and
  // the Send button at 390px.
  it("shortens the long mode names, in the CLI's own words", () => {
    expect(modeLabel("bypassPermissions")).toBe("bypass");
    expect(modeLabel("acceptEdits")).toBe("edits");
    expect(modeLabel("auto")).toBe("auto");
    expect(modeLabel("plan")).toBe("plan");
    expect(modeLabel("manual")).toBe("manual");
    expect(modeLabel("dontAsk")).toBe("no ask");
  });

  // `default` is what the CLI called `manual` before the rename, and it is
  // still what older transcripts in ~/.claude/projects say — 281 of those
  // records against 0 saying `manual` when this was written.
  it("reads a pre-rename `default` as manual", () => {
    expect(modeLabel("default")).toBe("manual");
  });

  it("passes an unfamiliar mode through unchanged", () => {
    expect(modeLabel("somethingNew")).toBe("somethingNew");
  });
});

// --- the wire format an attachment produces --------------------------------
// docs/plans/2026-08-17-text-view-attachments-design.md decision 9: the paths
// come first, one per line, then the prose. Bracketed paste (sessionio/tmux.go
// pastes, then sends a separate Enter) makes the newlines soft, so a multi-line
// prompt is one message rather than several submits.
describe("composeMessage", () => {
  const a = "/var/lib/clipboard-store/wizard/qa/pasted-20260817-a1.png";
  const b = "/var/lib/clipboard-store/wizard/qa/file-20260817-abcd-report.pdf";

  it("is just the text when nothing is attached", () => {
    expect(composeMessage("what's wrong here?", [])).toBe("what's wrong here?");
  });

  it("puts each path on its own line ahead of the prose", () => {
    expect(composeMessage("what's wrong, vs the pdf?", [a, b])).toBe(
      `${a}\n${b}\nwhat's wrong, vs the pdf?`,
    );
  });

  it("sends the paths alone when there is no prose", () => {
    expect(composeMessage("", [a])).toBe(a);
    expect(composeMessage("   ", [a])).toBe(a);
  });

  it("trims the prose but keeps its interior newlines", () => {
    expect(composeMessage("  line one\nline two  ", [a])).toBe(`${a}\nline one\nline two`);
  });

  it("has nothing to send when both halves are empty", () => {
    expect(composeMessage("", [])).toBe("");
    expect(composeMessage("  \n ", [])).toBe("");
  });

  it("drops a duplicate path rather than asking Claude to read it twice", () => {
    expect(composeMessage("look", [a, a])).toBe(`${a}\nlook`);
  });
});
