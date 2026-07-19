import {
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import type { Event } from "../types/events";
import {
  deriveRows,
  visibleRows,
  type ErrorRow,
  type MessageRow,
  type PermissionRow,
  type StatusRow,
  type TimelineRow,
  type ToolRow,
  type TurnFoldRow,
  type UserRow,
  type WorkingRow,
} from "./timeline.logic";
import { Markdown } from "./Markdown";
import { basename, parseToolPath } from "../store/preview.logic";

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

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

const ToolRowView: Component<{
  row: ToolRow;
  onOpenPreview?: (path: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const status = () =>
    !props.row.done ? "running" : props.row.isError ? "error" : "ok";
  const tick = () =>
    !props.row.done ? "…" : props.row.isError ? "✗" : "✓";
  // A Read/Edit/Write file path becomes a preview link when a handler is wired.
  const previewPath = () =>
    props.onOpenPreview ? parseToolPath(props.row.tool, props.row.input) : null;
  return (
    <div class="tl-row tl-row-tool" data-status={status()}>
      <div class="tl-tool-head">
        <button
          type="button"
          class="tl-tool-toggle"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <span class="tl-tool-caret">{open() ? "▾" : "▸"}</span>
          <span class="tl-tool-name">{props.row.tool || "tool"}</span>
        </button>
        <Show when={previewPath()}>
          {(p) => (
            <button
              type="button"
              class="tl-tool-pathchip"
              title={`Preview ${p()}`}
              onClick={() => props.onOpenPreview?.(p())}
            >
              {basename(p())}
            </button>
          )}
        </Show>
        <span class="tl-tool-tick" data-status={status()}>
          {tick()}
        </span>
      </div>
      <Show when={open()}>
        <div class="tl-tool-raw">
          <Show when={props.row.input}>
            <div class="tl-tool-section-label">input</div>
            <pre class="tl-code">{props.row.input}</pre>
          </Show>
          <Show when={props.row.result !== undefined}>
            <div class="tl-tool-section-label">
              output{props.row.isError ? " (error)" : ""}
            </div>
            <pre class="tl-code" classList={{ "tl-code-error": props.row.isError }}>
              {props.row.result}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  );
};

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

const WorkingRowView: Component<{ row: WorkingRow }> = () => (
  <div class="tl-row tl-row-working" aria-live="polite">
    <span class="tl-working-dot" />
    <span class="tl-working-text">Working…</span>
  </div>
);

const TurnFoldRowView: Component<{
  row: TurnFoldRow;
  onExpand: (turnKey: string) => void;
}> = (props) => (
  <div class="tl-row tl-row-fold">
    <button
      type="button"
      class="tl-fold-btn"
      onClick={() => props.onExpand(props.row.turnKey)}
    >
      <span class="tl-fold-caret">▸</span>
      <span class="tl-fold-label">
        {props.row.durationMs
          ? `Worked for ${formatDuration(props.row.durationMs)}`
          : "Worked"}
        {" · "}
        {props.row.count} {props.row.count === 1 ? "step" : "steps"}
      </span>
    </button>
  </div>
);

/**
 * Structured text-mode renderer. Derives folded rows from the raw event stream
 * (pure logic in timeline.logic) and maps each row kind to a view. Turn-fold
 * rows expand in place; tool rows expand to raw I/O. Fine-grained Solid `<For>`
 * updates only changed rows — no full re-render on stream append.
 */
export const MessagesTimeline: Component<{
  events: Event[];
  /** open a file path in the preview overlay (Read/Edit/Write tool rows). */
  onOpenPreview?: (path: string) => void;
}> = (props) => {
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());
  const rows = createMemo<TimelineRow[]>(() =>
    visibleRows(deriveRows(props.events), expandedTurns()),
  );

  const expand = (turnKey: string) =>
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      next.add(turnKey);
      return next;
    });

  const renderRow = (row: TimelineRow): JSX.Element => {
    switch (row.kind) {
      case "user":
        return <UserRowView row={row} />;
      case "message":
        return <MessageRowView row={row} />;
      case "tool":
        return <ToolRowView row={row} onOpenPreview={props.onOpenPreview} />;
      case "permission":
        return <PermissionRowView row={row} />;
      case "error":
        return <ErrorRowView row={row} />;
      case "status":
        return <StatusRowView row={row} />;
      case "working":
        return <WorkingRowView row={row} />;
      case "turn-fold":
        return <TurnFoldRowView row={row} onExpand={expand} />;
    }
  };

  return (
    <div class="tl-timeline" role="log" aria-label="Session transcript">
      <Show
        when={rows().length > 0}
        fallback={<div class="tl-empty-state">No messages yet.</div>}
      >
        <For each={rows()}>{(row) => renderRow(row)}</For>
      </Show>
    </div>
  );
};
