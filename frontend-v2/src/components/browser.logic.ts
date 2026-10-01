import { liveRow, type TimelineRow, type ToolRow } from "./timeline.logic";

/**
 * PURE helpers for the session browser in the lobby
 * (docs/plans/2026-10-01-session-browser-design.md, ADR-0035): which stretches
 * of a transcript are Browsing runs, where each run's Browser card sits among
 * the rows, what its header says, where a press on the scaled page lands in the
 * page, and when a card or the panel may ask the host for frames.
 *
 * Runs are read off the derived rows rather than the raw events, because the
 * rows already know which turn is open (its working row) and which work group
 * or fold a call is drawn inside, and those two are what a card needs.
 */

/** Every tool the agent's built-in browser offers carries this prefix. The
 *  launcher keeps the MCP server's name `playwright` for exactly this reason. */
const BROWSER_TOOL_PREFIX = "mcp__playwright__";
const CLOSE_TOOL = `${BROWSER_TOOL_PREFIX}browser_close`;

const isBrowserTool = (tool: string): boolean => tool.startsWith(BROWSER_TOOL_PREFIX);

/**
 * One Browsing run: from the first browser call in a turn until the turn ends
 * or the agent closes the browser.
 */
export interface BrowsingRun {
  /** Stable while the run grows: the first call's row key, prefixed. */
  key: string;
  turnKey: string;
  /** The row the run's first call is drawn in: its work group, or the call
   *  itself in a timeline that does not group. */
  groupKey: string;
  /** The run's browser calls, in order. */
  calls: ToolRow[];
  /** A `browser_close` ended it. */
  closed: boolean;
  /** Still going: its turn is open and the browser was not closed. Only the
   *  last run can be. A current card streams; a finished one is a record. */
  current: boolean;
}

/** Every top-level call in the rows, with the row that draws it. */
function* callsIn(rows: readonly TimelineRow[]): Generator<[ToolRow, string]> {
  for (const row of rows) {
    if (row.kind === "tool") yield [row, row.key];
    else if (row.kind === "work-group") {
      for (const c of row.calls) if (c.kind === "tool") yield [c, row.key];
    } else if (row.kind === "turn-fold") {
      for (const h of row.hidden) {
        if (h.kind === "tool") yield [h, h.key];
        else if (h.kind === "work-group") {
          for (const c of h.calls) if (c.kind === "tool") yield [c, h.key];
        }
      }
    }
  }
}

/**
 * The Browsing runs in a derived row list (deriveRows), oldest first.
 *
 * Pass the rows before `visibleRows` opens any fold: an opened fold lists its
 * hidden rows twice over, and each call must be counted once.
 */
export function browsingRuns(rows: readonly TimelineRow[]): BrowsingRun[] {
  const runs: BrowsingRun[] = [];
  let run: BrowsingRun | null = null;
  for (const [c, groupKey] of callsIn(rows)) {
    if (!isBrowserTool(c.tool)) continue;
    if (!run || run.closed || run.turnKey !== c.turnKey) {
      run = {
        key: `browser:${c.key}`,
        turnKey: c.turnKey,
        groupKey,
        calls: [],
        closed: false,
        current: false,
      };
      runs.push(run);
    }
    run.calls.push(c);
    if (c.tool === CLOSE_TOOL) run.closed = true;
  }
  const open = liveRow(rows as TimelineRow[])?.turnKey;
  const last = runs.at(-1);
  if (last && !last.closed && open !== undefined && last.turnKey === open) last.current = true;
  return runs;
}

/**
 * Which visible row each run's card is drawn after, as row key to run keys.
 *
 * A card follows the work group holding its run's first call. A settled turn
 * folds that group away, and the card is the record of what the browser did,
 * so it then follows the fold instead; opening the fold moves it back to the
 * group. A run with neither in the list (outside the mounted window) has no
 * card. Each run is drawn once.
 */
export function cardAnchors(
  runs: readonly BrowsingRun[],
  visible: readonly TimelineRow[],
): Map<string, string[]> {
  const shown = new Set<string>();
  const folds = new Map<string, string>();
  for (const r of visible) {
    shown.add(r.key);
    if (r.kind === "turn-fold") folds.set(r.turnKey, r.key);
  }
  const out = new Map<string, string[]>();
  for (const run of runs) {
    const at = shown.has(run.groupKey) ? run.groupKey : folds.get(run.turnKey);
    if (at === undefined) continue;
    const list = out.get(at);
    if (list) list.push(run.key);
    else out.set(at, [run.key]);
  }
  return out;
}

// ---- what a call is doing -------------------------------------------------
//
// The same words the host sends as `activity` (tl-browser/host/lib/activity.mjs),
// so the card says the same thing whether it read the line off the live
// stream or off the transcript after a reload. Never what was typed.

const MAX_SUMMARY = 80;

