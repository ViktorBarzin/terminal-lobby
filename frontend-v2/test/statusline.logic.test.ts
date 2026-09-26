/**
 * The thin line above the composer's pill: which state it reports, and how
 * much of it fits.
 *
 * The line replaced two things, the working row at the foot of the timeline
 * and the background strip under it (Quiet line composer, 2026-09-24). Its
 * state is one function with one precedence, the prototype's: someone
 * watching sees that they are watching, then the open turn (waiting or
 * working), then work the session still owes after its turn, then nothing.
 */
import { describe, it, expect } from "vitest";
import { lineState, roomFor, shortTarget, splitReason } from "../src/components/statusline.logic";
import { deriveRows, liveRow, type WorkingRow } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const row = (over: Partial<WorkingRow> = {}): WorkingRow => ({
  kind: "working",
  key: "working-t1",
  turnKey: "t1",
  steps: 3,
  ...over,
});

describe("lineState", () => {
  it("says nothing when nothing is happening", () => {
    expect(lineState({})).toEqual({ kind: "idle" });
  });

  it("reports the open turn as working while something runs", () => {
    const live = row({ tool: "Edit", toolLabel: "a.ts" });
    expect(lineState({ live })).toEqual({ kind: "working", row: live });
  });

  it("reports it as waiting while Claude is stopped on the reader", () => {
    const live = row({ waiting: true });
    expect(lineState({ live })).toEqual({ kind: "waiting", row: live });
  });

  it("puts watching ahead of the turn, since nothing here can act on it", () => {
    expect(lineState({ live: row(), inertReason: "Watching: this device does not type" })).toEqual({
      kind: "watching",
      reason: "Watching: this device does not type",
    });
  });

  // The transcript closes the turn when the main thread stops talking, while
  // an agent it started keeps going. Background work only speaks once no turn
  // is open, so it never doubles up with the turn's own words.
  it("puts the open turn ahead of background work", () => {
    const live = row();
    expect(lineState({ live, background: "2 agents" }).kind).toBe("working");
    expect(lineState({ background: "2 agents" })).toEqual({
      kind: "background",
      label: "2 agents",
    });
  });
});

describe("liveRow", () => {
  const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

  it("finds the open turn's working row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "b1", body: '{"command":"ls"}' }),
    ]);
    const live = liveRow(rows);
    expect(live?.kind).toBe("working");
    expect(live?.tool).toBe("Bash");
  });

  it("finds nothing once the turn has ended", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "text", body: "done" }),
      ev({ id: 3, kind: "turn_end" }),
    ]);
    expect(liveRow(rows)).toBeUndefined();
  });
});

describe("shortTarget", () => {
  it("shows a path by its file name", () => {
    expect(shortTarget("frontend-v2/src/components/QuestionCard.tsx")).toBe("QuestionCard.tsx");
    expect(shortTarget("/home/wizard/code/infra/")).toBe("infra");
  });

  it("shows a command whole, since its first word is not its point", () => {
    expect(shortTarget("npx vitest run QuestionCard")).toBe("npx vitest run QuestionCard");
    expect(shortTarget("cd /srv && ls")).toBe("cd /srv && ls");
    expect(shortTarget("ls")).toBe("ls");
  });

  it("leaves an address alone", () => {
    expect(shortTarget("https://example.com/a/b")).toBe("https://example.com/a/b");
  });
});

describe("splitReason", () => {
  it("names who is being watched, and keeps the rest as the reason", () => {
    expect(splitReason("Watching emo — take control to type in their session")).toEqual({
      head: "Watching emo",
      rest: "take control to type in their session",
    });
    expect(splitReason("Watching: this device does not type into the session")).toEqual({
      head: "Watching",
      rest: "this device does not type into the session",
    });
  });

  it("falls back to the plain word when the reason has no head of its own", () => {
    expect(splitReason("view only")).toEqual({ head: "Watching", rest: "view only" });
  });
});

describe("roomFor", () => {
  // Container queries would be the natural tool, and Safari 15.6, the oldest
  // engine served (lib/baseline-polyfills.ts), has none. The line measures its
  // own width instead and folds by these bands.
  it.each([
    [1000, "wide"],
    [781, "wide"],
    [780, "mid"],
    [601, "mid"],
    [600, "narrow"],
    [461, "narrow"],
    [460, "tight"],
    [320, "tight"],
  ])("puts %ipx in the %s band", (w, room) => {
    expect(roomFor(w)).toBe(room);
  });

  it("stays wide where nothing can be measured", () => {
    expect(roomFor(0)).toBe("wide");
  });
});
