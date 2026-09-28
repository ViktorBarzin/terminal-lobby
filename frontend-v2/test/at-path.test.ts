/**
 * Where an `@` token's directory is listed from. Found in the first deployed
 * review (2026-09-28): a session outside a project had no directory, so
 * "@no" listed "/", file-api refused it, and the menu never opened.
 */
import { describe, expect, it } from "vitest";
import { atListTarget } from "../src/lib/at-path";

describe("atListTarget", () => {
  it("lists a relative token from the session's own directory", () => {
    expect(atListTarget("", { cwd: "/home/w/qa/rd1" })).toBe("/home/w/qa/rd1/");
    expect(atListTarget("src/", { cwd: "/home/w/app", projectDir: "/home/w/other" })).toBe(
      "/home/w/app/src/",
    );
  });

  it("falls back to the project's directory when the session reports none", () => {
    expect(atListTarget("src/", { projectDir: "/home/w/app/" })).toBe("/home/w/app/src/");
  });

  it("takes an absolute token as it is", () => {
    expect(atListTarget("/home/w/x/", { cwd: "/home/w/app" })).toBe("/home/w/x/");
  });

  it("has nothing to list for a relative token with no directory to start from", () => {
    expect(atListTarget("no/", {})).toBeNull();
    expect(atListTarget("", { cwd: "", projectDir: "" })).toBeNull();
  });
});
