import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Markdown } from "./Markdown";
import { commandOutput, diffHunks, diffStat, type ItemType } from "./canonicalize";
import type {
  MetaRow,
  PlanRow,
  QuestionRow,
  ThinkingRow,
  TodoRow,
  ToolRow,
  TurnFoldRow,
  WorkingRow,
} from "./timeline.logic";
import { basename } from "../store/preview.logic";

/**
 * The row views for text mode. Each maps ONE canonical item type to the shape
 * that reads best for it: a command shows its output split into stdout and
 * stderr, a file change shows its diff, a todo list shows checkboxes.
 *
 * The visual grammar follows T3 Code's chat timeline — a compact line that
 * expands, tools kept visually quieter than prose — but every component here is
 * written for Solid; upstream's are React and do not port.
 */

/** The glyph for a canonical item type. Deliberately one column wide. */
export const ITEM_GLYPH: Record<ItemType, string> = {
  command_execution: "$",
  file_change: "✎",
  file_read: "◇",
  web_search: "⌕",
  image_view: "▣",
  mcp_tool_call: "⧉",
  collab_agent_tool_call: "◈",
  todo: "☑",
  question: "?",
  plan: "▤",
  dynamic_tool_call: "•",
};

export const ITEM_NOUN: Record<ItemType, string> = {
  command_execution: "Command",
  file_change: "Edit",
  file_read: "Read",
  web_search: "Search",
  image_view: "Image",
  mcp_tool_call: "MCP",
  collab_agent_tool_call: "Agent",
  todo: "Todo",
  question: "Question",
  plan: "Plan",
  dynamic_tool_call: "Tool",
};

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** 12.3k, the way a token count is easiest to read at a glance. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

// ---------------------------------------------------------------------------

export const ThinkingRowView: Component<{ row: ThinkingRow }> = (props) => {
  const [open, setOpen] = createSignal(false);
  // A one-line preview is enough to decide whether to read the rest.
  const preview = () => props.row.body.trim().split("\n")[0] ?? "";
  return (
    <div class="tl-row tl-row-thinking" classList={{ "tl-open": open() }}>
      <button
        type="button"
        class="tl-thinking-head"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="tl-thinking-glyph">✳</span>
        <span class="tl-thinking-label">Thought</span>
        <Show when={!open()}>
          <span class="tl-thinking-preview">{preview()}</span>
        </Show>
      </button>
      {/* Upstream folds thinking away and keeps only a label; the full text is
          here on expand, which is the one place we deliberately beat it. */}
      <Show when={open()}>
        <div class="tl-thinking-body">
          <Markdown text={props.row.body} />
        </div>
      </Show>
    </div>
  );
};

