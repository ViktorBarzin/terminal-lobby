import { describe, it, expect } from "vitest";
import {
  canRun,
  effectiveCommand,
  COMMAND_LABELS,
  COMMAND_PHRASES,
  NEW_SESSION_COMMANDS,
} from "../src/lib/new-commands";
import { NEW_COMMANDS, type NewCommand } from "../src/store/prefs";

const OFFERED: readonly NewCommand[] = ["claude", "codex", "shell"];

describe("canRun — silence means yes", () => {
  it("takes an explicit false as unavailable", () => {
    expect(canRun("codex", { codex: false })).toBe(false);
  });

  it("takes an explicit true as available", () => {
    expect(canRun("claude", { claude: true })).toBe(true);
  });

  // Every failure path lands here: request refused, probe errored, a login
  // shell that printed a banner where an answer should have been. All of them
  // must leave the option enabled rather than take a working tool away.
  it("treats a key the server said nothing about as available", () => {
    expect(canRun("claude", {})).toBe(true);
    expect(canRun("codex", { claude: true })).toBe(true);
  });
});

describe("effectiveCommand — a preference outlives the tool it names", () => {
  it("keeps the preference when it runs", () => {
    expect(effectiveCommand("claude", { claude: true, codex: false }, OFFERED)).toBe("claude");
  });

  it("falls back to the first offered command that runs", () => {
    expect(effectiveCommand("codex", { claude: true, codex: false }, OFFERED)).toBe("claude");
  });

  it("skips past every unavailable one", () => {
    expect(
      effectiveCommand("claude", { claude: false, codex: false, shell: true }, OFFERED),
    ).toBe("shell");
  });

  // `default` is a valid stored value for launcher accounts and is not one of
  // the three the row offers, so it resolves like any other unoffered key.
  it("resolves a preference the row does not offer", () => {
    expect(effectiveCommand("default", { claude: true }, OFFERED)).toBe("claude");
  });

  it("returns the preference unchanged when nothing at all is runnable", () => {
    const none = { claude: false, codex: false, shell: false };
    expect(effectiveCommand("claude", none, OFFERED)).toBe("claude");
  });

  it("changes nothing when the server said nothing", () => {
    for (const k of OFFERED) expect(effectiveCommand(k, {}, OFFERED)).toBe(k);
  });
});

// The labels moved out of the sidebar row so the Settings page could show the
// same words. A key with no label would render blank in one of the two.
// The composer's controls are a row of bare values with no heading over them,
// so each has to say what it sets. That only works if the noun is actually in
// the phrase — a map that quietly lost one would put the row back to "code",
// "Claude", "Opus" and read as three unrelated words.
describe("COMMAND_PHRASES", () => {
  it("says what it does for every command the box offers", () => {
    for (const k of NEW_SESSION_COMMANDS) {
      expect(COMMAND_PHRASES[k], `no phrase for ${k}`).toBeTruthy();
      // A verb or a noun, but never the bare product name the label already is.
      expect(COMMAND_PHRASES[k], `${k} is still a bare label`).not.toBe(
        COMMAND_LABELS[k],
      );
    }
  });

  it("stays lowercase at the start, being a fragment and not a heading", () => {
    for (const k of NEW_SESSION_COMMANDS) {
      const first = COMMAND_PHRASES[k]!.charAt(0);
      expect(first, `${k} starts uppercase`).toBe(first.toLowerCase());
    }
  });
});

describe("COMMAND_LABELS", () => {
  it("names every command the prefs type allows", () => {
    for (const k of NEW_COMMANDS) {
      expect(COMMAND_LABELS[k], `no label for ${k}`).toBeTruthy();
    }
  });
});
