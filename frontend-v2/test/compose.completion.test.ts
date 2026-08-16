import { describe, it, expect } from "vitest";
import { completionFor, nextMode, PERMISSION_MODES } from "../src/components/compose.logic";

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
