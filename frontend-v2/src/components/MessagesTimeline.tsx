import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type Component,
  type JSX,
  type Setter,
} from "solid-js";
import type { Event } from "../types/events";
import { diag } from "../telemetry/diag";
import {
  deriveRows,
  liveGroupState,
  liveRow,
  MAX_QUEUED_SHOWN,
  sameRow,
  scrollTopAfterPrepend,
  statusText,
  visibleRows,
  type ContinuationRow,
  type ErrorRow,
  type LeafRow,
  type LiveGroupState,
  type MessageRow,
  type MetaRow,
  type PermissionRow,
  type PlanRow,
  type PlanTransient,
  type QuestionRow,
  type StatusRow,
  type WorkingRow,
  type ThinkingRow,
  type TimelineRow,
  type TodoRow,
  type ToolRow,
  type TurnFoldRow,
  type UserRow,
  type WorkGroupRow,
} from "./timeline.logic";
import { Markdown } from "./Markdown";
import { ownWhile } from "../lib/ownwhile";
import { MessageSegments } from "./Attachment";
import { collapseSegments, segmentPrompt } from "../lib/attachments";
import {
  ContinuationRowView,
  LiveRowView,
  MetaRowView,
  PlanRowView,
  QuestionRowView,
  ThinkingRowView,
  TodoRowView,
  SkillRowView,
  ToolRowView,
  TurnFoldRowView,
  WorkGroupRowView,
  WorkingRowView,
} from "./rows";

const USER_COLLAPSE_CHARS = 600;

/** A plan row's call id, which the dock and this client's answer name it by. */
const planToolId = (row: TimelineRow): string | undefined =>
  row.kind === "plan" ? row.toolId : undefined;

const UserRowView: Component<{
  row: UserRow;
  /** effective OS user — decides whether a store path is ours to fetch. */
  me?: string;
  /** the session, whose transcript holds the prompt's pasted pictures. */
  session?: string;
  onOpenPreview?: (path: string) => void;
}> = (props) => {
  // The collapse works on segments rather than on the body, so it can never
  // end halfway through a path or a `[Image #N]` placeholder: slicing the body
  // at character 600 turned a store path across that point into a broken
  // fragment of text where its picture belonged.
  const segments = createMemo(() => segmentPrompt(props.row.body, props.row.images));
  const collapsed = createMemo(() => collapseSegments(segments(), USER_COLLAPSE_CHARS));
  const long = () => collapsed().cut;
  const [open, setOpen] = createSignal(false);
  const shown = () => (long() && !open() ? collapsed().segments : segments());
  return (
    <div class="tl-row tl-row-user" data-eid={props.row.id}>
      <div class="tl-bubble-user">
        {/* Still a <pre>: the message's own whitespace is significant, and an
            <img>/<button> is phrasing content, so substituting a path in place
            costs the surrounding text nothing. */}
        <pre class="tl-user-text">
          <MessageSegments
            segments={shown()}
            me={props.me ?? ""}
            session={props.session}
            record={props.row.record}
            onOpen={props.onOpenPreview}
          />
          {long() && !open() ? "…" : ""}
        </pre>
        <Show when={long()}>
          <button
            type="button"
            class="tl-linkbtn"
            data-scroll-anchor-ignore
            onClick={() => setOpen((v) => !v)}
          >
            {open() ? "Show less" : "Show more"}
          </button>
        </Show>
      </div>
    </div>
  );
};

/**
 * The prompts waiting in Claude's queue, drawn at the end of the conversation
 * as dashed outlines of the bubbles they will become.
 *
 * They were chips above the composer's field until 2026-09-24 (the Quiet line
 * composer), clipped to one line each and sitting in the one strip of the
 * screen that was already contested. A queued prompt is the reader's own
 * message that has not left yet, so it goes where it will land. Three at most,
 * then a count, the same cap the chips had.
 *
 * The T3 pass (2026-09-27) dropped their second line, "Sends when Claude
 * finishes this turn": the Queued tag says it, as the prototype's ghost does.
 * `data-queued` is what the stylesheet draws the outline from.
 *
 * Not keyed rows. They are not the transcript's: they come from the queue's own
 * operations (timeline.logic `queuedPrompts`), leave the moment Claude takes
 * them, and the prompt then arrives as an ordinary user row.
 */
const GhostRowsView: Component<{
  queued: string[];
  me?: string;
  onOpenPreview?: (path: string) => void;
}> = (props) => (
  <>
    <For each={props.queued.slice(0, MAX_QUEUED_SHOWN)}>
      {(text) => (
        <div class="tl-row tl-row-user tl-row-ghost" data-queued="">
          <div class="tl-bubble-user tl-bubble-ghost" title={text}>
            <div class="tl-ghost-body">
              <span class="tl-ghost-tag">Queued</span>
              <pre class="tl-user-text tl-ghost-text">
                <MessageSegments
                  segments={segmentPrompt(text)}
                  me={props.me ?? ""}
                  onOpen={props.onOpenPreview}
                />
              </pre>
            </div>
          </div>
        </div>
      )}
    </For>
    <Show when={props.queued.length > MAX_QUEUED_SHOWN}>
      <div class="tl-row tl-ghost-more">+{props.queued.length - MAX_QUEUED_SHOWN} more waiting</div>
    </Show>
  </>
);

const MessageRowView: Component<{ row: MessageRow; me?: string }> = (props) => (
  <div class="tl-row tl-row-message" data-eid={props.row.id}>
    <Show when={props.row.body.trim()} fallback={<span class="tl-empty">(empty response)</span>}>
      {/* `me` makes this a conversation: a picture Claude names by its path is
          drawn under the text naming it, and fenced code stays code — see
          Markdown.tsx (2026-09-24, revising design 2026-08-17 decision 8). */}
      <Markdown text={props.row.body} attachAs={props.me} />
    </Show>
  </div>
);

/** What a permission row says happened: the reader's answer, or that Claude asked. */
const PERMISSION_NOTE: Record<string, string> = {
  allow: "Allowed",
  deny: "Denied",
};

/**
 * A permission prompt, once it is in the conversation, as one note: "Allowed:
 * Bash". It was a bordered card with a lock and a coloured edge until the T3
 * pass (2026-09-27); the card Claude waits on is where a prompt is answered,
 * and what is left behind is a line saying how it went.
 */
