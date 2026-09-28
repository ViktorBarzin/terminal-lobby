import {
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  Show,
  Switch,
  type Component,
} from "solid-js";
import { Markdown } from "./Markdown";
import { Picture } from "./Attachment";
import { contentUrlFor } from "../lib/attachments";
import { toolImageUrl } from "../lib/config";
import type { PictureKind } from "../store/picture";
import { commandOutput, diffHunks, diffStat, type ItemType } from "./canonicalize";
import {
  declinedCall,
  groupSummary,
  planHeader,
  planSummary,
  shortTarget,
  shownPlanOutcome,
  pickedIn,
  type ContinuationRow,
  type LiveGroupState,
  type MetaRow,
  type PlanRow,
  type PlanTransient,
  type QuestionRow,
  type ThinkingRow,
  type TodoRow,
  type ToolRow,
  type TurnFoldRow,
  type WorkGroupRow,
  type WorkingRow,
  type WorkLeaf,
  type WorkPicture,
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
export function formatCharCount(n: number): string {
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
                  <div
                    class="tl-diff-line"
                    data-sign={l.sign === " " ? "ctx" : l.sign === "+" ? "add" : "del"}
                  >
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
        <span>{formatCharCount(props.row.bytes!)} collapsed</span>
      </Show>
      <Show when={props.row.at}>
        <span>{clockTime(props.row.at!)}</span>
      </Show>
    </span>
  </div>
);

/** One tool-row thumbnail: where its bytes come from and what it is called. */
interface Thumb {
  src: string;
  alt: string;
  kind: PictureKind;
}

/**
 * What an opened call shows: the diff for an edit, a command's output split
 * into stdout and stderr, anything else's output, "Show full output" for a
 * result the wire capped, and the raw input. ToolRowView opens into it, and so
 * does a call row inside a work group, so a group hides no detail a tool row
 * had.
 */
const ToolDetail: Component<{
  row: ToolRow;
  /** The result is only pictures, which the caller draws as thumbnails. */
  pictureOnly: boolean;
  /** Fetch the full payload for a result the wire capped. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
}> = (props) => {
  const [full, setFull] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const loadFull = async () => {
    if (!props.onLoadFull || !props.row.toolId || loading()) return;
    setLoading(true);
    setFull(await props.onLoadFull(props.row.toolId));
    setLoading(false);
  };
  return (
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
          props.row.result !== undefined &&
          !props.pictureOnly
        }
      >
        <>
          <div class="tl-tool-section-label">output{props.row.isError ? " (error)" : ""}</div>
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
  );
};

/** The +added −removed an edit made, or null for any other call. */
function editStat(row: ToolRow): { added: number; removed: number } | null {
  if (row.itemType !== "file_change") return null;
  const stat = diffStat(diffHunks(row.payload));
  return stat.added || stat.removed ? stat : null;
}

/** The file a call names, for its preview chip and its thumbnails' names. */
const callPath = (row: ToolRow): string => row.changedFiles[0] ?? row.detail;

/** Whether a call names a file the preview overlay can open. */
const canPreview = (row: ToolRow): boolean =>
  (row.itemType === "file_change" || row.itemType === "file_read") && callPath(row).startsWith("/");

export const ToolRowView: Component<{
  row: ToolRow;
  /** the session, whose transcript holds a result's picture blocks. */
  session?: string;
  /** the effective OS user, which decides whether a store path is ours. */
  me?: string;
  onOpenPreview?: (path: string) => void;
  /** Fetch the full payload for a result the wire capped. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** Rendered for a subagent's nested rows. */
  renderChild?: (row: ToolRow["children"][number]) => unknown;
}> = (props) => {
  const [open, setOpen] = createSignal(false);

  const status = () => (!props.row.done ? "running" : props.row.isError ? "error" : "ok");
  const tick = () => (!props.row.done ? "…" : props.row.isError ? "✗" : "✓");
  const stat = createMemo(() => editStat(props.row));
  const path = () => callPath(props.row);
  const previewable = () => props.onOpenPreview && canPreview(props.row);

  /**
   * The pictures this call handed back, as small thumbnails (2026-09-24,
   * reversing the August design's decision 8, which kept tool rows to their
   * path). A Read of an image returns only the picture, so the row used to
   * show 8 KiB of its base64 as output; a screenshot tool writes a file and
   * links it relative to where Claude was started. The first is read back from
   * the transcript by index, the second from disk by the absolute path the
   * server resolved. Either needs what it reads from: a session for a block,
   * an address for a file.
   */
  const thumbs = createMemo<Thumb[]>(() => {
    const out: Thumb[] = [];
    const toolId = props.row.toolId;
    if (props.session && toolId) {
      const alt = basename(path()) || "Picture";
      for (const ref of props.row.images ?? []) {
        out.push({ src: toolImageUrl(props.session, toolId, ref.n), alt, kind: "block" });
      }
    }
    for (const file of props.row.files ?? []) {
      const src = contentUrlFor(file, props.me ?? "");
      if (src) out.push({ src, alt: basename(file), kind: "file" });
    }
    return out;
  });
  /** A result that is only pictures has nothing for the output block to say. */
  const pictureOnly = () => thumbs().length > 0 && !props.row.result;

  return (
    <div
      class="tl-row tl-row-tool"
      data-eid={props.row.id}
      data-status={status()}
      data-item={props.row.itemType}
    >
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
        <Show when={stat()}>
          {(s) => (
            <span class="tl-diff-stat">
              <span class="tl-diff-add">+{s().added}</span>
              <span class="tl-diff-del">−{s().removed}</span>
            </span>
          )}
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

      {/* Outside the expanded part, so a picture shows while the row is
          folded: looking at it is the reason to open the row at all. A
          thumbnail that cannot be read simply goes, and the row keeps its
          label and its path chip. */}
      <Show when={thumbs().length > 0}>
        <div class="tl-tool-thumbs">
          <For each={thumbs()}>
            {(t) => <Picture src={t.src} alt={t.alt} size="thumb" source="tool" kind={t.kind} />}
          </For>
        </div>
      </Show>

      {/* A subagent's work is nested, not interleaved: its rows belong to the
          call that spawned it and read as a sub-timeline. */}
      <Show when={props.row.children.length > 0}>
        <div class="tl-subagent">
          <For each={props.row.children}>{(c) => <>{props.renderChild?.(c)}</>}</For>
        </div>
      </Show>

      <Show when={open()}>
        <ToolDetail row={props.row} pictureOnly={pictureOnly()} onLoadFull={props.onLoadFull} />
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
    <div
      class="tl-row tl-row-question"
      data-eid={props.row.id}
      data-pending={props.row.pending ? "true" : undefined}
    >
      <For each={props.row.questions}>
        {(q, qi) => (
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
                      data-chosen={pickedIn(props.row.answers[qi()], o.label) ? "true" : undefined}
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
              <button type="button" class="tl-question-full" onClick={() => setFull((v) => !v)}>
                {full() ? "Show less" : "Show all"}
              </button>
            </Show>
            <Show when={!props.row.pending && props.row.answers[qi()]}>
              {(answer) => <div class="tl-question-answer">answered: {answer()}</div>}
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

/**
 * A plan put up for approval, and what became of it
 * (docs/plans/2026-09-24-text-composer-redesign.md, "Outcomes in the
 * timeline").
 *
 * Pending, it shows the whole plan. While the plan card is docked below, the
 * card is showing the same plan with its choices, so the row shrinks to one
 * line saying where to look. Once answered, the header says how, and the body
 * folds to its first line: the plan was read when it was answered, and a long
 * one would otherwise stand between the reader and what Claude did with it.
 *
 * `transient` is this client's own answer, applied and not in the transcript
 * yet (shownPlanOutcome). It wins over the docked stub, since the card
 * undocks the moment the answer applies.
 */
export const PlanRowView: Component<{
  row: PlanRow;
  /** The plan card docked above the composer is showing this row's plan. */
  docked?: boolean;
  transient?: PlanTransient;
}> = (props) => {
  const outcome = createMemo(() => shownPlanOutcome(props.row, props.transient));
  const open = () => outcome().kind === "pending";
  const stub = () => open() && props.docked === true;
  const summary = createMemo(() => planSummary(props.row.body));
  const [expanded, setExpanded] = createSignal(false);
  /* The folded line is cut off with an ellipsis. A plan written as one long
     paragraph has no second line for `summary().more` to see, yet on a phone
     most of it sits past the ellipsis, so the row measures its own line. The
     value holds while the plan is expanded and the line is not in the DOM. */
  const [cut, setCut] = createSignal(false);
  const watchSummary = (el: HTMLDivElement) => {
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    queueMicrotask(measure);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const feedback = () => {
    const o = outcome();
    return o.kind === "sent-back" ? o.feedback : "";
  };
  return (
    <div
      class="tl-row tl-row-plan"
      data-eid={props.row.id}
      data-outcome={outcome().kind}
      data-docked={stub() ? "true" : undefined}
    >
      <div class="tl-plan-head">
        <Show
          when={open()}
          fallback={
            <span class="tl-plan-outcome" data-outcome={outcome().kind}>
              {planHeader(outcome())}
            </span>
          }
        >
          <span class="tl-plan-chip">Plan</span>{" "}
          <span class="tl-plan-state">
            waiting for your approval{stub() ? " · shown below" : ""}
          </span>
        </Show>
      </div>
      <Show when={feedback()}>
        <blockquote class="tl-plan-feedback">{feedback()}</blockquote>
      </Show>
      <Show when={!stub()}>
        <Show
          when={open() || expanded()}
          fallback={
            <div class="tl-plan-summary" ref={watchSummary}>
              {summary().line}
            </div>
          }
        >
          <div class="tl-plan-body">
            <Markdown text={props.row.body} />
          </div>
        </Show>
        <Show when={!open() && (summary().more || cut())}>
          <button
            type="button"
            class="tl-linkbtn tl-plan-toggle"
            aria-expanded={expanded()}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded() ? "Hide plan" : "Show plan"}
          </button>
        </Show>
      </Show>
    </div>
  );
};

/**
 * The first record of a conversation the plan approval started by clearing the
 * context (docs/plans/2026-09-24-text-composer-redesign.md, "After clear
 * context"): a marker saying the context was cleared, the approved plan as a
 * resolved plan row, and the reader's feedback when the approval carried some.
 * It stands in for the "Implement the following plan: …" message the CLI
 * wrote, which is not drawn.
 */
export const ContinuationRowView: Component<{ row: ContinuationRow }> = (props) => (
  <div class="tl-row tl-row-continuation" data-eid={props.row.id}>
    <div class="tl-continuation-marker">
      <span class="tl-meta-rule" />
      <span class="tl-continuation-marker-text">Context cleared · carrying out the plan</span>
      <span class="tl-meta-rule" />
    </div>
    <PlanRowView row={props.row.plan} />
    <Show when={props.row.feedback}>
      <div class="tl-continuation-feedback">
        <span class="tl-continuation-caption">With your feedback</span>
        <blockquote class="tl-plan-feedback">{props.row.feedback}</blockquote>
      </div>
    </Show>
  </div>
);

/* Keyed by the whole MetaKind because the wire contract carries all of them.
   `mode` and `permission-mode` no longer reach this view: deriveRows drops
   them, since the model sheet already shows the mode in force. The
   record stays total so a new kind cannot be added without a label. */
const META_LABEL: Record<MetaRow["meta"], string> = {
  mode: "mode",
  "permission-mode": "permissions",
  // Dropped by deriveRows since 2026-09-24: a queued prompt is a ghost bubble
  // at the end of the timeline while it waits, and its own row once taken.
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
  // deriveRows drops it: the question card is where a held question shows.
  held: "held",
  // Dropped by deriveRows too: the reading belongs to the model sheet's
  // context line, and one row per settled turn would divide the whole
  // transcript.
  context: "context",
  // Dropped by deriveRows for the same reason as the mode: which model is
  // answering is state, and the composer's model button shows it.
  model: "model",
  // Dropped by deriveRows as well: a command the CLI ran itself shows where
  // its effect lands, and the event is there for the pending bubble.
  command: "command",
};

export const MetaRowView: Component<{ row: MetaRow }> = (props) => (
  <div class="tl-row tl-row-meta" data-eid={props.row.id} data-meta={props.row.meta}>
    {/* One centred muted line, the T3 pass's note (2026-09-27); it was a rule
        either side of the words until then. `title` because the text is
        clamped to three lines (app.css): a marker row is not where a reader
        should have to read a long value. The `queued` rows that carried whole
        prompts were the reason for the clamp, and are ghost bubbles now
        (MessagesTimeline). */}
    <span class="tl-meta-text" title={props.row.body || undefined}>
      {META_LABEL[props.row.meta]}
      <Show when={props.row.body && props.row.meta !== "compact"}>
        {" · "}
        <span class="tl-meta-value">{props.row.body}</span>
      </Show>
    </span>
  </div>
);

/**
 * The open turn's working row, drawn only in an agent's drill-in
 * (AgentTranscript), whose calls are rows of their own rather than work
 * groups. A session's own timeline draws the live group at its end instead
 * (LiveRowView, or the running WorkGroupRowView; 2026-09-27).
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
        <Show
          when={props.row.toolLabel}
          fallback={props.row.waiting ? "Waiting for you" : "Working…"}
        >
          <span class="tl-working-tool">{props.row.tool}</span>
          <span class="tl-working-label">{props.row.toolLabel}</span>
        </Show>
      </span>
      <Show when={elapsed()}>
        <span class="tl-working-elapsed">{elapsed()}</span>
      </Show>
      <Show when={props.row.steps > 1}>
        <span class="tl-working-steps">{props.row.steps} steps</span>
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Work groups (the T3 pass, 2026-09-27; docs/plans/2026-09-27-text-view-t3-pass.md).

/** The icons a work group draws, from the prototype's own set (16px box, stroked). */
const GROUP_ICON = {
  command: "m3 4.5 3.2 3.5L3 11.5M8 12h5",
  edit: "M10.8 2.6 13.4 5.2 6 12.6l-3.2.6.6-3.2z",
  read: "M9 1.8H4.6a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.6L9 1.8ZM9 1.8v3.8h3.8M5.8 8.4h4.4M5.8 11h3",
  search: "M11.4 7a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0ZM10.4 10.4l3.4 3.4",
  picture:
    "M3.8 2.8h8.4a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H3.8a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2ZM6.9 6.3a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0ZM2.4 12l3.8-3.6 2.6 2.4 2.1-1.8 3 2.6",
  thought: "M8 1.8v12.4M2.6 4.9l10.8 6.2M2.6 11.1l10.8-6.2",
  tools:
    "M10.2 2.2a3.2 3.2 0 0 0-3 4.3L2.6 11.1a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a3.2 3.2 0 0 0 4.3-3l-1.9 1.3-1.7-.5-.5-1.7z",
} as const;
type GroupIcon = keyof typeof GROUP_ICON;

const GroupIconSvg: Component<{ icon: GroupIcon; class: string }> = (props) => (
  <svg
    class={props.class}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={GROUP_ICON[props.icon]} />
  </svg>
);

/** The chevron a group's head ends on; it turns a quarter while the group is open. */
const GroupChevron: Component = () => (
  <svg
    class="tl-group-chev"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m4.4 2.6 3.4 3.4-3.4 3.4" />
  </svg>
);

/** What one row of an open group calls itself: its icon and its verb. */
function callKind(leaf: WorkLeaf): { icon: GroupIcon; word: string } {
  if (leaf.kind === "thinking") return { icon: "thought", word: "Thought" };
  switch (leaf.itemType) {
    case "command_execution":
      return { icon: "command", word: "Ran" };
    case "file_change":
      return { icon: "edit", word: "Edited" };
    case "file_read":
      // Grep and Glob classify as reads (canonicalize), but they search.
      return leaf.tool === "Grep" || leaf.tool === "Glob"
        ? { icon: "search", word: "Searched" }
        : { icon: "read", word: "Read" };
    case "web_search":
      return { icon: "search", word: "Searched" };
    case "image_view":
      return { icon: "picture", word: "Viewed" };
    case "skill":
      return { icon: "tools", word: "Loaded" };
    case "collab_agent_tool_call":
      return { icon: "tools", word: "Agent" };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "todo":
    case "question":
    case "plan":
      return { icon: "tools", word: "Used" };
  }
}

/** One thumbnail's address, or null when there is nothing to read it from. */
function thumbOf(
  p: WorkPicture,
  session: string | undefined,
  me: string | undefined,
): Thumb | null {
  if (p.kind === "block") {
    if (!session) return null;
    return {
      src: toolImageUrl(session, p.toolId, p.n),
      alt: basename(p.label) || "Picture",
      kind: "block",
    };
  }
  const src = contentUrlFor(p.path, me ?? "");
  return src ? { src, alt: basename(p.path), kind: "file" } : null;
}

/**
 * The pictures a group's calls handed back, as 76px thumbnails under it, drawn
 * whether the group is open or folded: looking at them is often the reason to
 * read the group at all. One press opens the lightbox, which tells telemetry
 * the picture came from a tool, as a tool row's thumbnail always has.
 */
const WorkPictures: Component<{
  pictures: readonly WorkPicture[];
  session?: string;
  me?: string;
}> = (props) => {
  const thumbs = createMemo(() =>
    props.pictures.flatMap((p) => thumbOf(p, props.session, props.me) ?? []),
  );
  return (
    <Show when={thumbs().length > 0}>
      <div class="tl-group-pics">
        <For each={thumbs()}>
          {(t) => <Picture src={t.src} alt={t.alt} size="thumb" source="tool" kind={t.kind} />}
        </For>
      </div>
    </Show>
  );
};

/** The spinner a running group and its call in flight wear. */
const GroupSpinner: Component = () => <span class="tl-group-spin" aria-hidden="true" />;

/**
 * One call in an open group: icon, verb, the call's own label in the mono face,
 * and on the right the edit's line counts, a tick, a cross, or a spinner while
 * it runs. Pressing it opens the same detail a tool row opens into.
 */
const WorkCallRow: Component<{
  leaf: WorkLeaf;
  me?: string;
  onOpenPreview?: (path: string) => void;
  onLoadFull?: (toolId: string) => Promise<string | null>;
  renderChild?: (row: ToolRow["children"][number]) => unknown;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const kind = () => callKind(props.leaf);
  const call = () => (props.leaf.kind === "tool" ? props.leaf : null);
  const status = () => {
    const c = call();
    if (!c) return "ok";
    if (!c.done) return "running";
    if (declinedCall(c)) return "declined";
    return c.isError ? "error" : "ok";
  };
  const label = () => {
    const leaf = props.leaf;
    if (leaf.kind === "thinking") return leaf.body.trim().split("\n")[0] ?? "";
    return leaf.label || leaf.tool || "tool";
  };
  const stat = createMemo(() => {
    const c = call();
    return c ? editStat(c) : null;
  });
  return (
    <div
      class="tl-group-call"
      data-eid={props.leaf.id}
      data-status={status()}
      data-open={open() ? "" : undefined}
    >
      <button
        type="button"
        class="tl-group-call-head"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <GroupIconSvg icon={kind().icon} class="tl-group-call-ico" />
        <span class="tl-group-call-kind">{kind().word}</span>
        <span class="tl-group-call-label" title={label()}>
          {label()}
        </span>
        <span class="tl-group-call-st">
          <Show when={status() === "running"}>
            <GroupSpinner />
          </Show>
          <Show when={status() === "error"}>
            <span class="tl-group-call-err">✗</span>
          </Show>
          <Show when={status() === "declined"}>
            <span class="tl-group-call-declined">declined</span>
          </Show>
          {/* Thinking is not a call: it neither passes nor fails. */}
          <Show when={status() === "ok" && call()}>
            <Show when={stat()} fallback={<span class="tl-group-call-ok">✓</span>}>
              {(s) => (
                <>
                  <span class="tl-diff-add">+{s().added}</span>
                  <Show when={s().removed}>
                    <span class="tl-diff-del">−{s().removed}</span>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </span>
      </button>
      <Show when={open()}>
        <div class="tl-group-call-detail">
          <Show
            when={call()}
            fallback={
              <div class="tl-thinking-body">
                <Markdown text={props.leaf.kind === "thinking" ? props.leaf.body : ""} />
              </div>
            }
          >
            {(c) => (
              <>
                <Show when={props.onOpenPreview && canPreview(c())}>
                  <button
                    type="button"
                    class="tl-tool-pathchip"
                    title={`Preview ${callPath(c())}`}
                    onClick={() => props.onOpenPreview?.(callPath(c()))}
                  >
                    {basename(callPath(c()))}
                  </button>
                </Show>
                <Show when={c().children.length > 0}>
                  <div class="tl-subagent">
                    <For each={c().children}>{(r) => <>{props.renderChild?.(r)}</>}</For>
                  </div>
                </Show>
                <ToolDetail
                  row={c()}
                  pictureOnly={
                    ((c().images?.length ?? 0) > 0 || (c().files?.length ?? 0) > 0) && !c().result
                  }
                  onLoadFull={props.onLoadFull}
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};

/** A live state the running group draws: the open turn's, working or waiting. */
type OpenLive = Extract<LiveGroupState, { kind: "working" | "waiting" }>;

/** The live state, when it is one a group or a row draws. */
const openLive = (s: LiveGroupState | undefined): OpenLive | undefined =>
  s && (s.kind === "working" || s.kind === "waiting") ? s : undefined;

/**
 * The left of a live head: a spinner while Claude works or clears the context,
 * a still dot in the awaiting colour while it waits on the reader, since a
 * spinner is what says work is happening.
 */
const LiveMark: Component<{ kind: LiveGroupState["kind"] }> = (props) => (
  <Show when={props.kind === "waiting"} fallback={<GroupSpinner />}>
    <span class="tl-live-dot" aria-hidden="true" />
  </Show>
);

/** What a live head says: "Running <code>ls</code>", "Working…", "Waiting for you". */
const LiveWords: Component<{ state: LiveGroupState }> = (props) => {
  const what = () => {
    const s = props.state;
    return s.kind === "working" ? s.label || s.tool : undefined;
  };
  return (
    <Switch>
      <Match when={props.state.kind === "clearing"}>
        Clearing the context and starting the plan…
      </Match>
      <Match when={props.state.kind === "waiting"}>Waiting for you</Match>
      <Match when={what()}>
        {(w) => (
          <>
            Running <code title={w()}>{shortTarget(w())}</code>
          </>
        )}
      </Match>
      <Match when={props.state.kind === "working"}>Working…</Match>
    </Switch>
  );
};

/**
 * The meta on the right of a live head: "2 done · 14s" on the running group,
 * the time alone before the first call and while Claude waits. Clearing has
 * no clock: the old turn is closed and the new one has not begun.
 */
function liveMeta(s: LiveGroupState, now: number, inGroup: boolean): string {
  if (s.kind !== "working" && s.kind !== "waiting") return "";
  const t = s.since !== undefined && now > 0 ? formatDuration(Math.max(0, now - s.since)) : "";
  if (s.kind === "working" && inGroup) return t ? `${s.done} done · ${t}` : `${s.done} done`;
  return t;
}

/**
 * The live row at the end of the conversation, for the states no running
 * group carries: before the first call ("Working…"), waiting on the reader
 * with no group at the end, and a context clear this device started. It wears
 * the group's box so it sits in the same place, and the running group takes
 * its place the moment a call starts. Nothing opens it: it holds no calls.
 */
export const LiveRowView: Component<{ state: LiveGroupState; now: number }> = (props) => (
  <div class="tl-row tl-row-live">
    <div class="tl-group-box" data-live={props.state.kind} aria-live="off">
      <div class="tl-group-head tl-live-head">
        <LiveMark kind={props.state.kind} />
        <Show when={props.state.kind !== "clearing"}>
          <GroupIconSvg icon="tools" class="tl-group-ico" />
        </Show>
        <span class="tl-group-sum">
          <LiveWords state={props.state} />
        </span>
        <Show when={liveMeta(props.state, props.now, false)}>
          {(m) => <span class="tl-group-meta">{m()}</span>}
        </Show>
      </div>
    </div>
  </div>
);

/**
 * One run of tool calls between two replies, as one bordered row: a status
 * dot, what the calls did ("Edited 2 files, ran 2 commands"), a tick and the
 * time on the right, and a chevron. Pressed, it lists one compact row per
 * call. The running group at the end of an open turn names the call in flight
 * with a spinner instead, and counts the calls done and the time so far.
 *
 * The open state is this view's own signal. MessagesTimeline keys rows by
 * `key`, a group's is its first row's, and a row's content arrives through a
 * per-key signal, so the view outlives every append and an open group stays
 * open. The calls go through `<Index>` for the same reason: a group grows at
 * its end, so an opened call keeps its place and its state.
 */
export const WorkGroupRowView: Component<{
  row: WorkGroupRow;
  /** the session, whose transcript holds a result's picture blocks. */
  session?: string;
  /** the effective OS user, which decides whether a store path is ours. */
  me?: string;
  onOpenPreview?: (path: string) => void;
  onLoadFull?: (toolId: string) => Promise<string | null>;
  renderChild?: (row: ToolRow["children"][number]) => unknown;
  /** The live state, handed to the running group at the end of an open turn
   *  (timeline.logic `liveGroupState`). Absent, the group is settled. */
  live?: LiveGroupState;
  /** The timeline's clock, which ticks only while a turn is open. */
  now?: number;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const live = () => openLive(props.live);
  /** A call with no result in a group that is not the live one, and not
   *  stopped, is waiting on the reader: the card docked below asks about it,
   *  and the live state stays off the group while a card says it. */
  const waiting = () =>
    !live() &&
    !props.row.stopped &&
    props.row.calls.some((c) => c.kind === "tool" && !c.done);
  const status = () =>
    props.row.hasError
      ? "error"
      : props.row.stopped
        ? "stopped"
        : waiting()
          ? "waiting"
          : "ok";
  const summary = createMemo(() => groupSummary(props.row.calls, { waiting: waiting() }));
  const took = () => formatDuration(props.row.durationMs);
  /** Every event the group stands for, so a search hit on a folded call lands here. */
  const eids = () => props.row.calls.map((c) => c.id).join(" ");

  return (
    <div class="tl-row tl-row-group" data-eids={eids()}>
      <div
        class="tl-group-box"
        data-open={open() ? "" : undefined}
        data-live={live()?.kind}
        aria-live={live() ? "off" : undefined}
      >
        <button
          type="button"
          class="tl-group-head"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <Show when={live()} fallback={<span class="tl-group-dot" data-status={status()} />}>
            {(l) => <LiveMark kind={l().kind} />}
          </Show>
          <GroupIconSvg icon="tools" class="tl-group-ico" />
          <span class="tl-group-sum">
            <Show when={live()} fallback={summary()}>
              {(l) => <LiveWords state={l()} />}
            </Show>
          </span>
          <span class="tl-group-meta">
            <Show
              when={live()}
              fallback={
                <>
                  <Show when={status() === "error"}>
                    <span class="tl-group-failed">failed</span>
                    {took() ? " · " : ""}
                  </Show>
                  <Show when={status() === "stopped"}>stopped{took() ? " · " : ""}</Show>
                  <Show when={status() === "waiting"}>
                    <span class="tl-group-waiting">waiting</span>
                    {took() ? " · " : ""}
                  </Show>
                  <Show when={status() === "ok"}>
                    <span class="tl-group-okm">
                      <span class="tl-group-ok">✓</span>
                      {took() ? " · " : ""}
                    </span>
                  </Show>
                  {took()}
                </>
              }
            >
              {(l) => <>{liveMeta(l(), props.now ?? 0, true)}</>}
            </Show>
          </span>
          <GroupChevron />
        </button>
        <Show when={open()}>
          <div class="tl-group-list">
            <Index each={props.row.calls}>
              {(leaf) => (
                <WorkCallRow
                  leaf={leaf()}
                  me={props.me}
                  onOpenPreview={props.onOpenPreview}
                  onLoadFull={props.onLoadFull}
                  renderChild={props.renderChild}
                />
              )}
            </Index>
          </div>
        </Show>
      </div>
      <WorkPictures pictures={props.row.pictures} session={props.session} me={props.me} />
    </div>
  );
};

/**
 * A settled turn's fold, in the work group's bordered look: "Worked for 28s ·
 * 6 steps". It stands for the replies and groups it hides, so it says when
 * one of them failed, and it carries their pictures while it is shut; open, the
 * groups under it show their own.
 */
export const TurnFoldRowView: Component<{
  row: TurnFoldRow;
  expanded: boolean;
  onToggle: (turnKey: string) => void;
  /** the session, whose transcript holds a result's picture blocks. */
  session?: string;
  /** the effective OS user, which decides whether a store path is ours. */
  me?: string;
}> = (props) => {
  const tokens = () => {
    const u = props.row.usage;
    if (!u) return 0;
    return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  };
  return (
    <div class="tl-row tl-row-fold">
      <div class="tl-group-box" data-open={props.expanded ? "" : undefined}>
        <button
          type="button"
          class="tl-group-head tl-fold-btn"
          aria-expanded={props.expanded}
          data-has-error={props.row.hasError ? "true" : undefined}
          onClick={() => props.onToggle(props.row.turnKey)}
        >
          <span
            class="tl-group-dot"
            data-status={props.row.hasError ? "error" : props.row.stopped ? "stopped" : "ok"}
          />
          <span class="tl-group-sum tl-fold-label">
            {props.row.durationMs ? `Worked for ${formatDuration(props.row.durationMs)}` : "Worked"}
            {" · "}
            {props.row.count} {props.row.count === 1 ? "step" : "steps"}
          </span>
          <span class="tl-group-meta">
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
            {/* A fold is the only thing standing for the steps it hides, so a
                hidden failure has to surface here, in words, not by colour
                alone. */}
            <Show when={props.row.hasError}>
              <span class="tl-fold-error">✗ failed</span>
            </Show>
            <Show when={props.row.stopped && !props.row.hasError}>
              <span class="tl-fold-stopped">stopped</span>
            </Show>
          </span>
          <GroupChevron />
        </button>
      </div>
      <Show when={!props.expanded}>
        <WorkPictures pictures={props.row.pictures} session={props.session} me={props.me} />
      </Show>
    </div>
  );
};
