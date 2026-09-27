/**
 * The session bar's subtitle: "project · state", the line under the title in
 * the T3 header (docs/plans/2026-09-27-text-view-t3-pass.md, "Phone header").
 * The prototype draws "code · working" with a pulsing running dot; this is the
 * word and the dot it shows for every state the session list reports.
 */
import { describe, it, expect } from "vitest";
import { headerSubtitle } from "../src/components/header.logic";

const base = { project: "code", watching: false } as const;

describe("headerSubtitle", () => {
  it.each([
    ["running", "working", "code · working"],
    ["awaiting", "waiting", "code · waiting for you"],
    ["done", "idle", "code · idle"],
    ["suspended", "suspended", "code · suspended"],
  ] as const)("reads %s as the %s dot and %j", (state, dot, text) => {
    expect(headerSubtitle({ ...base, state })).toEqual({ dot, text });
  });

  it("says watching over whatever the session is doing, since this device cannot act", () => {
    expect(headerSubtitle({ ...base, state: "awaiting", watching: true })).toEqual({
      dot: "watching",
      text: "code · watching",
    });
  });

  it("appends the background work a session still owes", () => {
    expect(headerSubtitle({ ...base, state: "running", background: { agents: 2 } }).text).toBe(
      "code · working · 2 agents",
    );
    expect(
      headerSubtitle({ ...base, state: "done", background: { agents: 1, workflows: 1 } }).text,
    ).toBe("code · idle · 1 agent, 1 workflow");
  });

  // A suspended session has no process left, so nothing it launched is running.
  it("leaves background work off a suspended session", () => {
    expect(headerSubtitle({ ...base, state: "suspended", background: { agents: 2 } }).text).toBe(
      "code · suspended",
    );
  });

  it("drops the project for an ungrouped session rather than printing an empty slot", () => {
    expect(headerSubtitle({ project: "", state: "running", watching: false }).text).toBe("working");
    expect(headerSubtitle({ state: "done", watching: false }).text).toBe("idle");
  });

  it("calls a session with no Claude state a shell when it runs one, idle otherwise", () => {
    expect(headerSubtitle({ ...base, state: "", tool: "shell" })).toEqual({
      dot: "idle",
      text: "code · shell",
    });
    expect(headerSubtitle({ ...base, state: undefined })).toEqual({
      dot: "idle",
      text: "code · idle",
    });
  });
});
