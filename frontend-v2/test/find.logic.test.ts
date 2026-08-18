import { describe, expect, it } from "vitest";
import { hitLabel, hitWhen, isLoaded } from "../src/components/find.logic";
import type { Event, SearchHit } from "../src/types/events";

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return { id: 1, kind: "text", field: "message", snippet: "…", ...over };
}

describe("hitLabel", () => {
  it("names who said it, in the timeline's own words", () => {
    expect(hitLabel(hit({ kind: "user", field: "message" }))).toBe("you");
    expect(hitLabel(hit({ kind: "text", field: "message" }))).toBe("Claude");
    expect(hitLabel(hit({ kind: "thinking", field: "thinking" }))).toBe("thinking");
  });

  it("names the tool when there is one, since that is the question being asked", () => {
    expect(hitLabel(hit({ kind: "tool_result", field: "result", tool: "Bash" }))).toBe(
      "Bash · result",
    );
    expect(hitLabel(hit({ kind: "tool_use", field: "input", tool: "Edit" }))).toBe("Edit · input");
  });

  it("falls back to the field when the tool is unknown", () => {
    expect(hitLabel(hit({ kind: "tool_result", field: "result" }))).toBe("result");
  });
});

describe("hitWhen", () => {
  const now = new Date("2026-08-18T20:00:00").getTime();

  it("is empty when the transcript recorded no time", () => {
    expect(hitWhen(undefined, now)).toBe("");
  });

  it("shows a time for today", () => {
    expect(hitWhen(new Date("2026-08-18T14:02:00").getTime(), now)).toBe("14:02");
  });

  it("says yesterday rather than a bare time", () => {
    expect(hitWhen(new Date("2026-08-17T11:40:00").getTime(), now)).toBe("yesterday 11:40");
  });

  it("counts days inside the week", () => {
    expect(hitWhen(new Date("2026-08-15T09:05:00").getTime(), now)).toBe("3d ago 09:05");
  });

  // A long session spans weeks; a bare time there would be actively misleading.
  it("dates anything older", () => {
    expect(hitWhen(new Date("2026-07-30T16:20:00").getTime(), now)).toBe("30 Jul 16:20");
  });
});

describe("isLoaded", () => {
  const events = (ids: number[]): Event[] =>
    ids.map((id) => ({ id, kind: "text", session: "demo" }) as Event);

  it("is false when the client holds nothing", () => {
    expect(isLoaded([], 5)).toBe(false);
  });

  it("is true for an id at or after the oldest event held", () => {
    expect(isLoaded(events([10, 11, 12]), 10)).toBe(true);
    expect(isLoaded(events([10, 11, 12]), 12)).toBe(true);
  });

  // The window opens on the last 20 turns; a hit from 4,000 records ago sits
  // before everything held, and reaching it needs "Load earlier" steps.
  it("is false for an id older than the window", () => {
    expect(isLoaded(events([10, 11, 12]), 9)).toBe(false);
  });
});