const clip = (s: string): string =>
  s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;

function inputOf(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
};

/** The host name of an http(s) address, or "a page" for anything else. */
function where(raw: string): string {
  if (!raw) return "a page";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "a page";
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

const TAB_ACTIONS: Record<string, string> = {
  new: "Opening a tab",
  close: "Closing a tab",
  select: "Switching tabs",
};

/** One line saying what a browser call does: "Loading wikipedia.org". */
export function callSummary(tool: string, input: string): string {
  const name = tool.startsWith(BROWSER_TOOL_PREFIX) ? tool.slice(BROWSER_TOOL_PREFIX.length) : tool;
  const args = inputOf(input);
  const el = str(args, "element");
  switch (name) {
    case "browser_navigate":
      return clip(`Loading ${where(str(args, "url"))}`);
    case "browser_navigate_back":
      return "Going back";
    case "browser_click":
      return clip(el ? `Clicking ${el}` : "Clicking on the page");
    case "browser_type":
      return clip(el ? `Typing into ${el}` : "Typing");
    case "browser_hover":
      return clip(el ? `Hovering over ${el}` : "Hovering");
    case "browser_press_key":
      return clip(`Pressing ${str(args, "key") || "a key"}`);
    case "browser_snapshot":
      return "Reading the page";
    case "browser_take_screenshot":
      return "Taking a screenshot";
    case "browser_fill_form":
      return "Filling in a form";
    case "browser_select_option":
      return clip(el ? `Choosing an option in ${el}` : "Choosing an option");
    case "browser_wait_for": {
      const t = str(args, "text") || str(args, "textGone");
      return clip(t ? `Waiting for "${t}"` : "Waiting");
    }
    case "browser_tabs":
      return TAB_ACTIONS[str(args, "action")] ?? "Listing tabs";
    case "browser_evaluate":
    case "browser_run_code_unsafe":
      return "Running a script on the page";
    case "browser_file_upload":
      return "Uploading a file";
    case "browser_handle_dialog":
      return "Answering a dialog";
    case "browser_drag": {
      const from = str(args, "startElement");
      const to = str(args, "endElement");
      return clip(from && to ? `Dragging ${from} to ${to}` : "Dragging");
    }
    case "browser_console_messages":
      return "Reading the console";
    case "browser_network_requests":
      return "Reading network requests";
    case "browser_network_request":
      return "Reading a network request";
    case "browser_drop":
      return clip(el ? `Dropping onto ${el}` : "Dropping onto the page");
    case "browser_resize":
      return "Resizing the window";
    case "browser_close":
      return "Closing the browser";
    default:
      return clip(`Using ${name.replace(/^browser_/, "").replaceAll("_", " ")}`);
  }
}

/** What a run's card header says: its latest call. */
export function runSummary(run: BrowsingRun): string {
  const last = run.calls.at(-1);
  if (!last) return "";
  if (last.tool === CLOSE_TOOL && last.done) return "Closed the browser";
  return callSummary(last.tool, last.input);
}

// ---- the scaled page ------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  w: number;
  h: number;
}

/**
 * Where a press at (clientX, clientY) lands in the page, in the page's CSS
 * pixels, or null when it is outside the picture.
 *
 * `box` is the picture element's own client rect. The frame is drawn inside it
 * at `object-fit: contain`, so a box of another shape leaves bars on two sides,
 * and a press on a bar is no press at all. The frame's own pixel size may
 * differ from the page's (the screencast scales), so the point goes through
 * the frame as a fraction and comes out in `viewport` units. A pinch zoom
 * grows the box itself, which the client rect already reflects.
 */
export function pagePoint(
  clientX: number,
  clientY: number,
  box: Box,
  frame: Size,
  viewport: Size,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || frame.w <= 0 || frame.h <= 0) return null;
  const scale = Math.min(box.width / frame.w, box.height / frame.h);
  const drawnW = frame.w * scale;
  const drawnH = frame.h * scale;
  const fx = (clientX - box.left - (box.width - drawnW) / 2) / drawnW;
  const fy = (clientY - box.top - (box.height - drawnH) / 2) / drawnH;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { x: round(fx * viewport.w), y: round(fy * viewport.h) };
}

// ---- when to stream -------------------------------------------------------

/**
 * Whether a card or the panel may ask for frames now. Frames cost the host a
 * screencast and the page a decode each, so they flow only while somebody can
 * see them: the surface wants them (a current card, an open panel), it is
 * intersecting the viewport, the tab is visible, and the session's stream is
 * not parked (docs/plans/2026-09-11-client-cpu-parking-design.md).
 */
export function streamWanted(o: {
  wanted: boolean;
  intersecting: boolean;
  documentVisible: boolean;
  parked: boolean;
}): boolean {
  return o.wanted && o.intersecting && o.documentVisible && !o.parked;
}
