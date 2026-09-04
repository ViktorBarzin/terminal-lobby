import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import type { Event } from "../types/events";
import { diag } from "../telemetry/diag";
import {
  deriveRows,
  sameRow,
  scrollTopAfterPrepend,
  visibleRows,
  type ErrorRow,
  type LeafRow,
  type MessageRow,
  type MetaRow,
  type PermissionRow,
  type PlanRow,
  type QuestionRow,
  type StatusRow,
  type ThinkingRow,
  type TimelineRow,
  type TodoRow,
  type ToolRow,
  type TurnFoldRow,
  type UserRow,
  type WorkingRow,
} from "./timeline.logic";
import { Markdown } from "./Markdown";
import { ownWhile } from "../lib/ownwhile";
import { MessageSegments } from "./Attachment";
import {
  MetaRowView,
  PlanRowView,
  QuestionRowView,
  ThinkingRowView,
  TodoRowView,
  SkillRowView,
  ToolRowView,
  TurnFoldRowView,
  WorkingRowView,
} from "./rows";

const USER_COLLAPSE_CHARS = 600;

const UserRowView: Component<{
  row: UserRow;
  /** effective OS user — decides whether a store path is ours to fetch. */
  me?: string;
  onOpenPreview?: (path: string) => void;
}> = (props) => {
  const long = () => props.row.body.length > USER_COLLAPSE_CHARS;
  const [open, setOpen] = createSignal(false);
  const shown = () =>
    long() && !open()
      ? props.row.body.slice(0, USER_COLLAPSE_CHARS) + "…"
      : props.row.body;
  return (
    <div class="tl-row tl-row-user" data-eid={props.row.id}>
      <div class="tl-bubble-user">
        {/* Still a <pre>: the message's own whitespace is significant, and an
            <img>/<button> is phrasing content, so substituting a path in place
            costs the surrounding text nothing. */}
        <pre class="tl-user-text">
          <MessageSegments
            text={shown()}
            me={props.me ?? ""}
            onOpen={props.onOpenPreview}
          />
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

const MessageRowView: Component<{ row: MessageRow; me?: string }> = (props) => (
  <div class="tl-row tl-row-message" data-eid={props.row.id}>
    <Show when={props.row.body.trim()} fallback={<span class="tl-empty">(empty response)</span>}>
      {/* `me` turns bare absolute paths in Claude's prose into attachments too
          (design 2026-08-17 decision 8), skipping code — see Markdown.tsx. */}
      <Markdown text={props.row.body} attachAs={props.me} />
    </Show>
  </div>
);

const PermissionRowView: Component<{ row: PermissionRow }> = (props) => {
  const state = () =>
    props.row.decision ? `resolved: ${props.row.decision}` : "awaiting decision";
  return (
    <div class="tl-row tl-row-permission" data-decision={props.row.decision || "pending"}>
      <span class="tl-perm-icon">🔐</span>
      <span class="tl-perm-tool">{props.row.tool || "permission"}</span>
      <span class="tl-perm-state">{state()}</span>
    </div>
  );
};

const ErrorRowView: Component<{ row: ErrorRow }> = (props) => (
  <div class="tl-row tl-row-error">
    <pre class="tl-code tl-code-error">{props.row.body}</pre>
  </div>
);

const StatusRowView: Component<{ row: StatusRow }> = (props) => (
  <div class="tl-row tl-row-status" data-subtype={props.row.subtype}>
    <span class="tl-status-text">{props.row.body || props.row.subtype}</span>
  </div>
);

/** How far off the bottom still counts as "reading the live end". */
const PIN_SLACK_PX = 40;


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
 * back through a per-key memo whose equality is `sameRow`: an unchanged row
 * never notifies, a changed one updates its existing node in place.
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
   * The effective OS user. Attachments in a message are drawn only when this
   * says the file is ours to fetch: the clipboard read-back routes resolve inside
   * the CALLER's own store directory, so a path belonging to someone else would
   * either 404 or answer with our own same-named file (design 2026-08-17
   * decisions 7 and 12). Absent → every path stays text, which is what this view
   * did before attachments rendered at all.
   */
  me?: string;
  /** the opening window has not arrived yet — this is "not yet", not "none". */
  opening?: boolean;
  /** FALSE while this timeline belongs to a session the lobby is keeping
   *  mounted but not showing — it then owns no window-level handles. */
  owns?: boolean;
}> = (props) => {
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());
  /** Split from `rows` so the scroll pin can follow the TRANSCRIPT alone. */
  const derived = createMemo<TimelineRow[]>(
    () => props.rows ?? deriveRows(props.events),
  );
  const rows = createMemo<TimelineRow[]>(() =>
    visibleRows(derived(), expandedTurns()),
  );

  /** The rows indexed by a render key, unique even if an event id repeats. */
  const keyed = createMemo(() => {
    const keys: string[] = [];
    const byKey = new Map<string, TimelineRow>();
    for (const row of rows()) {
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

  /** One row, held stable while its content is unchanged. */
  const rowAt = (key: string): Accessor<TimelineRow> => {
    let last = keyed().byKey.get(key)!;
    return createMemo<TimelineRow>(
      () => {
        // A row leaving the list can still be read once before its node is
        // disposed; hold the last value rather than crashing on undefined.
        const row = keyed().byKey.get(key);
        if (row) last = row;
        return last;
      },
      last,
      { equals: sameRow },
    );
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
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    });
    if (typeof ric.requestIdleCallback === "function") {
      const handle = ric.requestIdleCallback(() => growMounted(total), { timeout: 200 });
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
  /** The suffix of rows that is currently mounted, newest-first growth. */
  const shownKeys = createMemo<string[]>(
    () => {
      const keys = allKeys();
      const n = Math.min(keys.length, mounted());
      return n >= keys.length ? keys : keys.slice(keys.length - n);
    },
    [],
    { equals: sameKeys },
  );
  /** True while rows are still being mounted — the reader sees a hint. */
  const filling = createMemo(() => shownKeys().length < allKeys().length);

  // A ticking clock for the working row's elapsed timer. One timer for the
  // whole timeline, running only while something is actually working — a
  // per-row interval would re-render the list once a second forever.
  const [now, setNow] = createSignal(0);
  createEffect(() => {
    const working = rows().some((r) => r.kind === "working");
    if (!working) {
      setNow(0);
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

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
        return <ToolRowView row={row} onOpenPreview={props.onOpenPreview} onLoadFull={props.onLoadFull} renderChild={renderLeaf} />;
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
        return <UserRowView row={row} me={props.me} onOpenPreview={props.onOpenPreview} />;
      case "permission":
        return <PermissionRowView row={row} />;
    }
  };

  // The row kind is encoded in its key, so a node never changes kind under
  // itself and the switch can run once, at creation.
  const renderRow = (key: string): JSX.Element => {
    const row = rowAt(key);
    switch (row().kind) {
      case "user":
        return (
          <UserRowView
            row={row() as UserRow}
            me={props.me}
            onOpenPreview={props.onOpenPreview}
          />
        );
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
            onOpenPreview={props.onOpenPreview}
            onLoadFull={props.onLoadFull}
            renderChild={renderLeaf}
          />
        );
      case "todo":
        return <TodoRowView row={row() as TodoRow} />;
      case "question":
        return (
          <QuestionRowView
            row={row() as QuestionRow}
          />
        );
      case "plan":
        return <PlanRowView row={row() as PlanRow} />;
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
      case "turn-fold":
        return (
          <TurnFoldRowView
            row={row() as TurnFoldRow}
            expanded={expandedTurns().has((row() as TurnFoldRow).turnKey)}
            onToggle={toggleTurn}
          />
        );
    }
  };

  // A transcript is read from its newest end. Events arrive over SSE well after
  // mount, so the entry position cannot be set once — the view stays pinned to
  // the bottom while it is at the bottom, and lets go the moment the operator
  // scrolls up to read something.
  let scroller: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);

  const atBottom = (): boolean => {
    const el = scroller;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
  };
  const onScroll = () => {
    setPinned(atBottom());
    maybeLoadEarlier();
  };

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
    const row = el?.querySelector<HTMLElement>(`[data-eid="${id}"]`);
    if (!el || !row) return false;
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
  const onClick = () => {
    if (typeof requestAnimationFrame !== "function") {
      setPinned(atBottom());
      return;
    }
    requestAnimationFrame(() => setPinned(atBottom()));
  };

  createEffect(() => {
    derived(); // the TRANSCRIPT grew — follow it. Expanding a fold must not
    // move the viewport: you clicked to read what was hidden.
    const el = scroller;
    if (!el || !pinned()) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
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
      role="log"
      aria-label="Session transcript"
      ref={scroller}
      onScroll={onScroll}
      onClick={onClick}
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
            fallback={<span class="tl-status-text">Start of session</span>}
          >
            <button type="button" class="tl-linkbtn" onClick={loadEarlier} disabled={loadingEarlier()}>
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
      </Show>
      <Show when={!pinned()}>
        <button
          type="button"
          class="tl-scroll-end"
          onClick={() => {
            const el = scroller;
            if (!el) return;
            el.scrollTop = el.scrollHeight;
            setPinned(true);
          }}
        >
          ↓ Latest
        </button>
      </Show>
    </div>
  );
};