const PermissionRowView: Component<{ row: PermissionRow }> = (props) => (
  <div class="tl-row tl-row-permission" data-decision={props.row.decision || "pending"}>
    <Show
      when={props.row.said}
      fallback={
        <>
          {PERMISSION_NOTE[props.row.decision ?? ""] ?? "Asked"}:{" "}
          <b>{props.row.tool || "permission"}</b>
        </>
      }
    >
      {/* A No with the reader's own words: the prototype's "Declined: <words>". */}
      {(said) => (
        <>
          Declined: <b>{said()}</b>
        </>
      )}
    </Show>
  </div>
);

const ErrorRowView: Component<{ row: ErrorRow }> = (props) => (
  <div class="tl-row tl-row-error">
    <pre class="tl-code tl-code-error">{props.row.body}</pre>
  </div>
);

const StatusRowView: Component<{ row: StatusRow }> = (props) => (
  <div class="tl-row tl-row-status" data-subtype={props.row.subtype}>
    <span class="tl-status-text">{statusText(props.row)}</span>
  </div>
);

/** How far off the bottom still counts as "reading the live end". */
const PIN_SLACK_PX = 40;
/** How long after a wheel turn, scroll key or release its scroll still counts as
 *  the reader's. Covers the smooth-scroll animation's first frames; once the
 *  first event has unpinned the view, later ones cannot pin it by mistake. */
const GESTURE_MS = 500;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const EDITABLE = "input, textarea, select";

/** How long a jumped-to row stays highlighted — long enough to find with the
 *  eye after the scroll, short enough not to become part of the layout. */
const FOUND_FLASH_MS = 1600;

/**
 * How many rows mount immediately, and how many are added per frame after that.
 *
 * A transcript's newest rows are the ones being read, so they mount first and
 * the rest fill in behind them a chunk at a time. Mounting all of them in one
 * task is what made switching views feel stuck: measured on a cold open of a
 * 1,383-event session, 485ms of main-thread blocking across three long tasks,
 * the worst leaving the event loop unresponsive for 336ms — long enough that a
 * click on the Terminal segment did nothing. Chunking keeps every frame short,
 * so the switch stays live while the timeline is still filling.
 */
const FIRST_MOUNT_ROWS = 12;
const MOUNT_CHUNK_ROWS = 8;

/**
 * Why there is no row virtualization here.
 *
 * There was, briefly, and it was wrong in a way worth recording. Rows vary
 * enormously in height — a one-line tool row beside a 200-line diff — so the
 * window was derived from an AVERAGE height (scrollHeight / row count) with
 * spacer divs standing in for the rows outside it. Those spacers are most of
 * scrollHeight, so the average was computed from a number the average itself
 * produced: the loop settled and stopped responding to scrolling. Measured on a
 * real 675-row session, the leading spacer read 21,863px at every scroll
 * position and the same 29 rows stayed mounted, which left the rest of the
 * transcript unreachable — a worse failure than the slowness it was avoiding.
 *
 * What bounds the DOM instead is the data: a fresh open replays the last 20
 * turns (session-events OpenWindowTurns), settled turns fold to a single row,
 * and "Load earlier" adds a bounded window at a time. The 675-row session above
 * renders and scrolls without complaint. If a future session makes this hurt,
 * the fix is a virtualizer that MEASURES rows rather than averages them.
 */

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * One mounted row's current derivation, and the derivation it was last given.
 *
 * `last` is what the change detection compares against, and it is deliberately
 * a plain field rather than a read of `row()`: the pass that writes these
 * signals must not read them, or it lands in its own observer list and runs a
 * second time for every event.
 */
interface RowHolder {
  row: Accessor<TimelineRow>;
  set: Setter<TimelineRow>;
  last: TimelineRow;
}

/**
 * The oldest CONTENT row — the anchor both scroll compensations measure.
 *
 * It has to exclude the timeline's own chrome. `.tl-row-earlier` and
 * `.tl-row-filling` both carry `.tl-row` and both render ABOVE the content, so a
 * selector that accepts them resolves to a row pinned at the top whose offsetTop
 * never changes — which reads as "nothing was inserted above you" every time and
 * silently turns both compensations into no-ops. The reader then gets yanked on
 * every window, and the self-scroll guard never arms, so one load can chain into
 * the next.
 */
const ANCHOR_ROW_SELECTOR = ".tl-row:not(.tl-row-filling):not(.tl-row-earlier)";

/**
 * Structured text-mode renderer. Derives folded rows from the raw event stream
 * (pure logic in timeline.logic) and maps each row kind to a view. Turn-fold
 * rows expand and re-fold in place; tool rows expand to their real payload —
 * a diff for an edit, stdout and stderr for a command.
 *
 * Rows are reconciled by KEY, not by object reference. deriveRows allocates
 * fresh row objects on every call, so a reference-keyed `<For each={rows()}>`
 * rebuilt the entire timeline DOM on every stream event — an expanded tool row
 * snapped shut mid-turn and every mermaid diagram re-mounted. `<For>` therefore
 * maps over the row KEYS (reconciled by value), and each view reads its row
 * back out of a per-key signal that is written only when `sameRow` says the
 * content moved: an unchanged row never notifies, a changed one updates its
 * existing node in place.
 */
