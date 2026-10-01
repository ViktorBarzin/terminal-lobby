/**
 * The pure half of the session browser in the lobby
 * (docs/plans/2026-10-01-session-browser-design.md): which stretches of the
 * transcript are Browsing runs, where each run's Browser card sits, what its
 * header says, where a click on the scaled page lands in the page, and when a
 * card or the panel may ask the host for frames.
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, visibleRows } from "../src/components/timeline.logic";
import {
  browsingRuns,
  callSummary,
  cardAnchors,
  pagePoint,
  streamWanted,
} from "../src/components/browser.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const PW = "mcp__playwright__";
let ids = 100;
/** A call and its result, in one go. */
const call = (tool: string, input: object, opts: { done?: boolean; at?: number } = {}): Event[] => {
  const toolId = `t${++ids}`;
  const use = ev({
    id: ++ids,
    kind: "tool_use",
    tool,
    toolId,
    body: JSON.stringify(input),
    at: opts.at,
  });
  if (opts.done === false) return [use];
  return [use, ev({ id: ++ids, kind: "tool_result", toolId, body: "ok", at: opts.at })];
};
const user = (body: string): Event => ev({ id: ++ids, kind: "user", body });
const text = (body: string): Event => ev({ id: ++ids, kind: "text", body });
const end = (): Event => ev({ id: ++ids, kind: "turn_end" });

describe("browsing runs, read off the transcript", () => {
  it("is one run from the first browser call to the end of the turn", () => {
    const rows = deriveRows([
      user("look it up"),
      ...call("Bash", { command: "ls" }),
      ...call(`${PW}browser_navigate`, { url: "https://en.wikipedia.org/wiki/Tmux" }),
      ...call(`${PW}browser_snapshot`, {}),
      text("Found it."),
      end(),
    ]);
    const runs = browsingRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.calls.map((c) => c.tool)).toEqual([
      `${PW}browser_navigate`,
      `${PW}browser_snapshot`,
    ]);
    // The turn ended, so the run is a record now.
    expect(runs[0]!.current).toBe(false);
    expect(runs[0]!.closed).toBe(false);
  });

  it("is current while its turn is still open", () => {
    const rows = deriveRows([
      user("look it up"),
      ...call(`${PW}browser_navigate`, { url: "https://example.com" }),
      ...call(`${PW}browser_click`, { element: "More info" }, { done: false }),
    ]);
    const [run] = browsingRuns(rows);
    expect(run!.current).toBe(true);
  });

  it("spans the replies between calls in the same turn", () => {
    const rows = deriveRows([
      user("look it up"),
      ...call(`${PW}browser_navigate`, { url: "https://example.com" }),
      text("The page loaded, now clicking."),
      ...call(`${PW}browser_click`, { element: "More info" }, { done: false }),
    ]);
    const runs = browsingRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.calls).toHaveLength(2);
  });

  it("ends at browser_close, and a later call in the same turn starts another", () => {
    const rows = deriveRows([
      user("two lookups"),
      ...call(`${PW}browser_navigate`, { url: "https://a.example" }),
      ...call(`${PW}browser_close`, {}),
      ...call(`${PW}browser_navigate`, { url: "https://b.example" }, { done: false }),
    ]);
    const runs = browsingRuns(rows);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.closed).toBe(true);
    expect(runs[0]!.current).toBe(false);
    expect(runs[1]!.current).toBe(true);
    expect(runs[0]!.key).not.toBe(runs[1]!.key);
  });

  it("starts a new run in each turn, and only the last can be current", () => {
    const rows = deriveRows([
      user("first"),
      ...call(`${PW}browser_navigate`, { url: "https://a.example" }),
      end(),
      user("second"),
      ...call(`${PW}browser_snapshot`, {}, { done: false }),
    ]);
    const runs = browsingRuns(rows);
    expect(runs.map((r) => r.current)).toEqual([false, true]);
  });

  it("keeps its key while the run grows, so its card is not remounted", () => {
    const first = [user("go"), ...call(`${PW}browser_navigate`, { url: "https://a.example" })];
    const before = browsingRuns(deriveRows(first))[0]!.key;
    const after = browsingRuns(
      deriveRows([...first, ...call(`${PW}browser_click`, { element: "x" }), text("done"), end()]),
    )[0]!.key;
    expect(after).toBe(before);
  });

  it("finds runs a settled turn's fold hides", () => {
    const rows = deriveRows([
      user("look"),
      ...call(`${PW}browser_navigate`, { url: "https://a.example" }),
      text("checking"),
      ...call("Bash", { command: "ls" }),
      text("Done."),
      end(),
    ]);
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(true);
    expect(browsingRuns(rows)).toHaveLength(1);
  });

  it("has none in a session that never browsed", () => {
    expect(
      browsingRuns(deriveRows([user("hi"), ...call("Bash", { command: "ls" }), end()])),
    ).toEqual([]);
  });
});

