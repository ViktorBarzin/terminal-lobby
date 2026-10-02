import {
  declinedCall,
  liveRow,
  stoppedCall,
  type TimelineRow,
  type ToolRow,
} from "./timeline.logic";

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
function runSummary(run: BrowsingRun): string {
  const last = run.calls.at(-1);
  if (!last) return "";
  if (last.tool === CLOSE_TOOL && last.done) return "Closed the browser";
  return callSummary(last.tool, last.input);
}

/** What the host answers a call with while a person holds control
 *  (tl-browser/host/lib/gate.mjs REFUSAL_TEXT); matched on its first part. */
const REFUSAL_MARK = "The user has taken control of the browser";

/**
 * Where a run stands, read off its last call's result:
 * - "refused": the host turned the call away because a person holds control;
 * - "failed": the call came back with an error;
 * - "stopped": a Stop interrupted it, or its turn ended before it came back;
 * - "live": the run goes on, and the card may show the host's own activity;
 * - "ok": the run ended well.
 * The card's dot and header follow it, so a refused or stopped call never
 * reads as the activity it was started for.
 */
export type RunStatus = "live" | "ok" | "refused" | "failed" | "stopped";

export function runStatus(run: BrowsingRun): { status: RunStatus; summary: string } {
  const last = run.calls.at(-1);
  if (last?.done && last.isError) {
    if (stoppedCall(last)) return { status: "stopped", summary: "Stopped" };
    if (declinedCall(last)) return { status: "stopped", summary: "Declined" };
    if ((last.result ?? "").includes(REFUSAL_MARK))
      return { status: "refused", summary: "Refused: the user has control" };
    return { status: "failed", summary: "Failed" };
  }
  if (last && !last.done && !run.current) return { status: "stopped", summary: "Stopped" };
  return { status: run.current ? "live" : "ok", summary: runSummary(run) };
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

// ---- popups over the scaled page ------------------------------------------

/** A box in the page's CSS pixels, as the host reports a select's. */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a box in the page is drawn on screen: the reverse of `pagePoint`, over
 * the same `object-fit: contain` picture. Null when there is no picture.
 */
export function clientBox(rect: PageRect, box: Box, frame: Size, viewport: Size): Box | null {
  if (box.width <= 0 || box.height <= 0 || frame.w <= 0 || frame.h <= 0) return null;
  if (viewport.w <= 0 || viewport.h <= 0) return null;
  const scale = Math.min(box.width / frame.w, box.height / frame.h);
  const drawnW = frame.w * scale;
  const drawnH = frame.h * scale;
  const left0 = box.left + (box.width - drawnW) / 2;
  const top0 = box.top + (box.height - drawnH) / 2;
  const sx = drawnW / viewport.w;
  const sy = drawnH / viewport.h;
  return {
    left: left0 + rect.x * sx,
    top: top0 + rect.y * sy,
    width: rect.w * sx,
    height: rect.h * sy,
  };
}

/**
 * Where a point in the page is drawn on screen, by `clientBox` with no size:
 * the Browser cursor's spot over the `object-fit: contain` picture. Pass the
 * picture's box with `left` and `top` at 0 for a spot in its own pixels.
 */
export function clientPoint(
  point: { x: number; y: number },
  box: Box,
  frame: Size,
  viewport: Size,
): { left: number; top: number } | null {
  const b = clientBox({ x: point.x, y: point.y, w: 0, h: 0 }, box, frame, viewport);
  return b && { left: b.left, top: b.top };
}

// ---- the cursor -------------------------------------------------------------

/**
 * Whether the Browser cursor glides to a new spot rather than appearing
 * there: only from one host report to the next on the same tab. It appears in
 * place the first time it is drawn and when the panel shows another tab, and
 * moves with the picture, not after it, when only the layout changed (the
 * same report, `seq`, drawn somewhere else).
 */
export function cursorGlides(
  prev: { tab: string; seq: number } | null,
  next: { tab: string; seq: number },
): boolean {
  return prev !== null && prev.tab === next.tab && prev.seq !== next.seq;
}

/** A click this soon after a press, this close to it, is that press's. */
const CLICK_OF_PRESS_MS = 1_000;
const CLICK_OF_PRESS_PX = 4;

/**
 * Whether a cursor report rings where it lands: every press, and a click
 * that is not the end of the press that just rang there. The host reports a
 * click as down, up and click, and one click gets one ring.
 */
export function cursorRipples(
  lastPress: { x: number; y: number; at: number } | null,
  report: { kind: "move" | "down" | "up" | "click"; x: number; y: number },
  now: number,
): boolean {
  if (report.kind === "down") return true;
  if (report.kind !== "click") return false;
  return (
    lastPress === null ||
    now - lastPress.at > CLICK_OF_PRESS_MS ||
    Math.hypot(report.x - lastPress.x, report.y - lastPress.y) > CLICK_OF_PRESS_PX
  );
}

/** A host cursor report, as far as drawing it goes. */
export interface CursorReport {
  tab: string;
  x: number;
  y: number;
  seq: number;
}

/**
 * This viewer's own pointer while it holds control with a fine pointer: where
 * it is over the picture in page pixels, "off" while it is over the stage but
 * beside the picture, or null while the host drives the drawn cursor.
 */
export type OwnPointer = { x: number; y: number } | "off" | null;

/** Where a phone's tap put the cursor, until the host reports past `after`. */
export interface TapMark {
  tab: string;
  x: number;
  y: number;
  /** The `seq` of the host's latest report when the tap landed. */
  after: number;
}

/**
 * Where the panel draws the one Browser cursor, in page pixels, or null for
 * no cursor. The host's report on the shown tab, except:
 *
 * - While this viewer holds control and its own pointer is over the stage,
 *   its pointer, at once and with the host's echo of it ignored: the echo
 *   trails a round trip behind. Beside the picture no input is sent and the
 *   real pointer shows, so nothing is drawn.
 * - After a tap, the tap's spot, until the host reports anything newer. A tap
 *   inside a cross-origin iframe is never echoed, and one that is arrives a
 *   round trip late.
 *
 * `own` marks a position this viewer put there, which never glides (`seq`
 * -1, so the move back to the host's report does).
 */
export function drawnCursor(
  host: CursorReport | null,
  own: OwnPointer,
  mark: TapMark | null,
  tab: string | null,
): (CursorReport & { own: boolean }) | null {
  if (tab === null || own === "off") return null;
  if (own) return { tab, x: own.x, y: own.y, seq: -1, own: true };
  if (mark && mark.tab === tab && (host === null || host.seq <= mark.after))
    return { tab, x: mark.x, y: mark.y, seq: -1, own: true };
  return host && host.tab === tab ? { ...host, own: false } : null;
}

/** How long, and how near, a host report can be the echo of this viewer's press. */
const OWN_ECHO_MS = 2_000;
const OWN_ECHO_PX = 4;

/**
 * Whether a host report is the echo of a press this viewer already rang for
 * (a desktop press, or a phone's tap): its down, up or click near the same
 * spot soon after. The panel rings for its own press at once, so the echo
 * does not ring again. While a person holds control the agent's input is
 * refused, so a press there in that time is theirs.
 */
export function echoesOwnPress(
  own: { x: number; y: number; at: number } | null,
  report: { kind: "move" | "down" | "up" | "click"; x: number; y: number },
  now: number,
): boolean {
  if (own === null || report.kind === "move") return false;
  return (
    now - own.at <= OWN_ECHO_MS && Math.hypot(report.x - own.x, report.y - own.y) <= OWN_ECHO_PX
  );
}

export interface ListPlacement {
  left: number;
  /** The list's top edge, or its bottom edge when it opens `above`. */
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

const LIST_GAP = 2;
/** Below this much room under the select, a list with more room above opens upwards. */
const LIST_MIN_ROOM = 160;
const LIST_MIN_WIDTH = 160;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * Where a select's list goes: under the select and at least as wide as it,
 * the way Chrome hangs one, opening upwards when the select sits too low, and
 * kept inside `bounds` (the stage, in the same client pixels as `anchor`).
 */
export function listPlacement(anchor: Box, bounds: Box): ListPlacement {
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const width = Math.min(Math.max(anchor.width, LIST_MIN_WIDTH), bounds.width);
  const left = clamp(anchor.left, bounds.left, right - width);
  const below = clamp(anchor.top + anchor.height + LIST_GAP, bounds.top, bottom);
  const above = clamp(anchor.top - LIST_GAP, bounds.top, bottom);
  const roomBelow = bottom - below - LIST_GAP;
  const roomAbove = above - bounds.top - LIST_GAP;
  const up = roomBelow < LIST_MIN_ROOM && roomAbove > roomBelow;
  return {
    left,
    top: up ? above : below,
    width,
    maxHeight: Math.max(0, up ? roomAbove : roomBelow),
    above: up,
  };
}

// ---- when to stream -------------------------------------------------------

/**
 * Whether a Browser card may ask for frames now. Frames cost the host a
 * screencast and the page a decode each, so they flow only while somebody can
 * see them: the card wants them (it is current), it is intersecting the
 * viewport, the tab is visible, and the session's stream is not parked
 * (docs/plans/2026-09-11-client-cpu-parking-design.md).
 */
export function streamWanted(o: {
  wanted: boolean;
  intersecting: boolean;
  documentVisible: boolean;
  parked: boolean;
}): boolean {
  return o.wanted && o.intersecting && o.documentVisible && !o.parked;
}

/**
 * Whether the open Browser panel may ask for frames now: while the lobby's
 * page is visible and its session is on screen, and for the person in control
 * whenever the page is visible at all.
 *
 * Not the card's rule. An open panel is what is on screen, so the card's
 * IntersectionObserver and the text stream's parking are left out: on the
 * lobby added to an iPhone's home screen, that gate turned the panel's stream
 * off about 3s after it opened, and the taps that followed went nowhere
 * (telemetry, 2026-10-02). Holding control keeps it on through anything but a
 * hidden page, so the stream under a person's hands never lingers out.
 */
export function panelStreamWanted(o: {
  documentVisible: boolean;
  onScreen: boolean;
  inControl: boolean;
}): boolean {
  return o.documentVisible && (o.onScreen || o.inControl);
}

// ---- where the panel goes ---------------------------------------------------

/** Below this much pane, a panel beside the view leaves the view too little:
 *  the panel's own floor is 360px, and the chat was left about 30px. */
const PANEL_SIDE_MIN_PANE = 720;

/**
 * Where the Browser panel goes in a session's pane: beside the view ("side"),
 * over the whole pane ("full"), or over the whole screen on a phone
 * ("phone"). The pane's width decides, not the pointer, so a narrow desktop
 * window and a narrow tile get the full-pane layout too. A pane not measured
 * yet, or laid out at zero (not on screen), keeps the panel beside the view.
 */
export function panelLayout(o: {
  phone: boolean;
  paneWidth: number | null;
}): "phone" | "full" | "side" {
  if (o.phone) return "phone";
  if (o.paneWidth === null || o.paneWidth <= 0) return "side";
  return o.paneWidth < PANEL_SIDE_MIN_PANE ? "full" : "side";
}
