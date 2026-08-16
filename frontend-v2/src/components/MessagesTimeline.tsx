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
import {
  deriveRows,
  sameRow,
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
import {
  MetaRowView,
  PlanRowView,
  QuestionRowView,
  ThinkingRowView,
  TodoRowView,
  ToolRowView,
  TurnFoldRowView,
  WorkingRowView,
} from "./rows";

const USER_COLLAPSE_CHARS = 600;

const UserRowView: Component<{ row: UserRow }> = (props) => {
  const long = () => props.row.body.length > USER_COLLAPSE_CHARS;
  const [open, setOpen] = createSignal(false);
  const shown = () =>
    long() && !open()
      ? props.row.body.slice(0, USER_COLLAPSE_CHARS) + "…"
      : props.row.body;
  return (
    <div class="tl-row tl-row-user">
      <div class="tl-bubble-user">
        <pre class="tl-user-text">{shown()}</pre>
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

const MessageRowView: Component<{ row: MessageRow }> = (props) => (
  <div class="tl-row tl-row-message" classList={{ "tl-streaming": props.row.streaming }}>
    <Show when={props.row.body.trim()} fallback={<span class="tl-empty">(empty response)</span>}>
      <Markdown text={props.row.body} />
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

/**
 * Rows rendered above and below the viewport. A transcript's rows vary wildly
 * in height (a one-line tool row, a 200-line diff), so windowing by index needs
 * generous margins or fast scrolling shows blank space.
 */
const OVERSCAN = 12;

/** Below this many rows, windowing costs more than it saves. */
const VIRTUALIZE_ABOVE = 120;

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

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
  /** open a file path in the preview overlay (Read/Edit/Write tool rows). */
  onOpenPreview?: (path: string) => void;
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** answer the blocking question by its option index. */
  onAnswer?: (row: QuestionRow, optionIndex: number) => void;
  /** load the window of turns before the oldest one held. */
  onLoadEarlier?: () => Promise<void>;
  /** true while older turns exist to load. */
  hasEarlier?: boolean;
}> = (props) => {
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());
  /** Split from `rows` so the scroll pin can follow the TRANSCRIPT alone. */
  const derived = createMemo<TimelineRow[]>(() => deriveRows(props.events));
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

  const toggleTurn = (turnKey: string) =>
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (!next.delete(turnKey)) next.add(turnKey);
      return next;
    });

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
        return <MessageRowView row={row} />;
      case "thinking":
        return <ThinkingRowView row={row} />;
      case "tool":
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
        return <UserRowView row={row} />;
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
        return <UserRowView row={row() as UserRow} />;
      case "message":
        return <MessageRowView row={row() as MessageRow} />;
      case "thinking":
        return <ThinkingRowView row={row() as ThinkingRow} />;
      case "tool":
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
            onAnswer={(i) => props.onAnswer?.(row() as QuestionRow, i)}
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
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);

  // Windowing. Row heights vary far too much to measure ahead, so the window is
  // an index range around the scroll position derived from an AVERAGE row
  // height, padded by OVERSCAN on both sides. The spacers keep the scrollbar
  // honest. Below VIRTUALIZE_ABOVE rows everything renders, which is the common
  // case and keeps behaviour (and tests) simple.
  const windowed = createMemo(() => {
    const keys = allKeys();
    if (keys.length <= VIRTUALIZE_ABOVE || height() === 0) {
      return { keys, before: 0, after: 0 };
    }
    const avg = Math.max(28, (scroller?.scrollHeight ?? 0) / keys.length);
    const first = Math.max(0, Math.floor(top() / avg) - OVERSCAN);
    const visible = Math.ceil(height() / avg) + OVERSCAN * 2;
    const last = Math.min(keys.length, first + visible);
    return {
      keys: keys.slice(first, last),
      before: first * avg,
      after: (keys.length - last) * avg,
    };
  });

  const onScroll = () => {
    const el = scroller;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX);
    setTop(el.scrollTop);
    setHeight(el.clientHeight);
  };

  createEffect(() => {
    derived(); // the TRANSCRIPT grew — follow it. Expanding a fold must not
    // move the viewport: you clicked to read what was hidden.
    const el = scroller;
    if (!el) return;
    if (height() === 0) setHeight(el.clientHeight);
    if (!pinned()) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    setTop(el.scrollTop);
  });

  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
  const loadEarlier = async () => {
    if (!props.onLoadEarlier || loadingEarlier()) return;
    setLoadingEarlier(true);
    const el = scroller;
    const before = el?.scrollHeight ?? 0;
    await props.onLoadEarlier();
    // Keep the reader where they were: prepending rows would otherwise push
    // what they are looking at down the page by the height of everything added.
    if (el) el.scrollTop += el.scrollHeight - before;
    setLoadingEarlier(false);
  };

  return (
    <div
      class="tl-timeline"
      role="log"
      aria-label="Session transcript"
      ref={scroller}
      onScroll={onScroll}
    >
      <Show when={props.hasEarlier}>
        <div class="tl-row tl-row-earlier">
          <button type="button" class="tl-linkbtn" onClick={loadEarlier} disabled={loadingEarlier()}>
            {loadingEarlier() ? "Loading…" : "Load earlier turns"}
          </button>
        </div>
      </Show>
      <Show
        when={allKeys().length > 0}
        fallback={<div class="tl-empty-state">No messages yet.</div>}
      >
        <div style={{ height: `${windowed().before}px` }} aria-hidden="true" />
        <For each={windowed().keys}>{(key) => renderRow(key)}</For>
        <div style={{ height: `${windowed().after}px` }} aria-hidden="true" />
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
