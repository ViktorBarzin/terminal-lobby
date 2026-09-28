/**
 * A fresh Claude session names its model before its transcript does.
 *
 * Found in the T3 pass's live check on 2026-09-28: a session with no reply yet
 * had a model button reading "Model", with no model and no effort ticked in
 * its sheet. The transcript names the model on Claude's first reply, and Claude
 * Code writes no transcript at all before the first prompt. The pane's
 * start-up banner already says it: "claude-opus-5-5 with high effort · Claude
 * API" (CLI 2.1.283, where managed settings make the slug the display name).
 */
import { describe, it, expect } from "vitest";
import { modelFromBanner } from "../src/lib/models";

const BANNER = [
  " ▐▛███▛█   Claude Code v2.1.283",
  "▝▜██████▀  claude-opus-5-5 with high effort · Claude API",
  " ▝▝   ▝▝   /var/tmp/t3stop/proj",
  "",
  "─".repeat(40),
  "❯ ",
].join("\n");

describe("modelFromBanner", () => {
  it("reads the model and effort off the start-up banner", () => {
    expect(modelFromBanner(BANNER)).toEqual({ model: "claude-opus-5-5", effort: "high" });
  });

  it("reads a 1M model and a level the CLI names in one word", () => {
    expect(modelFromBanner("▝▜██████▀  claude-opus-5[1m] with xhigh effort · Claude API")).toEqual({
      model: "claude-opus-5[1m]",
      effort: "xhigh",
    });
  });

  it("says nothing for a pane without the banner", () => {
    expect(modelFromBanner("❯ hello\n  ⏵⏵ auto mode on")).toBeUndefined();
  });

  it("does not take a model named in the conversation for the banner", () => {
    expect(modelFromBanner("● I ran claude-sonnet-5 with high effort yesterday.")).toBeUndefined();
  });
});