const DiffView: Component<{ payload: unknown }> = (props) => {
  const hunks = createMemo(() => diffHunks(props.payload));
  return (
    <Show when={hunks().length > 0}>
      <div class="tl-diff">
        <For each={hunks()}>
          {(h) => (
            <>
              <div class="tl-diff-hunk">{h.header}</div>
              <For each={h.lines}>
                {(l) => (
                  <div class="tl-diff-line" data-sign={l.sign === " " ? "ctx" : l.sign === "+" ? "add" : "del"}>
                    <span class="tl-diff-sign">{l.sign}</span>
                    <span class="tl-diff-text">{l.text}</span>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </Show>
  );
};

const CommandOutputView: Component<{
  payload: unknown;
  fallback: string;
  /** The call failed. With no stderr to point at, the output IS the error. */
  isError?: boolean;
}> = (props) => {
  const out = createMemo(() => commandOutput(props.payload, props.fallback));
  return (
    <Show when={out()}>
      {(o) => (
        <>
          <Show when={o().stdout}>
            <Show when={props.isError && !o().stderr}>
              <div class="tl-tool-section-label">output (error)</div>
            </Show>
            <pre class="tl-code" classList={{ "tl-code-error": !!props.isError && !o().stderr }}>
              {o().stdout}
            </pre>
          </Show>
          <Show when={o().stderr}>
            <div class="tl-tool-section-label">stderr</div>
            <pre class="tl-code tl-code-error">{o().stderr}</pre>
          </Show>
          <Show when={o().interrupted}>
            <div class="tl-tool-note">interrupted</div>
          </Show>
          <Show when={!o().stdout && !o().stderr}>
            <div class="tl-tool-note">no output</div>
          </Show>
        </>
      )}
    </Show>
  );
};

export const ToolRowView: Component<{
  row: ToolRow;
  onOpenPreview?: (path: string) => void;
  /** Fetch the full payload for a result the wire capped. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** Rendered for a subagent's nested rows. */
  renderChild?: (row: ToolRow["children"][number]) => unknown;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [full, setFull] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const status = () => (!props.row.done ? "running" : props.row.isError ? "error" : "ok");
  const tick = () => (!props.row.done ? "…" : props.row.isError ? "✗" : "✓");
  const stat = createMemo(() =>
    props.row.itemType === "file_change" ? diffStat(diffHunks(props.row.payload)) : null,
  );
  const path = () => props.row.changedFiles[0] ?? props.row.detail;
  const previewable = () =>
    props.onOpenPreview &&
    (props.row.itemType === "file_change" || props.row.itemType === "file_read") &&
    path().startsWith("/");

  const loadFull = async () => {
    if (!props.onLoadFull || !props.row.toolId || loading()) return;
    setLoading(true);
    setFull(await props.onLoadFull(props.row.toolId));
    setLoading(false);
  };

  return (
    <div class="tl-row tl-row-tool" data-status={status()} data-item={props.row.itemType}>
      <div class="tl-tool-head">
        <button
          type="button"
          class="tl-tool-toggle"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <span class="tl-tool-glyph" data-item={props.row.itemType}>
            {ITEM_GLYPH[props.row.itemType]}
          </span>
          <span class="tl-tool-name">{ITEM_NOUN[props.row.itemType]}</span>
          <span class="tl-tool-label" title={props.row.label}>
            {props.row.label || props.row.tool || "tool"}
          </span>
        </button>
        <Show when={stat() && (stat()!.added || stat()!.removed)}>
          <span class="tl-diff-stat">
            <span class="tl-diff-add">+{stat()!.added}</span>
            <span class="tl-diff-del">−{stat()!.removed}</span>
          </span>
        </Show>
        <Show when={previewable()}>
          <button
            type="button"
            class="tl-tool-pathchip"
            title={`Preview ${path()}`}
            onClick={() => props.onOpenPreview?.(path())}
          >
            {basename(path())}
          </button>
        </Show>
        <span class="tl-tool-tick" data-status={status()}>
          {tick()}
        </span>
      </div>

      {/* A subagent's work is nested, not interleaved: its rows belong to the
          call that spawned it and read as a sub-timeline. */}
      <Show when={props.row.children.length > 0}>
        <div class="tl-subagent">
          <For each={props.row.children}>{(c) => <>{props.renderChild?.(c)}</>}</For>
        </div>
      </Show>

      <Show when={open()}>
        <div class="tl-tool-raw">
          <Show when={props.row.detail && props.row.detail !== props.row.label}>
            <div class="tl-tool-detail">{props.row.detail}</div>
          </Show>
          <Show when={props.row.itemType === "file_change"}>
            <DiffView payload={props.row.payload} />
          </Show>
          <Show when={props.row.itemType === "command_execution"}>
            <CommandOutputView
              payload={props.row.payload}
              fallback={props.row.result ?? ""}
              isError={props.row.isError}
            />
          </Show>
          <Show
            when={
              props.row.itemType !== "file_change" &&
              props.row.itemType !== "command_execution" &&
              props.row.result !== undefined
            }
          >
            <>
              <div class="tl-tool-section-label">
                output{props.row.isError ? " (error)" : ""}
              </div>
              <pre class="tl-code" classList={{ "tl-code-error": props.row.isError }}>
                {props.row.result}
              </pre>
            </>
          </Show>
          <Show when={props.row.truncated}>
            <Show
              when={full()}
              fallback={
                <button type="button" class="tl-linkbtn" onClick={loadFull} disabled={loading()}>
                  {loading() ? "Loading…" : "Show full output"}
                </button>
              }
            >
              <pre class="tl-code">{full()}</pre>
            </Show>
          </Show>
          <details class="tl-tool-input">
            <summary>input</summary>
            <pre class="tl-code">{props.row.input}</pre>
          </details>
        </div>
      </Show>
    </div>
  );
};

export const TodoRowView: Component<{ row: TodoRow }> = (props) => {
  const done = () => props.row.steps.filter((s) => s.status === "completed").length;
  return (
    <div class="tl-row tl-row-todo">
      <div class="tl-todo-head">
        <span class="tl-todo-count">
          {done()}/{props.row.steps.length}
        </span>
        <span class="tl-todo-title">Todos</span>
      </div>
      <ul class="tl-todo-list">
        <For each={props.row.steps}>
          {(s) => (
            <li class="tl-todo-item" data-status={s.status}>
              <span class="tl-todo-box">
                {s.status === "completed" ? "☑" : s.status === "inProgress" ? "▸" : "☐"}
              </span>
              <span class="tl-todo-text">{s.step}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

/**
 * An AskUserQuestion. While it is pending this is the thing blocking the
 * session, so the options are buttons: picking one types the answer into the
 * pane (ADR-0010). Once answered it stays as the record of what was chosen.
 */
export const QuestionRowView: Component<{
  row: QuestionRow;
  onAnswer?: (optionIndex: number) => void;
}> = (props) => (
  <div class="tl-row tl-row-question" data-pending={props.row.pending ? "true" : undefined}>
    <For each={props.row.questions}>
      {(q, qi) => (
        <div class="tl-question">
          <div class="tl-question-head">
            <span class="tl-question-chip">{q.header || "Question"}</span>
            <span class="tl-question-text">{q.question}</span>
          </div>
          <div class="tl-question-options">
            <For each={q.options}>
              {(o, oi) => (
                <Show
                  when={props.row.pending && qi() === 0}
                  fallback={
                    <div
                      class="tl-question-option"
                      data-chosen={props.row.answers.includes(o.label) ? "true" : undefined}
                    >
                      <span class="tl-option-key">{oi() + 1}</span>
                      <span class="tl-option-label">{o.label}</span>
                    </div>
                  }
                >
                  <button
                    type="button"
                    class="tl-question-option tl-question-answerable"
                    onClick={() => props.onAnswer?.(oi())}
                    title={o.description}
                  >
                    <span class="tl-option-key">{oi() + 1}</span>
                    <span class="tl-option-label">{o.label}</span>
                  </button>
                </Show>
              )}
            </For>
          </div>
          <Show when={!props.row.pending && props.row.answers.length > 0}>
            <div class="tl-question-answer">answered: {props.row.answers.join(", ")}</div>
          </Show>
        </div>
      )}
    </For>
  </div>
);

export const PlanRowView: Component<{ row: PlanRow }> = (props) => (
  <div class="tl-row tl-row-plan">
    <div class="tl-plan-head">
      <span class="tl-plan-chip">Plan</span>
      <Show when={props.row.pending}>
        <span class="tl-plan-state">awaiting approval</span>
      </Show>
    </div>
    <div class="tl-plan-body">
      <Markdown text={props.row.body} />
    </div>
  </div>
);

/* Keyed by the whole MetaKind because the wire contract carries all of them.
   `mode` and `permission-mode` no longer reach this view — deriveRows drops
   them, since the composer's chip already shows the mode in force — but the
   record stays total so a new kind cannot be added without a label. */
const META_LABEL: Record<MetaRow["meta"], string> = {
  mode: "mode",
  "permission-mode": "permissions",
  queued: "queued",
  compact: "context compacted",
  "hook-error": "hook failed",
};

export const MetaRowView: Component<{ row: MetaRow }> = (props) => (
  <div class="tl-row tl-row-meta" data-meta={props.row.meta}>
    <span class="tl-meta-rule" />
    <span class="tl-meta-text">
      {META_LABEL[props.row.meta]}
      <Show when={props.row.body && props.row.meta !== "compact"}>
        {" · "}
        <span class="tl-meta-value">{props.row.body}</span>
      </Show>
    </span>
    <span class="tl-meta-rule" />
  </div>
);

/**
 * The live row. It names the call actually in flight and ticks its own timer —
 * the transcript records a tool_use the moment Claude emits it, so this is
 * specific without a second data source (design decision 6).
 */
export const WorkingRowView: Component<{ row: WorkingRow; now: number }> = (props) => {
  const elapsed = () => {
    const from = props.row.toolStartedAt ?? props.row.startedAt;
    if (!from || !props.now) return "";
    return formatDuration(props.now - from);
  };
  return (
    <div class="tl-row tl-row-working" aria-live="polite">
      <span class="tl-working-dot" />
      <span class="tl-working-text">
        <Show when={props.row.toolLabel} fallback="Working…">
          <span class="tl-working-tool">{props.row.tool}</span>
          <span class="tl-working-label">{props.row.toolLabel}</span>
        </Show>
      </span>
      <Show when={elapsed()}>
        <span class="tl-working-elapsed">{elapsed()}</span>
      </Show>
      <Show when={props.row.steps > 1}>
        <span class="tl-working-steps">
          {props.row.steps} {props.row.steps === 1 ? "step" : "steps"}
        </span>
      </Show>
    </div>
  );
};

export const TurnFoldRowView: Component<{
  row: TurnFoldRow;
  expanded: boolean;
  onToggle: (turnKey: string) => void;
}> = (props) => {
  const tokens = () => {
    const u = props.row.usage;
    if (!u) return 0;
    return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  };
  return (
    <div class="tl-row tl-row-fold">
      <button
        type="button"
        class="tl-fold-btn"
        aria-expanded={props.expanded}
        data-has-error={props.row.hasError ? "true" : undefined}
        onClick={() => props.onToggle(props.row.turnKey)}
      >
        <span class="tl-fold-caret">{props.expanded ? "▾" : "▸"}</span>
        <span class="tl-fold-label">
          {props.row.durationMs ? `Worked for ${formatDuration(props.row.durationMs)}` : "Worked"}
          {" · "}
          {props.row.count} {props.row.count === 1 ? "step" : "steps"}
        </span>
        <Show when={props.row.changedFiles.length > 0}>
          <span class="tl-fold-files">
            {props.row.changedFiles.length === 1
              ? basename(props.row.changedFiles[0]!)
              : `${props.row.changedFiles.length} files`}
          </span>
        </Show>
        <Show when={tokens() > 0}>
          <span class="tl-fold-tokens">{formatTokens(tokens())} tok</span>
        </Show>
        {/* A fold is the only thing standing for the steps it hides, so a hidden
            failure has to surface here — in words, not by colour alone. */}
        <Show when={props.row.hasError}>
          <span class="tl-fold-error">✗ failed</span>
        </Show>
      </button>
    </div>
  );
};
