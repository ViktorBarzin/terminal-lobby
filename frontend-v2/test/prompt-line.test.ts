/**
 * The line a session shows before Claude's summary lands.
 *
 * A session's name is an opaque id (ADR-0019) and its title arrives seconds
 * later, from Claude's own summary of the conversation (tmux-api/autotitle.go).
 * In between, the card shows the first line of the prompt the session was
 * created with — the person typed it seconds earlier, so it is the most
 * recognisable thing available.
 *
 * Per-browser and never roamed, like store/drafts.ts: the record exists to
 * cover a few seconds in the tab that did the creating, and the summary that
 * replaces it reaches every device on its own.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  PROMPT_LINES_KEY,
  forgetPromptLine,
  promptLineFor,
  prunePromptLines,
  rememberPromptLine,
} from "../src/store/prompt-line";
import { firstPromptLine } from "../src/lib/title";

beforeEach(() => localStorage.clear());

describe("firstPromptLine", () => {
  it("takes the first line, not the whole prompt", () => {
    expect(firstPromptLine("Fix the deploy\n\nIt 500s on the second push")).toBe(
      "Fix the deploy",
    );
  });

  it("skips blank leading lines rather than yielding nothing", () => {
    expect(firstPromptLine("\n\n  Look at the logs\nthen tell me")).toBe("Look at the logs");
  });

  it("normalizes the line the way a title is normalized", () => {
    // Same cap and the same whitespace collapsing, so what the card shows
    // before the summary and what it shows after are the same kind of string.
    expect(firstPromptLine("a\tb   c")).toBe("a b c");
    expect([...firstPromptLine("x".repeat(200))].length).toBe(64);
  });

  it("is empty for an empty prompt, which is what 'New session' answers", () => {
    expect(firstPromptLine("")).toBe("");
    expect(firstPromptLine("   \n\t\n")).toBe("");
  });
});

describe("the prompt-line store", () => {
  it("remembers a line for one session and hands it back", () => {
    rememberPromptLine("k7m2q9x4tp0v", "Fix the deploy");
    expect(promptLineFor("k7m2q9x4tp0v")).toBe("Fix the deploy");
    expect(promptLineFor("somethingelse")).toBeNull();
  });

  it("stores nothing for an empty line", () => {
    rememberPromptLine("k7m2q9x4tp0v", "");
    expect(promptLineFor("k7m2q9x4tp0v")).toBeNull();
    expect(localStorage.getItem(PROMPT_LINES_KEY)).toBeNull();
  });

  it("forgets one, which is what a real title arriving means", () => {
    rememberPromptLine("k7m2q9x4tp0v", "Fix the deploy");
    forgetPromptLine("k7m2q9x4tp0v");
    expect(promptLineFor("k7m2q9x4tp0v")).toBeNull();
  });

  it("prunes to the live list, and treats an EMPTY list as no information", () => {
    rememberPromptLine("aaaaaaaaaaaa", "one");
    rememberPromptLine("bbbbbbbbbbbb", "two");
    // A poll in flight, or a briefly unreachable tmux, must not wipe the device.
    prunePromptLines([]);
    expect(promptLineFor("aaaaaaaaaaaa")).toBe("one");
    prunePromptLines(["aaaaaaaaaaaa"]);
    expect(promptLineFor("aaaaaaaaaaaa")).toBe("one");
    expect(promptLineFor("bbbbbbbbbbbb")).toBeNull();
  });

  it("survives corrupt storage rather than throwing into a render", () => {
    localStorage.setItem(PROMPT_LINES_KEY, "{not json");
    expect(promptLineFor("aaaaaaaaaaaa")).toBeNull();
    rememberPromptLine("aaaaaaaaaaaa", "one");
    expect(promptLineFor("aaaaaaaaaaaa")).toBe("one");
  });
});
