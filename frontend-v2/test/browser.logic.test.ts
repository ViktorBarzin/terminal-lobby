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
  clientBox,
  listPlacement,
  pagePoint,
  panelLayout,
  panelStreamWanted,
  runStatus,
  streamWanted,
} from "../src/components/browser.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const PW = "mcp__playwright__";
let ids = 100;
/** A call and its result, in one go. */
const call = (
  tool: string,
  input: object,
  opts: { done?: boolean; at?: number; result?: string; isError?: boolean } = {},
): Event[] => {
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
  return [
    use,
    ev({
      id: ++ids,
      kind: "tool_result",
      toolId,
      body: opts.result ?? "ok",
      at: opts.at,
      ...(opts.isError ? { isError: true } : {}),
    }),
  ];
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

/**
 * The panel's own rule (Viktor's iPhone, 2026-10-02). On the lobby added to
 * the home screen, the panel's stream went quiet about 3s after it opened and
 * closed 15s later, and every Take control after that went nowhere. Its gate
 * had the card's IntersectionObserver and the text stream's parking in it, and
 * neither is a reason to stop an open panel: it is the thing on screen.
 */
describe("when the open panel asks for frames", () => {
  const on = { documentVisible: true, onScreen: true, inControl: false };

  it("streams while the page is visible and the session is on screen", () => {
    expect(panelStreamWanted(on)).toBe(true);
    expect(panelStreamWanted({ ...on, onScreen: false })).toBe(false);
    expect(panelStreamWanted({ ...on, documentVisible: false })).toBe(false);
  });

  it("keeps streaming for the person in control until the page itself is hidden", () => {
    expect(panelStreamWanted({ ...on, inControl: true, onScreen: false })).toBe(true);
    expect(panelStreamWanted({ documentVisible: false, onScreen: true, inControl: true })).toBe(
      false,
    );
  });
});

describe("where a popup sits over the scaled page", () => {
  const frame = { w: 1280, h: 800 };
  const viewport = { w: 1280, h: 800 };

  it("maps a box in the page onto the drawn picture", () => {
    // 640x600 box at (10, 20): the picture is 640x400 with 100px bars, half scale.
    const box = { left: 10, top: 20, width: 640, height: 600 };
    expect(clientBox({ x: 10, y: 10, w: 200, h: 30 }, box, frame, viewport)).toEqual({
      left: 15,
      top: 125,
      width: 100,
      height: 15,
    });
  });

  it("undoes pagePoint: a box's corners press back onto the page where they came from", () => {
    const boxes = [
      { left: 0, top: 0, width: 1280, height: 800 },
      { left: 30, top: 40, width: 640, height: 600 },
      { left: 0, top: 0, width: 1000, height: 400 },
    ];
    for (const box of boxes)
      for (const rect of [
        { x: 0, y: 0, w: 1280, h: 800 },
        { x: 100, y: 250, w: 300, h: 40 },
      ]) {
        const c = clientBox(rect, box, frame, viewport)!;
        expect(pagePoint(c.left, c.top, box, frame, viewport)).toEqual({ x: rect.x, y: rect.y });
        expect(pagePoint(c.left + c.width, c.top + c.height, box, frame, viewport)).toEqual({
          x: rect.x + rect.w,
          y: rect.y + rect.h,
        });
      }
  });

  it("has no box without a picture to draw on", () => {
    expect(
      clientBox(
        { x: 0, y: 0, w: 1, h: 1 },
        { left: 0, top: 0, width: 0, height: 0 },
        frame,
        viewport,
      ),
    ).toBeNull();
  });

  const stage = { left: 0, top: 0, width: 640, height: 600 };

  it("hangs a list below its select, at least as wide as it", () => {
    expect(listPlacement({ left: 15, top: 125, width: 100, height: 15 }, stage)).toEqual({
      left: 15,
      top: 142,
      width: 160,
      maxHeight: 456,
      above: false,
    });
    expect(listPlacement({ left: 15, top: 125, width: 300, height: 15 }, stage).width).toBe(300);
  });

  it("opens the list upwards when a select sits low on the stage", () => {
    expect(listPlacement({ left: 15, top: 500, width: 200, height: 30 }, stage)).toEqual({
      left: 15,
      top: 498,
      width: 200,
      maxHeight: 496,
      above: true,
    });
  });

  it("keeps the list on the stage", () => {
    const p = listPlacement({ left: 600, top: 100, width: 100, height: 20 }, stage);
    expect(p.left).toBe(480);
    expect(listPlacement({ left: 10, top: 10, width: 900, height: 20 }, stage).width).toBe(640);
    const off = listPlacement({ left: -50, top: -40, width: 100, height: 20 }, stage);
    expect(off.left).toBe(0);
    expect(off.top).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Where the Browser panel goes. Beside the view it takes about half the pane
 * and at least 360px, which in a pane of 700px left the chat about 30px wide
 * when a desktop window was narrow (review 2026-10-01). Below 720px of pane it
 * covers the pane instead, whatever the pointer; a phone keeps its own
 * full-screen layout.
 */
describe("panelLayout", () => {
  it("puts the panel beside the view in a wide pane", () => {
    expect(panelLayout({ phone: false, paneWidth: 1440 })).toBe("side");
    expect(panelLayout({ phone: false, paneWidth: 720 })).toBe("side");
  });

  it("covers a narrow pane, whatever the pointer", () => {
    expect(panelLayout({ phone: false, paneWidth: 719 })).toBe("full");
    expect(panelLayout({ phone: false, paneWidth: 390 })).toBe("full");
  });

  it("keeps a phone on its full-screen layout", () => {
    expect(panelLayout({ phone: true, paneWidth: 390 })).toBe("phone");
    expect(panelLayout({ phone: true, paneWidth: 1024 })).toBe("phone");
  });

  it("stays beside the view until the pane has been measured", () => {
    expect(panelLayout({ phone: false, paneWidth: null })).toBe("side");
    // A pane laid out at zero is not on screen; nothing to decide yet.
    expect(panelLayout({ phone: false, paneWidth: 0 })).toBe("side");
  });
});

/**
 * What a Browser card's header says and which colour its dot is, read off the
 * run's last call (review 2026-10-01). The card used to show the last call's
 * words whatever came back, so a call the host refused while the user had
 * control still read "Reading the page" with a live dot, and a wait the user
 * stopped read "Waiting".
 */
describe("runStatus", () => {
  /** What the host answers a call with while a person holds control
   *  (tl-browser/host/lib/gate.mjs REFUSAL_TEXT). */
  const REFUSED =
    "The user has taken control of the browser. Don't retry; end your turn and wait for them to tell you they are done.";
  /** What the CLI writes for a call a Stop interrupted (CLI 2.1.283). */
  const STOPPED =
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const interrupt = (): Event =>
    ev({ id: ++ids, kind: "state", body: "[Request interrupted by user for tool use]" });
  const runOf = (events: Event[]) => browsingRuns(deriveRows(events)).at(-1)!;

  it("says a call refused while the user holds control was refused, live turn or not", () => {
    const open = [
      user("look it up"),
      ...call(`${PW}browser_navigate`, { url: "https://example.com" }),
      ...call(`${PW}browser_snapshot`, {}, { result: REFUSED, isError: true }),
    ];
    expect(runStatus(runOf(open))).toEqual({
      status: "refused",
      summary: "Refused: the user has control",
    });
    expect(runStatus(runOf([...open, text("I'll wait."), end()]))).toEqual({
      status: "refused",
      summary: "Refused: the user has control",
    });
  });

  it("says a call that failed failed", () => {
    const run = runOf([
      user("look it up"),
      ...call(
        `${PW}browser_navigate`,
        { url: "https://nope.invalid" },
        {
          result: "net::ERR_NAME_NOT_RESOLVED",
          isError: true,
        },
      ),
      text("It did not load."),
      end(),
    ]);
    expect(runStatus(run)).toEqual({ status: "failed", summary: "Failed" });
  });

  it("says a call a Stop interrupted was stopped", () => {
    const run = runOf([
      user("wait for it"),
      ...call(`${PW}browser_wait_for`, { time: 30 }, { result: STOPPED, isError: true }),
      interrupt(),
      end(),
    ]);
    expect(runStatus(run)).toEqual({ status: "stopped", summary: "Stopped" });
  });

  it("says a call that never came back before the turn ended was stopped", () => {
    const run = runOf([
      user("wait for it"),
      ...call(`${PW}browser_wait_for`, { text: "Done" }, { done: false }),
      end(),
    ]);
    expect(runStatus(run)).toEqual({ status: "stopped", summary: "Stopped" });
  });

  it("says what the browser is doing while the run goes on", () => {
    const run = runOf([
      user("look it up"),
      ...call(`${PW}browser_navigate`, { url: "https://example.com" }),
      ...call(`${PW}browser_click`, { element: "More info" }, { done: false }),
    ]);
    expect(runStatus(run)).toEqual({ status: "live", summary: "Clicking More info" });
  });

  it("says what the browser last did once the run ended well", () => {
    const run = runOf([
      user("look it up"),
      ...call(`${PW}browser_navigate`, { url: "https://example.com" }),
      ...call(`${PW}browser_close`, {}),
    ]);
    expect(runStatus(run)).toEqual({ status: "ok", summary: "Closed the browser" });
    const settled = runOf([
      user("look it up"),
      ...call(`${PW}browser_snapshot`, {}),
      text("Found it."),
      end(),
    ]);
    expect(runStatus(settled)).toEqual({ status: "ok", summary: "Reading the page" });
  });
});
