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
  skill: "⌘",
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
  skill: "Skill",
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

/**
 * 16.6 kB. What a collapsed skill body says about its own size.
 *
 * kB rather than KiB: these are character counts of prose, and the point is a
 * sense of scale, not an exact figure. The loads on this box run 3.1 kB median
 * to 23.3 kB, so one decimal below 10 and none above is all the precision the
 * number carries.
 */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const k = n / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)} kB`;
}

/** 15:38 — a wall clock, in the reader's own locale and zone. */
export function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------

export const ThinkingRowView: Component<{ row: ThinkingRow }> = (props) => {
  const [open, setOpen] = createSignal(false);
  // A one-line preview is enough to decide whether to read the rest.
  const preview = () => props.row.body.trim().split("\n")[0] ?? "";
  return (
    <div class="tl-row tl-row-thinking" data-eid={props.row.id} classList={{ "tl-open": open() }}>
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

/**
 * A skill load, marked as one.
 *
 * Viktor asked for a skill to be visibly a skill (2026-09-04) and for the card
 * to carry the name and nothing else. It is deliberately NOT expandable: the
 * body it stands in for is a median 3.1 kB and up to 23.3 kB of prose the reader
 * never wrote, and the Skills overlay renders SKILL.md properly for anyone who
 * does want to read one.
 *
 * One card for two records. `deriveRows` folds the `meta:skill` event's size
 * onto the `Skill` call, so the size here is what was collapsed — and it is
 * absent when the call FAILED, since no body is injected for a skill whose name
 * does not resolve.
 */
export const SkillRowView: Component<{ row: ToolRow }> = (props) => (
  <div
    class="tl-row tl-row-skill"
    data-eid={props.row.id}
    data-failed={props.row.isError ? "true" : undefined}
  >
    <span class="tl-skill-kind">
      <span class="tl-skill-glyph" aria-hidden="true">
        {ITEM_GLYPH.skill}
      </span>
      skill
    </span>
    <span class="tl-skill-title" title={props.row.detail || undefined}>
      {props.row.label || "a skill"}
    </span>
    <span class="tl-skill-meta">
      <Show when={props.row.isError}>
        <span class="tl-skill-failed">did not load</span>
      </Show>
      <Show when={!props.row.isError && props.row.bytes}>
        <span>{formatBytes(props.row.bytes!)} collapsed</span>
      </Show>
      <Show when={props.row.at}>
        <span>{clockTime(props.row.at!)}</span>
      </Show>
    </span>
  </div>
);

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
    <div class="tl-row tl-row-tool" data-eid={props.row.id} data-status={status()} data-item={props.row.itemType}>
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
    <div class="tl-row tl-row-todo" data-eid={props.row.id}>
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
 * An AskUserQuestion, as the RECORD of what was asked and chosen.
 *
 * Answering happens in the card docked above the composer (QuestionCard), which
 * walks every question rather than only the first and can carry a multi-select.
 * This row is deliberately not a second way to answer: two paths into one dialog
 * is how the same question gets answered twice, and the pane cannot tell the two
 * senders apart. While the question is pending the row shows what is being
 * asked; the card is where it is answered.
 */
export const QuestionRowView: Component<{ row: QuestionRow }> = (props) => {
  // Same control the live card has: the descriptions are clamped to two lines
  // and this shows all of them at once. They used to be a `title` attribute —
  // a hover tooltip, in a view whose main device has no hover — so the reasoning
  // behind each option was simply absent from the record.
  const [full, setFull] = createSignal(false);
  const anyDesc = () =>
    props.row.questions.some((q) => q.options.some((o) => (o.description ?? "").trim() !== ""));
  return (
  <div class="tl-row tl-row-question" data-eid={props.row.id} data-pending={props.row.pending ? "true" : undefined}>
    <For each={props.row.questions}>
      {(q) => (
        <div class="tl-question">
          <div class="tl-question-head">
            <span class="tl-question-chip">{q.header || "Question"}</span>
            {/* The question text is the CARD's job while one is docked — it is a
                hundred pixels below this and set larger. Printing it here too was
                the duplication this collapse exists to remove, only quieter. What
                the transcript needs while waiting is the PLACE the question
                occupies; the words arrive when it becomes the record. */}
            <Show when={!props.row.pending}>
              <span class="tl-question-text">{q.question}</span>
            </Show>
          </div>
          {/* While the answer is still being given, this row is not the record
              yet — the card docked above the composer is asking the very same
              question, and rendering the options here too showed the whole thing
              twice, a card's height apart. It says what is being asked and where
              the answer is going, and becomes the full record when one lands. */}
          <Show when={props.row.pending}>
            <div class="tl-question-answering">answering below…</div>
          </Show>
          <Show when={!props.row.pending}>
          <div class="tl-question-options" data-full={full() ? "true" : undefined}>
            <For each={q.options}>
              {(o, oi) => (
                <div
                  class="tl-question-option"
                  data-chosen={props.row.answers.includes(o.label) ? "true" : undefined}
                >
                  <span class="tl-option-key">{oi() + 1}</span>
                  <span class="tl-option-label">{o.label}</span>
                  <Show when={o.description}>
                    <span class="tl-option-desc">{o.description}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          </Show>
          <Show when={!props.row.pending && anyDesc()}>
            <button
              type="button"
              class="tl-question-full"
              onClick={() => setFull((v) => !v)}
            >
              {full() ? "Show less" : "Show all"}
            </button>
          </Show>
          <Show when={!props.row.pending && props.row.answers.length > 0}>
            <div class="tl-question-answer">answered: {props.row.answers.join(", ")}</div>
          </Show>
          {/* Asked, never answered, and no longer on screen — Claude Code takes
              a dialog down when something else claims the turn and re-asks.
              Saying so beats a row that keeps the live-dialog look for the rest
              of the session. */}
          <Show when={props.row.superseded}>
            <div class="tl-question-answer">unanswered — the session moved on</div>
          </Show>
        </div>
      )}
    </For>
  </div>
);
};

export const PlanRowView: Component<{ row: PlanRow }> = (props) => (
  <div class="tl-row tl-row-plan" data-eid={props.row.id}>
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
  // deriveRows drops these three, the way it drops the mode kinds — they are
  // bookkeeping for the queue list. The record stays total so a new kind
  // cannot be added without a label.
  unqueued: "left the queue",
  dequeued: "taken from the queue",
  "queue-cleared": "queue cleared",
  skill: "skill",
  compact: "context compacted",
  "hook-error": "hook failed",
  // Dropped by deriveRows as well: what the pane says about a blocking question
  // is state, and the answer card is where it shows.
  asking: "waiting for an answer",
  // Dropped by deriveRows too — the reading belongs to the meter beside the
  // composer, and one row per settled turn would divide the whole transcript.
  context: "context",
  // Dropped by deriveRows for the same reason as the mode: which model is
  // answering is state, and the chip beside the composer shows it.
  model: "model",
};

export const MetaRowView: Component<{ row: MetaRow }> = (props) => (
  <div class="tl-row tl-row-meta" data-eid={props.row.id} data-meta={props.row.meta}>
    <span class="tl-meta-rule" />
    {/* `title` because the text is clamped to three lines (app.css): a `queued`
        row carries the whole prompt, and a marker row is not where a reader
        should have to read one. Nothing is lost — the prompt itself arrives as
        its own row the moment it is sent. */}
    <span class="tl-meta-text" title={props.row.body || undefined}>
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
 *
 * A turn can be open with nothing running, because Claude asked the reader
 * something and stopped. That row says so instead, and its clock counts the
 * wait rather than the turn (see WorkingRow.waiting).
 */
export const WorkingRowView: Component<{ row: WorkingRow; now: number }> = (props) => {
  const elapsed = () => {
    const from = props.row.toolStartedAt ?? props.row.startedAt;
    if (!from || !props.now) return "";
    return formatDuration(props.now - from);
  };
  return (
    <div
      class="tl-row tl-row-working"
      data-waiting={props.row.waiting ? "true" : undefined}
      aria-live="polite"
    >
      <span class="tl-working-dot" />
      <span class="tl-working-text">
        <Show when={props.row.toolLabel} fallback={props.row.waiting ? "Waiting for you" : "Working…"}>
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
