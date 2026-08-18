/**
 * Loading a skill injects its whole SKILL.md into the transcript as text the
 * operator never wrote — 312 of them across this box's transcripts, median
 * 3,125 characters and up to 23,342. It rendered as an enormous message in the
 * middle of the conversation (Viktor, 2026-08-18: "the text area should not
 * include skill definitions").
 *
 * The load is worth one line: a skill the MODEL chose otherwise changes how it
 * behaves with nothing in the transcript to say why. So the body becomes a
 * meta row naming the skill — the divider kind, not a message.
 */
import { describe, it, expect } from "vitest";
import { deriveRows } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

let n = 1;
const ev = (e: Partial<Event> & Pick<Event, "kind">): Event =>
  ({ id: n++, session: "s", ...e }) as Event;

describe("a skill load in the transcript", () => {
  it("is one row naming the skill, not its definition", () => {
    const rows = deriveRows([
      ev({ kind: "user", body: "/wrap-up" }),
      ev({ kind: "meta", meta: "skill", body: "wrap-up" }),
      ev({ kind: "text", body: "Running wrap-up." }),
    ]) as Array<{ kind: string; body?: string; meta?: string }>;

    const skill = rows.find((r) => r.kind === "meta" && r.meta === "skill");
    expect(skill, "the load is shown").toBeTruthy();
    expect(skill!.body).toBe("wrap-up");
    // and nothing carries the definition itself
    expect(rows.some((r) => (r.body ?? "").includes("Base directory"))).toBe(false);
  });

  it("keeps the conversation around it", () => {
    const rows = deriveRows([
      ev({ kind: "user", body: "/doc-tone plan.md" }),
      ev({ kind: "meta", meta: "skill", body: "doc-tone" }),
      ev({ kind: "text", body: "on it" }),
    ]) as Array<{ kind: string; body?: string }>;
    expect(rows.some((r) => r.kind === "user" && r.body === "/doc-tone plan.md")).toBe(true);
    expect(rows.some((r) => r.kind === "message" && r.body === "on it")).toBe(true);
  });
});