export const MessagesTimeline: Component<{
  events: Event[];
  /** The rows for `events`, when the owner has already derived them.
   *
   *  A derivation costs ~10ms on a 1,383-event window, and the same transcript
   *  was being folded here, in TextView and in SessionView on every stream
   *  event. Passing the rows down collapses the three into one. Absent — which
   *  is how the tests render this — the rows are derived here as before, so the
   *  prop is a shortcut and never a second source of truth. */
  rows?: TimelineRow[];
  /** open a file path in the preview overlay (Read/Edit/Write tool rows). */
  onOpenPreview?: (path: string) => void;
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** load the window of turns before the oldest one held. */
  onLoadEarlier?: () => Promise<void>;
  /** true while older turns exist to load. */
  hasEarlier?: boolean;
  /**
   * The reader reached the bottom of the transcript, or left it.
   *
   * The store holds only the last TRANSCRIPT_WINDOW_TURNS turns, and it trims
   * ONLY while the reader is pinned — turns paged in on purpose must not be
   * dropped out from under the person reading them. This view is the only
   * thing that knows where the reader is, so it says so here.
   *
   * Called on each CHANGE rather than on every write: the store walks its
   * event array to answer this, and a scroll writes the same `true` many times
   * a second.
   */
  onPinned?: (pinned: boolean) => void;
  /**
   * What the store currently holds for the pin, so this view can tell when it
   * has been moved from the other end.
   *
   * `loadEarlier` unpins the store directly — it has to, or the window would
   * trim away what it has just fetched before this view reported the scroll —
   * and a view deduping against its OWN last published value goes stale the
   * moment that happens. Being stale in that direction is the expensive one: it
   * believes it already said `true`, so it never says it again, and the store
   * stops trimming for the rest of the session. Absent (the tests, and any
   * caller that does not hold a store) it falls back to the last value
   * published, which is what this did before.
   */
  pinned?: boolean;
  /**
   * A count the parent bumps each time the reader sends something. Each change
   * brings the view to the latest message and pins it there, so the sent
   * message and the reply to it come into sight. Scrolling up lets go of the
   * live end on purpose, and nothing else in this view takes it back: found
   * live on 2026-09-27, a send from 145px up left the view 509px above the
   * bottom with only "Latest" showing.
   */
  follow?: number;
  /**
   * The effective OS user. Attachments in a message are drawn only when this
   * says the file is ours to fetch: the clipboard read-back routes resolve inside
   * the CALLER's own store directory, so a path belonging to someone else would
   * either 404 or answer with our own same-named file (design 2026-08-17
   * decisions 7 and 12). Absent → every path stays text, which is what this view
   * did before attachments rendered at all.
   */
  me?: string;
  /**
   * The session these events belong to. A picture the transcript itself
   * carries (one pasted into the terminal, or a Read of an image) has no file,
   * so its bytes are read back from the session's transcript by index; without
   * the session those pictures stay text.
   */
  session?: string;
  /** the opening window has not arrived yet — this is "not yet", not "none". */
  opening?: boolean;
  /** FALSE while this timeline belongs to a session the lobby is keeping
   *  mounted but not showing — it then owns no window-level handles. */
  owns?: boolean;
  /** Prompts waiting in Claude's queue, oldest first, drawn as ghost bubbles
   *  after the last row. */
  queued?: string[];
  /** The ExitPlanMode call whose plan the docked plan card is showing
   *  (decidePlanDock). Its row shrinks to one line meanwhile. */
  planDocked?: string | null;
  /**
   * A card Claude is waiting on has the composer's place (a question, a
   * permission prompt or the plan). The card is then the one place that says
   * so, as the prototype draws it: the live group reads settled rather than
   * "Waiting for you", and the pending question or docked plan draws no row
   * until it becomes the record.
   */
  cardDocked?: boolean;
  /** This client's plan answer, applied and not in the transcript yet, and the
   *  call it answered (shownPlanOutcome). */
  planAnswer?: { toolId: string; action: PlanTransient } | null;
  /**
   * Mounted but not shown: the session's own timeline while the drill-in
   * shows one of its agents in its place. Kept mounted so going back finds
   * the reader where they were, with every fold as they left it.
   */
  hidden?: boolean;
  /** Show this timeline again. Asked for when a jump lands on one of its rows
   *  while it is hidden, which is how a find-in-session hit opens. */
  onReveal?: () => void;
  /** What the log is called to assistive tech: "Session transcript", or the
   *  agent's when this is the drill-in. */
  label?: string;
  /** What the top row says once there is nothing earlier: "Start of session",
   *  or the start of an agent's transcript in the drill-in. */
  start?: string;
  /** Draw the open turn's working row. Only for the drill-in, an agent's own
   *  transcript, whose calls are rows of their own rather than work groups. A
   *  session's timeline draws the live group at its end instead. */
  workingRow?: boolean;
  /**
   * The open turn's row as the view reads it (TextView `lineLive`, which knows
   * about a docked plan card and pending slash commands), or null when the
   * view says no turn is open. Left out, the timeline reads its own rows.
   */
  live?: WorkingRow | null;
  /** This device's plan answer is clearing the context (TextView planClearing). */
  clearing?: boolean;
  /**
   * Whether the view is at the live end, from its own pin: once at mount and
   * then on every change. The owner draws "Latest" from it, in a band of its
   * own above the composer (the T3 pass, prototype 6-scrolled). The button sat
   * inside this scroller until 2026-09-27, sticky above its foot, and covered
   * whichever row was passing under it.
   *
   * Not `onPinned`: that one dedupes against the store's pin, which
   * `loadEarlier` moves on its own, so it can stay quiet while this view's pin
   * changes. The band has to follow the view.
   */
  onAtEnd?: (atEnd: boolean) => void;
  /** Hands the owner the call that brings the reader to the latest message
   *  and pins the view there: what "Latest" does when pressed. */
  registerToEnd?: (toEnd: () => void) => void;
}> = (props) => {
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());
  /** Split from `rows` so the scroll pin can follow the TRANSCRIPT alone. */
  const derived = createMemo<TimelineRow[]>(() => props.rows ?? deriveRows(props.events));
  const rows = createMemo<TimelineRow[]>(() => visibleRows(derived(), expandedTurns()));

  /**
   * The rows indexed by a render key, unique even if an event id repeats.
   *
   * The open turn's working row is left out: the live group at the end says
   * what the turn is doing (`liveState` below), on the running work group when
   * the turn ends on one. The drill-in asks for the row (`workingRow`), since
   * an agent's transcript has no groups.
   */
  const keyed = createMemo(() => {
    const keys: string[] = [];
    const byKey = new Map<string, TimelineRow>();
    for (const row of rows()) {
      if (row.kind === "working" && !props.workingRow) continue;
      let key = row.key;
      for (let n = 1; byKey.has(key); n++) key = `${row.key}#${n}`;
      keys.push(key);
      byKey.set(key, row);
    }
    return { keys, byKey };
  });
  const allKeys = createMemo<string[]>(() => keyed().keys, [], {
    equals: sameKeys,
  });

  /**
   * Every mounted row's current derivation, PUSHED in by the pass below.
   *
   * This used to be pulled: each row held a memo that read `keyed()` to find
   * itself and used `sameRow` as its equality. `keyed` returns a fresh object
   * literal every run and carries no `equals`, so it notifies on every stream
   * event, and reading it from inside each row's memo put every mounted row in
   * its observer list. One event therefore re-ran one memo per mounted row,
   * 679 of them on the 675-row session the note at the top of this file cites,
   * sixty times a second while a turn runs.
   *
   * The comparison itself cannot be avoided. deriveRows allocates fresh row
   * objects on every call, so nothing short of comparing them can tell a
   * recomputed row from a changed one, and both shapes run it once per row per
   * event. What it does not need is one Solid computation per row to carry it:
   * one pass compares each row once and wakes only the rows that moved.
   * Measured over 120 stream appends into a mounted timeline of 679 rows
   * (jsdom, rows handed down the way SessionView hands them, alternating runs):
   * 13.2 ms per event before, 4.5 ms after.
   *
   * Giving `keyed` an `equals` instead was the other option and it is the
   * wrong one. It only helps when NOTHING changed, which during a live turn is
   * never, and stacking it on top of this pass would compare every row twice
   * per event rather than once.
   */
  const holders = new Map<string, RowHolder>();

  createComputed(() => {
    const byKey = keyed().byKey;
    for (const [key, holder] of holders) {
      const row = byKey.get(key);
      // A row leaving the list can still be read once before its node is
      // disposed; leave the holder on its last value rather than clearing it.
      if (!row || sameRow(holder.last, row)) continue;
      holder.last = row;
      holder.set(() => row);
    }
  });

  /** One row, held stable while its content is unchanged. */
  const rowAt = (key: string): Accessor<TimelineRow> => {
    // Untracked because this runs inside <For>'s mapping: subscribing THAT to
    // `keyed` would put the whole list back under the per-event notification
    // this change exists to remove.
    const initial = untrack(() => keyed().byKey.get(key))!;
    const [row, set] = createSignal<TimelineRow>(initial);
    const holder: RowHolder = { row, set, last: initial };
    holders.set(key, holder);
    // Keys do leave. Re-folding a turn takes its children out of the visible
    // list, and the sliding transcript window drops the oldest turns; without
    // this the pass above would keep walking their holders for the life of the
    // session. Guarded on identity because a key that leaves and comes back
    // registers its new holder before the old one's cleanup runs.
    onCleanup(() => {
      if (holders.get(key) === holder) holders.delete(key);
    });
    return row;
  };

  const toggleTurn = (turnKey: string) => {
    // Unfolding inserts the turn's hidden rows into the list, and the mounted
    // window is a SUFFIX BY COUNT — so without growing the count by the same
    // number, the window slides forward over the new rows and unmounts rows
    // that were on screen ABOVE the one just clicked. Their height goes with
    // them, and the reader's view moves even though scrollTop never changed.
    // Measured on a real session (2026-08-18): unfolding a 467-step turn
    // replaced what was at the top of the screen while scrollTop held still.
    //
    // Collapsing needs no adjustment: the count is clamped to the list length,
    // so a window wider than the list simply covers all of it.
    const fold = derived().find(
      (r): r is TurnFoldRow => r.kind === "turn-fold" && r.turnKey === turnKey,
    );
    const expanding = !expandedTurns().has(turnKey);
    if (expanding && fold) setMounted((m) => m + fold.hidden.length);
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (!next.delete(turnKey)) next.add(turnKey);
      return next;
    });
  };

  // Rows mount from the newest end, a chunk per frame, until all of them are
  // up. This is NOT virtualization: nothing is ever unmounted, so scrolling and
  // searching still reach the whole window (see the note above).
  const [mounted, setMounted] = createSignal(FIRST_MOUNT_ROWS);

  /**
   * Add a chunk of older rows without moving anything the reader can see.
   *
   * Rows mount at the TOP of the list, and a scroll container keeps its
   * scrollTop when content is prepended — so the visible content slid down by
   * the height of every chunk. Solid applies the DOM update synchronously inside
   * the setter, so the height can be measured on both sides of it and the
   * difference handed straight back to scrollTop.
   */
  const growMounted = (total: number): void => {
    const el = scroller;
    // The anchor is the OLDEST row currently mounted: every new row lands above
    // it, so the growth of its offsetTop is precisely the height inserted above
    // the reader. scrollHeight would also count rows BELOW getting taller as
    // their markdown and highlighting resolve, and compensating for that drags
    // the reader down (measured: 5,780px, ending back at the live end).
    const anchor = el?.querySelector<HTMLElement>(ANCHOR_ROW_SELECTOR);
    const before = anchor?.offsetTop ?? 0;
    setMounted((m) => Math.min(total, m + MOUNT_CHUNK_ROWS));
    if (!el) return;
    // At the bottom, being at the bottom IS the position to keep — and it is
    // the one the fill runs against, since a session opens there. Say so
    // directly rather than deriving it from the anchor.
    //
    // Both this and the transcript pin write scrollTop, and during the opening
    // fill both are firing: chunks land every idle callback while the stream's
    // opening window arrives in batches. The anchor arithmetic is computed
    // around ITS OWN setter, so a pin scroll landing in between moved the
    // target it measured, and the two produced a lurch. Measured opening a real
    // session: scrollTop went 307 -> 1850 -> 250 -> 547 and what sat at the
    // middle of the screen changed four times in the first second.
    if (pinned()) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      return;
    }
    if (!anchor) return;
    el.scrollTop = scrollTopAfterPrepend(el.scrollTop, before, anchor.offsetTop);
  };

  createEffect(() => {
    const total = allKeys().length;
    if (mounted() >= total) return;
    // requestIdleCallback where it exists: the fill is background work, and an
    // idle callback does not run while the browser has input to handle, so
    // scrolling and tapping stay ahead of it by construction. The timeout keeps
    // it from starving on a busy page, and rAF is the fallback.
    const ric = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (typeof ric.requestIdleCallback === "function") {
      const handle = ric.requestIdleCallback(() => growMounted(total), {
        timeout: 200,
      });
      onCleanup(() => ric.cancelIdleCallback?.(handle));
      return;
    }
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => growMounted(total))
        : (setTimeout(() => growMounted(total), 0) as unknown as number);
    onCleanup(() => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      clearTimeout(raf);
    });
  });
  /**
   * The suffix of rows that is currently mounted, newest-first growth.
   *
   * A suffix by count, except while the reader has scrolled up: then the
   * window keeps its oldest row and grows at the end instead. Counted alone, a
   * row landing at the end slid the window forward, unmounting the oldest row
   * and putting the "loading earlier rows" line in its place, both ABOVE the
   * reader; the fill that mounted the row again compensated only for its own
   * half. Measured on 2026-09-28: each row that changed at the live end moved a
   * scrolled-up reader down by 42 to 165px while nothing above them changed.
   * A pinned reader is held at the bottom, where what happens above is unseen,
   * and the count keeps the opening fill progressive.
   *
   * `pinned` is read untracked: letting go of the bottom must not remount
   * anything, only decide how the next change to the rows lands.
   */
  const shownKeys = createMemo<string[]>(
    (prev) => {
      const keys = allKeys();
      const n = Math.min(keys.length, mounted());
      let start = keys.length - n;
      if (start > 0 && prev.length > 0 && !untrack(pinned)) {
        // The oldest mounted row that is still in the list: a fold or the
        // sliding transcript window can take the very first one away.
        const index = new Map(keys.map((k, i) => [k, i]));
        for (const k of prev) {
          const at = index.get(k);
          if (at === undefined) continue;
          start = Math.min(start, at);
          break;
        }
      }
      return start <= 0 ? keys : keys.slice(start);
    },
    [],
    { equals: sameKeys },
  );
  // The count follows what the window grew to, so a later change to the rows
  // made while pinned does not shrink it back and restart the fill.
  createEffect(() => {
    const shown = shownKeys().length;
    if (shown > untrack(mounted)) setMounted(shown);
  });
  /** True while rows are still being mounted — the reader sees a hint. */
  const filling = createMemo(() => shownKeys().length < allKeys().length);

  // A leaf row inside a subagent's sub-timeline. Rendered directly rather than
  // through the key machinery: it is owned by its parent tool row, which the
  // memo already holds stable.
  const renderLeaf = (row: LeafRow): JSX.Element => {
    switch (row.kind) {
      case "message":
        return <MessageRowView row={row} me={props.me} />;
      case "thinking":
        return <ThinkingRowView row={row} />;
      case "tool":
        // A skill load is not a tool call the reader wants to open; it is a
        // marker saying which skill is now in force. Its own card, keyed on the
        // item type so nothing here branches on a tool's name.
        if (row.itemType === "skill") return <SkillRowView row={row} />;
        return (
          <ToolRowView
            row={row}
            session={props.session}
            me={props.me}
            onOpenPreview={props.onOpenPreview}
            onLoadFull={props.onLoadFull}
            renderChild={renderLeaf}
          />
        );
      case "todo":
        return <TodoRowView row={row} />;
      case "question":
        return <QuestionRowView row={row} />;
      case "plan":
        return <PlanRowView row={row} />;
      case "meta":
        return <MetaRowView row={row} />;
      case "error":
        return <ErrorRowView row={row} />;
      case "status":
        return <StatusRowView row={row} />;
      case "user":
        return (
          <UserRowView
            row={row}
            me={props.me}
            session={props.session}
            onOpenPreview={props.onOpenPreview}
          />
        );
      case "permission":
        return <PermissionRowView row={row} />;
    }
  };

  // The row kind is encoded in its key, so a node never changes kind under
  // itself and the switch can run once, at creation.
  /**
   * What the live group at the end says (timeline.logic `liveGroupState`): on
   * the running work group when the open turn ends on one, otherwise on a row
   * of its own after the last row. The drill-in draws its working row instead,
   * so it has none: one live indicator per open turn.
   */
  const liveState = createMemo<LiveGroupState>(() => {
    if (props.workingRow) return { kind: "idle" };
    const all = rows();
    let last: TimelineRow | undefined;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind !== "working") {
        last = all[i];
        break;
      }
    }
    const live = props.live === undefined ? liveRow(all) : (props.live ?? undefined);
    return liveGroupState({ live, last, clearing: props.clearing });
  });
  /** What the conversation draws of the live state: nothing while a docked
   *  card is what Claude waits on, since the card says it. */
  const shownLive = createMemo<LiveGroupState>(() => {
    const s = liveState();
    return props.cardDocked && s.kind === "waiting" ? { kind: "idle" } : s;
  });
  /** The running group's key, which the group's view compares its own to. */
  const liveGroupKey = createMemo(() => {
    const s = shownLive();
    return s.kind === "working" || s.kind === "waiting" ? s.groupKey : undefined;
  });
  /** The live state for a row of its own, when no running group carries it. */
  const liveRowState = createMemo((): LiveGroupState | undefined => {
    const s = shownLive();
    if (s.kind === "idle") return undefined;
    if (s.kind !== "clearing" && s.groupKey !== undefined) return undefined;
    return s;
  });

  /**
   * One clock for the whole timeline, running only while a turn is open: the
   * live group's, or the drill-in's working row. A per-row interval would
   * re-render the list once a second forever.
   */
  const [now, setNow] = createSignal(0);
  const ticking = createMemo(() => {
    const kind = liveState().kind;
    if (kind === "working" || kind === "waiting") return true;
    return props.workingRow === true && rows().some((r) => r.kind === "working");
  });
  createEffect(() => {
    if (!ticking()) {
      setNow(0);
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  /**
   * What a screen reader hears, once per change of state. Keyed on the KIND,
   * so the clock never reaches it: the ticking row itself is `aria-live="off"`
   * inside the log. Arriving at an idle session says nothing; a turn that
   * ends says so.
   */
  let spoken = false;
  const announce = createMemo<string>((was) => {
    switch (liveState().kind) {
      case "working":
        spoken = true;
        return "Claude is working";
      case "waiting":
        spoken = true;
        return "Claude is waiting for you";
      case "clearing":
        spoken = true;
        return "Clearing the context, then Claude starts on the plan";
      case "idle":
        return spoken ? "Claude finished" : was;
    }
  }, "");

  const renderRow = (key: string): JSX.Element => {
    const row = rowAt(key);
    switch (row().kind) {
      case "user":
        return (
          <UserRowView
            row={row() as UserRow}
            me={props.me}
            session={props.session}
            onOpenPreview={props.onOpenPreview}
          />
        );
      case "continuation":
        return <ContinuationRowView row={row() as ContinuationRow} />;
      case "message":
        return <MessageRowView row={row() as MessageRow} me={props.me} />;
      case "thinking":
        return <ThinkingRowView row={row() as ThinkingRow} />;
      case "tool":
        if ((row() as ToolRow).itemType === "skill") {
          return <SkillRowView row={row() as ToolRow} />;
        }
        return (
          <ToolRowView
            row={row() as ToolRow}
            session={props.session}
            me={props.me}
            onOpenPreview={props.onOpenPreview}
            onLoadFull={props.onLoadFull}
            renderChild={renderLeaf}
          />
        );
      case "todo":
        return <TodoRowView row={row() as TodoRow} />;
      case "question":
        return (
          <Show when={!(props.cardDocked && (row() as QuestionRow).pending)}>
            <QuestionRowView row={row() as QuestionRow} />
          </Show>
        );
      case "plan": {
        const docked = (): boolean =>
          props.planDocked != null && planToolId(row()) === props.planDocked;
        return (
          <Show when={!(props.cardDocked && docked() && (row() as PlanRow).pending)}>
            <PlanRowView
              row={row() as PlanRow}
              docked={docked()}
              transient={
                props.planAnswer && props.planAnswer.toolId === planToolId(row())
                  ? props.planAnswer.action
                  : undefined
              }
            />
          </Show>
        );
      }
      case "meta":
        return <MetaRowView row={row() as MetaRow} />;
      case "permission":
        return <PermissionRowView row={row() as PermissionRow} />;
      case "error":
        return <ErrorRowView row={row() as ErrorRow} />;
      case "status":
        return <StatusRowView row={row() as StatusRow} />;
      case "working":
        return <WorkingRowView row={row() as WorkingRow} now={now()} />;
      case "work-group":
        return (
          <WorkGroupRowView
            row={row() as WorkGroupRow}
            session={props.session}
            me={props.me}
            onOpenPreview={props.onOpenPreview}
            onLoadFull={props.onLoadFull}
            renderChild={renderLeaf}
            live={liveGroupKey() === row().key ? shownLive() : undefined}
            now={now()}
          />
        );
      case "turn-fold":
        return (
          <TurnFoldRowView
            row={row() as TurnFoldRow}
            expanded={expandedTurns().has((row() as TurnFoldRow).turnKey)}
            onToggle={toggleTurn}
            session={props.session}
            me={props.me}
          />
        );
    }
  };

  // A transcript is read from its newest end. Events arrive over SSE well after
  // mount, so the entry position cannot be set once — the view stays pinned to
  // the bottom while it is at the bottom, and lets go the moment the operator
  // scrolls up to read something.
  let scroller: HTMLDivElement | undefined;
  const [pinned, writePinned] = createSignal(true);
  /**
   * Every write to the pin goes through here, so that a call site added later
   * cannot forget to tell the store.
   *
   * `published` is a plain variable rather than a read of `pinned()` because
   * this runs inside whatever scope called it, and reading the signal here
   * would subscribe that scope to the value it is in the middle of writing.
   * `props.pinned` is read through `untrack` for the same reason.
   *
   * And it is read at all because the store moves the pin on its own: every
   * `loadEarlier` unpins it, from the reader's scroll, from the auto-fill below
   * and from a find-in-session jump, none of which pass through here. Believing
   * the local copy after one of those left the store unpinned forever, which
   * turns the sliding window off for the rest of the session.
   */
  let published = true;
  const setPinned = (next: boolean): void => {
    writePinned(next);
    const stored = untrack(() => props.pinned);
    if (stored !== undefined) published = stored;
    if (next === published) return;
    published = next;
    props.onPinned?.(next);
  };

  const atBottom = (): boolean => {
    const el = scroller;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
  };
  const stickToBottom = (el: HTMLElement): void => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  };

  /**
   * Whether the reader is scrolling right now: a finger or a button held on the
   * transcript, or a wheel turn, scroll key or release within GESTURE_MS.
   *
   * Only the reader lets go of the live end. A scroll event arrives on the frame
   * after its scroll and reads that frame's geometry, and while a session opens
   * the pin's own write is routinely followed by rows, pictures and markdown
   * that grew the content before its event came in; a line added to the
   * composer does the same through the browser's clamp. Read as the reader's
   * scroll, each of those unpinned the view for good. Measured on 2026-09-27 on
   * 0.77.1: 4 to 7 of 8 cold opens of a session with pictures on phone Chrome
   * stopped 1,161 to 4,303px above the latest message with "Latest" showing.
   */
  let touching = false;
  let pressing = false;
  let gestureAt = Number.NEGATIVE_INFINITY;
  const gesture = (): void => {
    gestureAt = performance.now();
  };
  const readerScrolling = (): boolean =>
    touching || pressing || performance.now() - gestureAt < GESTURE_MS;

  const onScroll = () => {
    const el = scroller;
    if (el && pinned() && !atBottom() && !readerScrolling()) {
      if (!untrack(() => props.hidden)) stickToBottom(el);
      return;
    }
    setPinned(atBottom());
    maybeLoadEarlier();
  };

  onMount(() => {
    const el = scroller;
    if (!el) return;
    // A touch and a mouse button are held separately: a finger's own pointer
    // is cancelled the moment the browser takes it over to pan, while the
    // touch goes on.
    const touch = (): void => {
      touching = true;
      gesture();
    };
    const untouch = (): void => {
      touching = false;
      gesture();
    };
    const press = (e: PointerEvent): void => {
      if (e.pointerType === "touch") return;
      pressing = true;
      gesture();
    };
    const unpress = (): void => {
      if (!pressing) return;
      pressing = false;
      gesture();
    };
    // Keys scroll whichever scroller the reader last used, wherever focus is,
    // except in a field, where the same keys move a caret.
    const onKey = (e: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(e.key)) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest(EDITABLE))) return;
      gesture();
    };
    const passive = { passive: true } as const;
    el.addEventListener("wheel", gesture, passive);
    el.addEventListener("touchstart", touch, passive);
    el.addEventListener("touchmove", gesture, passive);
    el.addEventListener("pointerdown", press, passive);
    window.addEventListener("touchend", untouch, passive);
    window.addEventListener("touchcancel", untouch, passive);
    window.addEventListener("pointerup", unpress, passive);
    window.addEventListener("pointercancel", unpress, passive);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      el.removeEventListener("wheel", gesture);
      el.removeEventListener("touchstart", touch);
      el.removeEventListener("touchmove", gesture);
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("touchend", untouch);
      window.removeEventListener("touchcancel", untouch);
      window.removeEventListener("pointerup", unpress);
      window.removeEventListener("pointercancel", unpress);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  /**
   * Scroll to one event and flash its row — how a search hit is opened.
   *
   * False when no row carries that id yet, which has two causes and one answer:
   * the event is older than the window held (the caller loads earlier turns and
   * asks again), or its row has not been mounted yet by the progressive fill
   * (the caller waits a frame and asks again). Either way, unpinning first
   * matters — landing mid-transcript while still pinned means the next arriving
   * event scrolls straight back to the bottom.
   */
  const scrollToEvent = (id: number): boolean => {
    const el = scroller;
    // A call inside a folded work group has no row of its own; the group
    // answers for it (data-eids), and an open group's call row wins.
    const row =
      el?.querySelector<HTMLElement>(`[data-eid="${id}"]`) ??
      el?.querySelector<HTMLElement>(`[data-eids~="${id}"]`);
    if (!el || !row) return false;
    // A row nobody can see cannot be scrolled to, and the jump would report a
    // success that showed nothing. The owner puts the timeline back first.
    if (untrack(() => props.hidden)) props.onReveal?.();
    setPinned(false);
    row.scrollIntoView({ block: "center" });
    row.classList.add("tl-row-found");
    setTimeout(() => row.classList.remove("tl-row-found"), FOUND_FLASH_MS);
    return true;
  };
  // Jump-to-event belongs to the timeline on screen. Every session the lobby
  // keeps mounted has one of these, so claiming it on mount would hand it to
  // whichever session was opened last rather than to the one being read.
  ownWhile(() => props.owns !== false, "__tlScrollToEvent", scrollToEvent);

  /**
   * Anything clicked in here may have changed the transcript's height — a turn
   * unfolded, a command opened, a tool result loaded in full — and whether the
   * reader is still at the bottom is then a different question.
   *
   * Without this the pin kept whatever the last SCROLL event decided, and
   * expanding fires no scroll. Measured on a live session (2026-08-18): sitting
   * at the bottom, opening a command left the view 101px above it and still
   * flagged as pinned, so the next event to arrive scrolled to the bottom and
   * took the row that had just been opened 140px off with it. Which is the
   * opposite of why anyone clicks to expand something.
   *
   * On the frame after, because a native <details> toggles after its click and
   * the layout is not final until then. Recomputing when nothing moved is
   * harmless: it writes back the value it already had.
   */
  // Re-read whether the transcript is parked at the bottom after an
  // interaction that can change its height, from either device: a mouse click
  // on a fold, or the Enter that opens the same fold from the keyboard.
  const recheckPinned = () => {
    if (typeof requestAnimationFrame !== "function") {
      setPinned(atBottom());
      return;
    }
    requestAnimationFrame(() => setPinned(atBottom()));
  };

  /** Bring the reader to the latest message and pin the view there: a send
   *  (`follow`) and the owner's "Latest" (`registerToEnd`). */
  const toEnd = (): void => {
    setPinned(true);
    const el = scroller;
    // A hidden box takes no scroll. The pin is set, so the effect below
    // brings the reader to the live end the moment the timeline shows.
    if (el && !untrack(() => props.hidden)) stickToBottom(el);
  };
  createEffect(on(() => props.follow, toEnd, { defer: true }));
  props.registerToEnd?.(toEnd);
  createEffect(on(pinned, (atEnd) => props.onAtEnd?.(atEnd)));

  createEffect(() => {
    derived(); // the TRANSCRIPT grew — follow it. Expanding a fold must not
    // move the viewport: you clicked to read what was hidden.
    // A queued prompt is drawn after the last row too, so a ghost arriving
    // keeps a pinned reader at the bottom the same way a new row does.
    void props.queued?.length;
    // A hidden box has no geometry and takes no scroll, so this waits, and
    // runs again the moment the timeline shows: a reader who left it at the
    // live end comes back to the live end, however far the session has gone.
    if (props.hidden) return;
    const el = scroller;
    if (!el || !pinned()) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  });

  /**
   * The same pin, for when the timeline's own box changes size and nothing in
   * the transcript does. The agent panel takes 260px of this column's width
   * when it appears beside it, and the same rows wrap taller in what is left;
   * on a phone its strip's list takes height from above the transcript.
   * scrollTop holds through both and no scroll event fires, so the pin stayed
   * set with the view short of the bottom and no "Latest" button to say so.
   * Measured on 2026-09-24 at 1440x900: the panel arriving narrowed the rows
   * from 860 to 760px and left the reader 420px above the live end until the
   * next row came in.
   *
   * The box and never its content: a fold the reader opens grows the content,
   * and that must not move the viewport (the effect above says why).
   */
  onMount(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => {
      if (props.hidden || !pinned()) return;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  /**
   * The same pin, for a picture that finishes loading. Every picture here is a
   * lazy <img>, so it arrives after its row was laid out and pinned, and grows
   * the content by its own height with no scroll event and no change to this
   * box. Measured on 2026-09-26 at 1280x800: a session with pictures opened
   * 3014px above its latest message, still flagged as pinned with no "Latest"
   * button, and stayed there until the next event came in.
   *
   * A failed picture counts too: its text replaces it, at another height.
   * load and error do not bubble, so this listens on the way down, and it moves
   * the view a microtask later, once the picture's own handler has swapped the
   * fallback in. A reader who scrolled up is left alone, as everywhere else.
   */
  onMount(() => {
    const el = scroller;
    if (!el) return;
    const onPicture = (e: globalThis.Event) => {
      if (!(e.target instanceof HTMLImageElement)) return;
      queueMicrotask(() => {
        if (props.hidden || !pinned()) return;
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      });
    };
    el.addEventListener("load", onPicture, true);
    el.addEventListener("error", onPicture, true);
    onCleanup(() => {
      el.removeEventListener("load", onPicture, true);
      el.removeEventListener("error", onPicture, true);
    });
  });

  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
  const loadEarlier = async () => {
    if (!props.onLoadEarlier || loadingEarlier() || !props.hasEarlier) return;
    setLoadingEarlier(true);
    const el = scroller;
    const anchor = el?.querySelector<HTMLElement>(ANCHOR_ROW_SELECTOR);
    const before = anchor?.offsetTop ?? 0;
    try {
      await props.onLoadEarlier();
    } catch (err) {
      // Telling the reader is the caller's job, and the session store already
      // does it — it catches its own fetch failures and raises a toast, so in
      // practice this promise resolves. What this catch is for is the case
      // where it does not: both scroll paths call `void loadEarlier()` and the
      // button hands the async function straight to onClick, so an escaping
      // rejection would surface through ADR-0008's unhandledrejection handler
      // as an anonymous app.exception. Naming it here keeps the failure
      // reported and attributed. The finally below still runs, which is what
      // puts the reader back and re-enables asking.
      diag().onException(err, "load-earlier");
    } finally {
      // Keep the reader where they were — the same anchor-based compensation the
      // background mount uses, for the same reason. It runs even on a failed
      // load: a rejected fetch that left this flag set would disable reaching
      // back for the rest of the session.
      if (el && anchor) {
        const compensated = scrollTopAfterPrepend(el.scrollTop, before, anchor.offsetTop);
        // Writing scrollTop fires a scroll event of its own. Left unmarked, that
        // event asks for another window, and if the one that just arrived is
        // shorter than the trigger zone it asks again, and again — pulling the
        // whole session while the reader sits still. Only a scroll the READER
        // caused is a request for more.
        //
        // Marked only when the write actually MOVES anything: nothing was
        // inserted above (a failed load, an empty window) means no event of ours
        // is coming, and claiming one would swallow the reader's next scroll.
        if (compensated !== el.scrollTop) {
          selfScrollTop = compensated;
          el.scrollTop = compensated;
        }
      }
      setLoadingEarlier(false);
    }
  };

  /**
   * Reaching the top IS the request for more. No button: scrolling up to read
   * back through a conversation is one continuous gesture, and interrupting it
   * to aim at a link is the part that felt wrong.
   *
   * Fires a window early (EARLIER_TRIGGER_PX) so the rows are usually already
   * there by the time the reader arrives at them. It cannot run away, and that
   * is the anchor compensation's doing rather than a guard here: the reader is
   * pushed down by exactly the height that was inserted above, so the top of the
   * transcript ends up a whole window further away and the trigger zone is left
   * behind. One load at a time via loadingEarlier; nothing at all once the
   * server says there is no more (hasEarlier).
   */
  const EARLIER_TRIGGER_PX = 400;
  /** The scrollTop this component wrote itself, so the resulting scroll event is
   *  not mistaken for the reader asking for more. */
  let selfScrollTop: number | null = null;
  const maybeLoadEarlier = (): void => {
    const el = scroller;
    if (!el) return;
    if (selfScrollTop !== null && el.scrollTop === selfScrollTop) {
      selfScrollTop = null; // our own compensation, not a gesture
      return;
    }
    selfScrollTop = null;
    if (!props.hasEarlier || loadingEarlier()) return;
    if (el.scrollTop > EARLIER_TRIGGER_PX) return;
    void loadEarlier();
  };

  /**
   * A transcript that does not fill its own viewport has no scrollbar, so no
   * scroll event will ever ask for the rest of it. Fill it until it either
   * scrolls or runs out — otherwise a short window of short turns would strand
   * the reader with no way back and nothing to drag.
   */
  createEffect(() => {
    derived();
    props.hasEarlier;
    if (!props.hasEarlier || loadingEarlier() || filling()) return;
    const el = scroller;
    if (!el) return;
    // An UNMEASURED container reads 0/0, which is not the same as "too short to
    // scroll" — mistaking one for the other fires a load on every open, before
    // the reader has done anything at all.
    if (el.clientHeight <= 0) return;
    if (el.scrollHeight > el.clientHeight + 8) return; // scrollable: the gesture takes over
    void loadEarlier();
  });

  return (
    <div
      class="tl-timeline"
      classList={{ "tl-hidden": props.hidden === true }}
      role="log"
      aria-label={props.label ?? "Session transcript"}
      aria-hidden={props.hidden ? "true" : undefined}
      // A click on the transcript lands the focus here rather than on the
      // page's body, so the keys stay the view's: a docked card's row digits
      // work after the reader clicked the conversation, and the arrow keys
      // scroll it.
      tabIndex={-1}
      ref={scroller}
      onScroll={onScroll}
      onClick={recheckPinned}
      onKeyUp={recheckPinned}
    >
      <Show
        when={allKeys().length > 0}
        fallback={
          <div class="tl-empty-state">
            {props.opening ? "Loading the conversation…" : "No messages yet."}
          </div>
        }
      >
        {/* The top of what is held, and its own status line. Scrolling into it
            asks for the next step; the button is the same request for a reader
            who would rather tap than scroll, and the retry when one fails.
            Inside the Show, so a session with nothing in it does not announce
            the start of a conversation that has not happened. */}
        <div class="tl-row tl-row-earlier">
          <Show
            when={props.hasEarlier}
            fallback={<span class="tl-status-text">{props.start ?? "Start of session"}</span>}
          >
            <button
              type="button"
              class="tl-linkbtn"
              onClick={loadEarlier}
              disabled={loadingEarlier()}
            >
              {loadingEarlier() ? "Loading earlier…" : "Load earlier turns"}
            </button>
          </Show>
        </div>
        <Show when={filling()}>
          <div class="tl-row tl-row-filling" aria-live="polite">
            <span class="tl-working-dot" />
            <span class="tl-status-text">
              loading earlier rows… ({allKeys().length - shownKeys().length} left)
            </span>
          </div>
        </Show>
        <For each={shownKeys()}>{(key) => renderRow(key)}</For>
        <Show when={liveRowState()}>{(s) => <LiveRowView state={s()} now={now()} />}</Show>
        <GhostRowsView
          queued={props.queued ?? []}
          me={props.me}
          onOpenPreview={props.onOpenPreview}
        />
      </Show>
      <span class="tl-sr-only tl-timeline-live" aria-live="polite">
        {announce()}
      </span>
    </div>
  );
};