describe("where a run's card is drawn", () => {
  const events = [
    user("look"),
    ...call(`${PW}browser_navigate`, { url: "https://a.example" }),
    text("checking"),
    ...call("Bash", { command: "ls" }),
    text("Done."),
    end(),
  ];

  it("goes after the fold of a folded turn, so the record stays in view", () => {
    const rows = deriveRows(events);
    const runs = browsingRuns(rows);
    const anchors = cardAnchors(runs, visibleRows(rows, new Set()));
    const fold = rows.find((r) => r.kind === "turn-fold")!;
    expect(anchors.get(fold.key)).toEqual([runs[0]!.key]);
    expect(anchors.size).toBe(1);
  });

  it("moves to its work group when the fold is opened, and is drawn once", () => {
    const rows = deriveRows(events);
    const runs = browsingRuns(rows);
    const fold = rows.find((r) => r.kind === "turn-fold")!;
    const anchors = cardAnchors(runs, visibleRows(rows, new Set([fold.turnKey])));
    expect(anchors.get(runs[0]!.groupKey)).toEqual([runs[0]!.key]);
    expect(anchors.has(fold.key)).toBe(false);
    expect([...anchors.values()].flat()).toHaveLength(1);
  });

  it("goes after the work group holding the run's first call in an open turn", () => {
    const rows = deriveRows([
      user("look"),
      ...call(`${PW}browser_navigate`, { url: "https://a.example" }, { done: false }),
    ]);
    const runs = browsingRuns(rows);
    const anchors = cardAnchors(runs, visibleRows(rows, new Set()));
    const group = rows.find((r) => r.kind === "work-group")!;
    expect(anchors.get(group.key)).toEqual([runs[0]!.key]);
  });

  it("draws nothing for a run whose rows are not in the list", () => {
    const rows = deriveRows(events);
    const runs = browsingRuns(rows);
    expect(cardAnchors(runs, []).size).toBe(0);
  });
});

describe("what the card's header says about a call", () => {
  it.each([
    ["browser_navigate", { url: "https://www.wikipedia.org/wiki/X" }, "Loading wikipedia.org"],
    ["browser_navigate", { url: "file:///etc/passwd" }, "Loading a page"],
    ["browser_click", { element: "Sign in button" }, "Clicking Sign in button"],
    ["browser_click", {}, "Clicking on the page"],
    ["browser_type", { element: "Search", text: "secret words" }, "Typing into Search"],
    ["browser_snapshot", {}, "Reading the page"],
    ["browser_tabs", { action: "new" }, "Opening a tab"],
    ["browser_tabs", { action: "list" }, "Listing tabs"],
    ["browser_close", {}, "Closing the browser"],
    ["browser_some_new_tool", {}, "Using some new tool"],
  ])("%s %j reads %s", (name, input, want) => {
    expect(callSummary(`${PW}${name}`, JSON.stringify(input))).toBe(want);
  });

  it("never repeats what was typed", () => {
    expect(callSummary(`${PW}browser_type`, JSON.stringify({ text: "hunter2" }))).not.toContain(
      "hunter2",
    );
  });

  it("survives input that is not JSON", () => {
    expect(callSummary(`${PW}browser_click`, "{not json")).toBe("Clicking on the page");
  });

  it("clips a long element name", () => {
    const s = callSummary(`${PW}browser_click`, JSON.stringify({ element: "x".repeat(300) }));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("a point on the scaled page, in the page's own CSS pixels", () => {
  const viewport = { w: 1280, h: 800 };
  const frame = { w: 1280, h: 800 };

  it("maps the corners of a box the frame fills exactly", () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };
    expect(pagePoint(100, 50, box, frame, viewport)).toEqual({ x: 0, y: 0 });
    expect(pagePoint(740, 450, box, frame, viewport)).toEqual({ x: 1280, y: 800 });
    expect(pagePoint(420, 250, box, frame, viewport)).toEqual({ x: 640, y: 400 });
  });

  it("allows for the bars a taller box leaves above and below", () => {
    // 640x600 box: the 16:10 picture is 640x400, centred, so 100px bars.
    const box = { left: 0, top: 0, width: 640, height: 600 };
    expect(pagePoint(0, 100, box, frame, viewport)).toEqual({ x: 0, y: 0 });
    expect(pagePoint(320, 300, box, frame, viewport)).toEqual({ x: 640, y: 400 });
    expect(pagePoint(320, 50, box, frame, viewport)).toBeNull();
    expect(pagePoint(320, 550, box, frame, viewport)).toBeNull();
  });

  it("allows for the bars a wider box leaves at the sides", () => {
    // 1000x400 box: the picture is 640x400, so 180px bars at each side.
    const box = { left: 0, top: 0, width: 1000, height: 400 };
    expect(pagePoint(180, 0, box, frame, viewport)).toEqual({ x: 0, y: 0 });
    expect(pagePoint(820, 400, box, frame, viewport)).toEqual({ x: 1280, y: 800 });
    expect(pagePoint(100, 200, box, frame, viewport)).toBeNull();
  });

  it("scales a frame smaller than the viewport up to page pixels", () => {
    // A screencast frame at half size still means the full 1280x800 page.
    const box = { left: 0, top: 0, width: 640, height: 400 };
    expect(pagePoint(320, 200, box, { w: 640, h: 400 }, viewport)).toEqual({ x: 640, y: 400 });
  });

  it("follows a zoomed picture, whose box is larger than the screen", () => {
    // Pinch-zoomed 2x and scrolled: the box starts off screen to the left.
    const box = { left: -640, top: -400, width: 1280, height: 800 };
    expect(pagePoint(0, 0, box, frame, viewport)).toEqual({ x: 640, y: 400 });
  });

  it("refuses an empty box or frame", () => {
    expect(pagePoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }, frame, viewport)).toBeNull();
    expect(
      pagePoint(0, 0, { left: 0, top: 0, width: 10, height: 10 }, { w: 0, h: 0 }, viewport),
    ).toBeNull();
  });
});

describe("when frames are asked for", () => {
  const on = { wanted: true, intersecting: true, documentVisible: true, parked: false };

  it("streams only while wanted, on screen, in a visible tab and not parked", () => {
    expect(streamWanted(on)).toBe(true);
    expect(streamWanted({ ...on, wanted: false })).toBe(false);
    expect(streamWanted({ ...on, intersecting: false })).toBe(false);
    expect(streamWanted({ ...on, documentVisible: false })).toBe(false);
    expect(streamWanted({ ...on, parked: true })).toBe(false);
  });
});
