import { describe, it, expect } from "vitest";
import {
  completionFor,
  composeMessage,
  modeLabel,
  nextMode,
  PERMISSION_MODES,
} from "../src/components/compose.logic";

const files = ["main.go", "main_test.go", "registry.go", "sub/"];

describe("slash completion", () => {
  it("offers the commands that match what has been typed", () => {
    const c = completionFor("/co", 3, []);
    expect(c?.trigger).toBe("/");
    expect(c?.items).toContain("/compact");
    expect(c?.items).toContain("/config");
    expect(c?.items).not.toContain("/clear");
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
    expect(c?.items).toEqual(["@main.go", "@main_test.go"]);
  });

  it("keeps the directory prefix when completing a nested path", () => {
    const c = completionFor("@session-events/reg", 19, files);
    expect(c?.dir).toBe("session-events/");
    expect(c?.items).toEqual(["@session-events/registry.go"]);
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
    expect(completionFor("@zzz", 4, files)?.items).toEqual([]);
  });
});

describe("mode cycling", () => {
  it("walks the CLI's cycle and wraps", () => {
    expect(nextMode("default")).toBe("acceptEdits");
    expect(nextMode("plan")).toBe("default");
  });

  // Landing on bypassPermissions by pressing a key once too often would turn
  // every later tool call silent; it is a startup choice, not a cycle stop.
  it("never cycles into bypassPermissions", () => {
    expect(PERMISSION_MODES).not.toContain("bypassPermissions");
    expect(nextMode("bypassPermissions")).toBe("default");
  });
});

describe("the mode chip's label", () => {
  // `bypassPermissions` beside the input crowded out both the message field and
  // the Send button at 390px.
  it("shortens the long mode names", () => {
    expect(modeLabel("bypassPermissions")).toBe("bypass");
    expect(modeLabel("acceptEdits")).toBe("auto-edit");
    expect(modeLabel("default")).toBe("ask");
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
