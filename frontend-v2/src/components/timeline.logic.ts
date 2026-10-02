import {
  ORIGIN_AUTO_CONTINUATION,
  type Event,
  type ImageRef,
  type MetaKind,
  type ModelState,
  type PermissionDecision,
  type TokenUsage,
  type SessionState,
} from "../types/events";
import type { PendingPrompt } from "../logic/compose.logic";
import type { DialogView, PlanOptionView } from "../lib/answer-api";
import { modeId, modeTitle } from "../logic/modes";
import { heldFromEvents } from "./question.logic";
import { withSentPictures, wordsOf } from "../lib/attachments";
import {
  describe as describeTool,
  extractTodoSteps,
  parseJSON,
  questions,
  type Described,
  type ItemType,
  type Question,
  type TodoStep,
} from "./canonicalize";

/**
 * Pure, DOM-free transcript→rows derivation (design pillar #2: "put the risky
 * transcript→rows mapping in a unit-tested module"). Every affordance —
 * folding, the live working indicator, collapsed tool calls — is expressed as a
 * DATA ROW, not conditional JSX, so the renderer stays a thin map over rows and
 * virtualization keys stay stable.
 *
 * Turn model (design): group by turnId when the backend supplies one; otherwise
 * synthesize turns at user-message boundaries (transcripts carry no turn id
 * today). A turn is "settled" once a turn_end event lands OR a later turn
 * begins; the last, unsettled turn never folds and shows a live row.
 * Tool_use/tool_result are paired by toolId (T3's collapseKey).
 *
 * An unsettled turn is not proof that anything is RUNNING. The turn ends on an
 * assistant record with a terminal stop_reason, and Claude stopping to ask the
 * reader something writes no such record until the answer arrives, so the live
 * row has to work out for itself whether it is watching work or a wait (see
 * WorkingRow.waiting). The case it still cannot tell apart is an abandoned turn
 * — a session killed mid-call looks exactly like one thinking hard — which
 * needs a signal the transcript does not carry.
 *
 * The folding rules follow t3code's MessagesTimeline.logic.ts (MIT, T3 Tools
 * Inc): the last assistant message of a settled turn stays visible as the
 * turn's answer and everything else folds behind "Worked for Ns". What a tool
 * row SAYS comes from canonicalize.ts, which reads the transcript's own payloads.
 *
 * Since the T3 pass (2026-09-27) each run of tool calls between two replies is
 * gathered into one work group row (see WorkGroupRow), in running and settled
 * turns alike, and a settled turn's fold hides replies and groups in order.
 */

export interface UserRow {
  kind: "user";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  at?: number;
  /** Pictures pasted into the terminal, drawn where `[Image #N]` stands. */
  images?: ImageRef[];
  /** The user record's uuid, which the prompt picture route is keyed by. */
  record?: string;
  /** Sent from here, and the session has not said it took it yet. */
  sending?: true;
}
export interface MessageRow {
  kind: "message";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  at?: number;
}
/** Claude's reasoning. Folded by default, kept in full on expand. */
export interface ThinkingRow {
  kind: "thinking";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  at?: number;
}
export interface ToolRow {
  kind: "tool";
  key: string;
  id: number;
  tool: string;
  toolId?: string;
  itemType: ItemType;
  /** What this call is doing — the command, the path, the query. */
  label: string;
  detail: string;
  changedFiles: string[];
  /** The raw JSON input, kept for "view raw". */
  input: string;
  /** The flattened result text. */
  result?: string;
  /** The structured `toolUseResult`, when it fit on the wire. */
  payload?: unknown;
  isError: boolean;
  done: boolean;
  /** When the result was written, once it has been. */
  doneAt?: number;
  /** The payload was capped; the full one is fetched by toolId. */
  truncated: boolean;
  /** Subagent work belonging to this call (collab_agent_tool_call only). */
  children: LeafRow[];
  /** The result's picture blocks (a Read of an image), read back by index. */
  images?: ImageRef[];
  /** Pictures a screenshot tool wrote, as absolute paths. */
  files?: string[];
  /**
   * How much SKILL.md this load collapsed (itemType "skill" only). Folded in
   * from the `meta:skill` event that follows the call, because one load has to
   * read as one thing: the call names the skill, the meta event knows the size.
   */
  bytes?: number;
  turnKey: string;
  at?: number;
}
/** A TodoWrite rendered as the checklist it is, not as a tool call. */
export interface TodoRow {
  kind: "todo";
  key: string;
  id: number;
  steps: TodoStep[];
  turnKey: string;
  at?: number;
}
/** An AskUserQuestion. Answerable while `pending`. */
export interface QuestionRow {
  kind: "question";
  key: string;
  id: number;
  toolId?: string;
  questions: Question[];
  /**
   * What was chosen, once the transcript records an answer: one entry per
   * question, in order, "" where it has none. A multi-select's picks are one
   * string joined by ", ", as the CLI records them (see `pickedIn`).
   */
  answers: string[];
  /**
   * What the reader sent instead of an answer, through the card's "Chat about
   * this": their words, "" when they sent none, undefined for any other
   * outcome (`chatReply`).
   */
  replied?: string;
  pending: boolean;
  /** Asked, never resolved, and no longer on screen — the session moved past
   *  it. See `markSuperseded`. */
  superseded?: boolean;
  turnKey: string;
  at?: number;
}
/** ExitPlanMode — a plan put up for approval. */
export interface PlanRow {
  kind: "plan";
  key: string;
  id: number;
  /** The ExitPlanMode call's id, which the plan card's dock and this client's
   *  own answer name the row by. */
  toolId?: string;
  /**
   * The plan as the reader should see it: the approved text once approved
   * (`toolUseResult.plan`, which carries edits made in the CLI with ctrl+g),
   * otherwise the call's input, corrected for a plan file written in the same
   * message (see `stale`).
   */
  body: string;
  /** No result yet, and nothing has happened since. Same as outcome "pending". */
  pending: boolean;
  outcome: PlanOutcome;
  /**
   * Claude changed the plan file while presenting it, in a way this row could
   * not replay (an Edit whose old text does not occur exactly once), so `body`
   * is the call's input and may be older than what the Terminal shows.
   */
  stale?: boolean;
  turnKey: string;
  at?: number;
}

/**
 * What became of a plan put up for approval, as the transcript records it
 * (docs/plans/2026-09-24-text-composer-redesign.md, "Outcomes in the
 * timeline"). "continuation" is the plan a ContinuationRow carries: the first
 * record of a new transcript after a clear, never an ExitPlanMode call.
 * "transient" never comes out of deriveRows; it is this client's own answer in
 * flight (see shownPlanOutcome).
 */
export type PlanOutcome =
  | { kind: "pending" }
  /** `mode` is the next permission-mode record in the turn, once it arrives. */
  | { kind: "approved"; mode?: string }
  | { kind: "sent-back"; feedback: string }
  | { kind: "rejected" }
  | { kind: "superseded" }
  | { kind: "continuation" }
  | { kind: "transient"; action: PlanTransient };

/** This client's plan answer, applied but not in the transcript yet. */
export type PlanTransient = "approve" | "feedback" | "clear";
/**
 * The first record of a conversation the plan approval started by clearing the
 * context (docs/plans/2026-09-24-text-composer-redesign.md, "After clear
 * context"). It takes the user row's slot, so it stays visible when the turn
 * folds, and stands in for the "Implement the following plan: …" message the
 * CLI wrote on the reader's behalf, which is not drawn.
 */
export interface ContinuationRow {
  kind: "continuation";
  key: string;
  id: number;
  /** The approved plan, as a resolved plan row (outcome "continuation"). */
  plan: PlanRow;
  /** What the reader added when approving, or "" when nothing was added. */
  feedback: string;
  turnKey: string;
  at?: number;
}
export interface PermissionRow {
  kind: "permission";
  key: string;
  id: number;
  reqId: string;
  tool: string;
  input: string;
  decision?: PermissionDecision | string;
  /**
   * The words the reader declined a call with, through the permission card's
   * "Type your own answer" (`declineWords`). Such a row stands for their
   * message, not for the prompt.
   */
  said?: string;
  turnKey: string;
  at?: number;
}
export interface ErrorRow {
  kind: "error";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  at?: number;
}
/** session / state / result meta events — rendered as a muted status line. */
export interface StatusRow {
  kind: "status";
  key: string;
  id: number;
  body: string;
  subtype: "session" | "state" | "result";
  turnKey: string;
  at?: number;
}
/** The session's own lifecycle: mode changes, queued prompts, compaction. */
export interface MetaRow {
  kind: "meta";
  key: string;
  id: number;
  meta: MetaKind;
  body: string;
  turnKey: string;
  at?: number;
}
export interface TurnFoldRow {
  kind: "turn-fold";
  key: string;
  turnKey: string;
  /** How many steps the fold hides, counting each call inside a work group. */
  count: number;
  /** What the hidden rows did, in the work group's words: "Ran 2 commands,
   *  edited 1 file, wrote 2 replies" (foldSummary). */
  summary: string;
  durationMs?: number;
  /** The replies and work groups the fold hides, in order. */
  hidden: FoldedRow[];
  /**
   * What opening the fold shows, in order, when a row the fold keeps in view
   * (a plan, an answered question, a status line) happened between two rows
   * it hides: those, with the kept rows back in their place. Absent when
   * opening shows `hidden` as it is. Opened, a kept row shows here and not
   * after the fold (`visibleRows`).
   */
  opened?: FoldedRow[];
  /** At least one hidden row is a failure — the collapsed row must say so. */
  hasError: boolean;
  /** The reader stopped the turn: the fold is drawn stopped, not done. */
  stopped: boolean;
  /** Files the turn changed, summarised on the collapsed row. */
  changedFiles: string[];
  /**
   * The pictures of the work groups the fold hides, in order. Pictures from
   * tools stay in view when their group is folded, and a folded turn folds
   * its groups too, so the fold row carries them.
   */
  pictures: WorkPicture[];
  usage?: TokenUsage;
}

/** A picture a call handed back, as a work group lists it. */
export type WorkPicture =
  /** An image block in the call's result, read back by the call's id and index. */
  | { kind: "block"; toolId: string; n: number; label: string }
  /** A file a screenshot tool wrote, by its absolute path. */
  | { kind: "file"; path: string };

/** What the running work group is doing, for its spinner row. */
export interface WorkGroupLive {
  /** The call in flight. Absent while Claude is between calls. */
  tool?: string;
  label?: string;
  itemType?: ItemType;
  detail?: string;
  /** When the group began: its first row. The row's clock counts from here. */
  startedAt?: number;
  /** When the call in flight began. */
  callStartedAt?: number;
  /** How many of the group's calls have come back. */
  done: number;
  /** Claude is stopped on a prompt the pane shows (see WorkingRow.waiting). */
  waiting?: boolean;
}

/** The rows a work group holds: its calls, and the thinking among them. */
export type WorkLeaf = ToolRow | ThinkingRow;

/**
 * One run of tool calls between two replies, drawn as one row: "Ran 3
 * commands, edited 2 files · 28s" (docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * The key is the run's first row's, prefixed, so it is the same while the turn
 * runs and after it settles: MessagesTimeline keys rows by `key`, and an open
 * group has to stay open, and the scroll pin still, as the run grows.
 */
export interface WorkGroupRow {
  kind: "work-group";
  key: string;
  turnKey: string;
  calls: WorkLeaf[];
  /** First call's start to the last result, when both carry a time. */
  durationMs?: number;
  /** At least one call failed. */
  hasError: boolean;
  /** The turn was interrupted while this group ran. */
  stopped: boolean;
  /** Every call's pictures, in call order. */
  pictures: WorkPicture[];
  /** Set on the group still running at the end of an open turn. */
  live?: WorkGroupLive;
}
export interface WorkingRow {
  kind: "working";
  key: string;
  turnKey: string;
  startedAt?: number;
  /** The call currently in flight, if the turn is inside one. */
  tool?: string;
  toolLabel?: string;
  toolItemType?: ItemType;
  toolDetail?: string;
  /** When the thing this row is about began: the call in flight, or the wait. */
  toolStartedAt?: number;
  /**
   * The turn is open but Claude is stopped, waiting for the reader: a question
   * with no answer, a plan with no verdict, a permission request with no
   * decision. The turn is genuinely unfinished — answering resumes it — so the
   * row stays; what it says is that nothing is running.
   */
  waiting?: boolean;
  /** How much has happened in this turn so far. */
  steps: number;
}

/** Rows that can be hidden inside a fold (everything except fold/working). */
export type LeafRow =
  | UserRow
  | MessageRow
  | ThinkingRow
  | ToolRow
  | TodoRow
  | QuestionRow
  | PlanRow
  | PermissionRow
  | ErrorRow
  | StatusRow
  | MetaRow;
/** What a turn's fold can hide: its leaf rows and its work groups. */
export type FoldedRow = LeafRow | WorkGroupRow;
export type TimelineRow = LeafRow | WorkGroupRow | TurnFoldRow | WorkingRow | ContinuationRow;

interface Turn {
  key: string;
  events: Event[];
  ended: boolean;
  usage?: TokenUsage;
}

function groupTurns(events: Event[]): Turn[] {
  const turns: Turn[] = [];
  const byKey = new Map<string, Turn>();
  let synthetic = 0;
  let currentKey: string | null = null;

  for (const e of events) {
    let key: string;
    if (e.turnId) {
      key = e.turnId;
    } else if (e.kind === "user" || currentKey === null) {
      synthetic += 1;
      key = `s${synthetic}`;
    } else {
      key = currentKey;
    }
    currentKey = key;

    let t = byKey.get(key);
    if (!t) {
      t = { key, events: [], ended: false };
      byKey.set(key, t);
      turns.push(t);
    }
    t.events.push(e);
    if (e.kind === "turn_end") {
      t.ended = true;
      if (e.usage) t.usage = e.usage;
    }
  }

  // A turn is implicitly settled once a later turn has started.
  turns.forEach((t, i) => {
    if (i < turns.length - 1) t.ended = true;
  });
  return turns;
}

/** A leaf row that stands for something that went wrong. */
function leafFailed(row: LeafRow): boolean {
  return (
    row.kind === "error" ||
    (row.kind === "tool" && row.isError && !declinedCall(row)) ||
    (row.kind === "meta" && row.meta === "hook-error")
  );
}

/** What the CLI writes as the result of a call the reader said no to, on the
 *  permission prompt or with "Type your own answer" (CLI 2.1.283). */
const DECLINED_RESULT = "The user doesn't want to proceed with this tool use";

/**
 * Whether the reader said no to this call on its permission prompt. The CLI
 * records it as an error result, but nothing failed: the reader chose, and a
 * work group says "declined" rather than turning red.
 */
export function declinedCall(call: ToolRow): boolean {
  return call.done && call.isError && (call.result ?? "").trimStart().startsWith(DECLINED_RESULT);
}

/** What precedes the reader's words in a No that came with some (CLI 2.1.283),
 *  a plan's "Tell Claude what to change" included. */
const USER_SAID = "To tell you how to proceed, the user said:";

/**
 * The words a declined call carries, when the reader said no to it with the
 * permission card's "Type your own answer". "" for a No without words and for
 * any other call.
 */
function declineWords(call: ToolRow): string {
  if (!declinedCall(call)) return "";
  const result = call.result ?? "";
  const at = result.indexOf(USER_SAID);
  return at < 0 ? "" : result.slice(at + USER_SAID.length).trim();
}

/** What the CLI's rejection says when no words came with it (CLI 2.1.283). */
const STOPPED_TAIL = "STOP what you are doing";

/**
 * Whether the call was stopped rather than declined with words: a Stop that
 * interrupted it, or a plain No on its permission prompt. The CLI writes the
 * same rejection for both, telling Claude to "STOP what you are doing", and
 * ends the turn with its interrupt notice, so the two cannot be told apart.
 * A No with words ("To tell you how to proceed, the user said: …") lets
 * Claude carry on, and stays declined. Found in the round 7 check
 * (2026-09-28): a command a Stop interrupted read "Declined 1 command".
 */
export function stoppedCall(call: ToolRow): boolean {
  return declinedCall(call) && (call.result ?? "").includes(STOPPED_TAIL);
}

/**
 * How long a turn worked: its first event to its last `turn_end`. Anything after the
 * end is left out, since a local command typed once the turn settled (/context
 * writes into the transcript with no turn of its own) joins the turn before it,
 * and it stretched "Worked for" to the minute the command ran (found live on
 * 2026-09-27).
 */
function turnDuration(turn: Turn): number | undefined {
  let end = -1;
  turn.events.forEach((e, i) => {
    if (e.kind === "turn_end") end = i;
  });
  const ats = (end >= 0 ? turn.events.slice(0, end + 1) : turn.events)
    .map((e) => e.at)
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (ats.length < 2) return undefined;
  const first = ats[0]!;
  const last = ats[ats.length - 1]!;
  const d = last - first;
  return d > 0 ? d : undefined;
}

/**
 * The answers an AskUserQuestion result records, one per question in order.
 *
 * The CLI keys them by the question's text (`{"Which fruits do you want?":
 * "Apple, Plum"}`, seen on 2026-09-27); a header key is read too. An array is
 * taken in question order. [] when nothing was recorded.
 */
function answersFrom(payload: unknown, questions: readonly Question[]): string[] {
  const raw = (payload as { answers?: unknown } | null)?.answers;
  if (!raw || typeof raw !== "object") return [];
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const out = Array.isArray(raw)
    ? questions.map((_, i) => text(raw[i]))
    : questions.map((q) => {
        const byKey = raw as Record<string, unknown>;
        return text(byKey[q.question]) || text(byKey[q.header]);
      });
  return out.some((a) => a !== "") ? out : [];
}

/**
 * The words a declined question carries, when the reader declined it through
 * the card's "Chat about this": session-events' hold denies the call with a
 * message saying so (session-events/hold.go chatMessage), and the CLI records
 * it as an error result with no answers. "" when the reader sent no words,
 * undefined for any other result. Deployed review round 1 of the T3 pass
 * (2026-09-29): the words reached Claude and the record showed only the
 * options, so Claude's next reply seemed to answer nothing.
 */
function chatReply(body: string): string | undefined {
  const words = /The user chose not to pick an answer and replied instead: ([\s\S]*)$/.exec(body);
  if (words) return words[1]!.trim();
  if (body.includes("The user chose not to answer these questions and wants to talk about them")) {
    return "";
  }
  return undefined;
}

/**
 * Whether `label` is among the picks an answer to `q` records. A label is
 * picked when it is the whole answer. A multi-select's picks are joined by
 * ", ", so there it is also picked when the answer is nothing but option
 * labels joined that way and it is one of them. Words typed through "Type
 * your own answer" are recorded the same way as picks, so "Tabs, but sticky
 * on scroll" is free text, not a pick of Tabs: a part that is no label says
 * so (deployed review round 3 of the T3 pass, 2026-09-29).
 */
export function pickedIn(answer: string | undefined, label: string, q: Question): boolean {
  if (!answer) return false;
  if (answer === label) return true;
  if (!q.multiSelect) return false;
  const parts = answer.split(", ");
  const labels = new Set(q.options.map((o) => o.label));
  return parts.includes(label) && parts.every((p) => labels.has(p));
}

/** A plan's text as the dialog draws it, tracked while the call is open. */
interface PlanText {
  /** The plan file the call names (`input.planFilePath`), or "". */
  path: string;
  text: string;
  /** A write to the plan file could not be replayed onto `text`. */
  stale: boolean;
}

/** What precedes the reader's words in a plan sent back with feedback. */
const PLAN_FEEDBACK = USER_SAID;

/**
 * Set a plan row's outcome and body from the tool_result that resolves it.
 *
 * The error flag decides between approved and not: every refusal measured
 * carries it, and an approval never does, so a non-error result counts as an
 * approval even if the CLI rewords "User has approved your plan". Among the
 * errors, the feedback marker tells "sent back" from a bare rejection (Esc, an
 * empty feedback row, or the old transcript's side of a clear context).
 */
function resolvePlan(row: PlanRow, e: Event, text: PlanText | undefined): void {
  const fallback = text?.text ?? row.body;
  if (!e.isError) {
    const approved = (e.result as { plan?: unknown } | null | undefined)?.plan;
    // The structured result is dropped whole past sessionio's MaxInlineResult
    // (8 KiB), and the text then falls back to what the dialog showed.
    row.outcome = { kind: "approved" };
    if (typeof approved === "string") {
      // What the approval carried is exact, whatever the input said.
      row.body = approved;
      delete row.stale;
    } else {
      row.body = fallback;
    }
    return;
  }
  row.body = fallback;
  const said = [e.body, typeof e.result === "string" ? e.result : undefined].find(
    (t): t is string => typeof t === "string" && t.includes(PLAN_FEEDBACK),
  );
  row.outcome =
    said !== undefined
      ? {
          kind: "sent-back",
          feedback: said.slice(said.indexOf(PLAN_FEEDBACK) + PLAN_FEEDBACK.length).trim(),
        }
      : { kind: "rejected" };
}

/**
 * Replay a Write or Edit of an open plan's file onto its text.
 *
 * Measured once (plan-probe runE, 2026-09-24): when Claude writes the plan
 * file and calls ExitPlanMode in the same message, the call's input holds the
 * old file, while the dialog draws and the approval carries the new one. The
 * transcript shows it as a write to the plan path whose result lands after the
 * call, which is the only time this runs: the plan row is still open. A Write
 * is replayed exactly. An Edit is applied when its old text occurs once (or
 * at all, for replace_all); otherwise the row keeps what it has and is marked
 * stale, so the card can say the Terminal holds the current version.
 */
function replayPlanWrite(row: PlanRow, call: ToolRow, text: PlanText | undefined): void {
  if (!text?.path || (call.tool !== "Write" && call.tool !== "Edit")) return;
  const input = parseJSON(call.input) as {
    file_path?: unknown;
    content?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    replace_all?: unknown;
  } | null;
  if (input?.file_path !== text.path) return;
  if (call.tool === "Write") {
    if (typeof input.content !== "string") return;
    text.text = input.content;
    text.stale = false;
  } else {
    const from = input.old_string;
    const to = input.new_string;
    if (typeof from !== "string" || typeof to !== "string" || from === "") {
      text.stale = true;
    } else {
      const count = text.text.split(from).length - 1;
      if (count === 1) text.text = text.text.replace(from, () => to);
      else if (count > 1 && input.replace_all === true) text.text = text.text.split(from).join(to);
      else text.stale = true;
    }
  }
  row.body = text.text;
  if (text.stale) row.stale = true;
  else delete row.stale;
}

/** What precedes the reader's feedback at the end of that record's text. */
const CONTINUATION_FEEDBACK = "User feedback on this plan:";

/**
 * The continuation row for a user event sessionio marked as the record a clear
 * context opens with, or null for any other user event.
 *
 * The feedback is read from the text, because the record carries it nowhere
 * else. The CLI (2.1.283's template) writes the lead, the plan, the old
 * transcript's path, a line about teammates, and then, only when the approval
 * carried feedback, "User feedback on this plan: " and the feedback, last. So
 * the search starts after the plan: a plan that mentions the phrase is not
 * feedback.
 */
function continuationRow(e: Event, turnKey: string): ContinuationRow | null {
  const plan = e.plan;
  if (e.origin !== ORIGIN_AUTO_CONTINUATION || typeof plan !== "string" || plan === "") {
    return null;
  }
  const body = e.body ?? "";
  const planAt = body.indexOf(plan);
  const from = planAt >= 0 ? planAt + plan.length : 0;
  const markAt = body.indexOf(CONTINUATION_FEEDBACK, from);
  const feedback = markAt >= 0 ? body.slice(markAt + CONTINUATION_FEEDBACK.length).trim() : "";
  return {
    kind: "continuation",
    key: `continuation-${e.id}`,
    id: e.id,
    plan: {
      kind: "plan",
      key: `plan-continuation-${e.id}`,
      id: e.id,
      body: plan,
      pending: false,
      outcome: { kind: "continuation" },
      turnKey,
      ...(e.at !== undefined ? { at: e.at } : {}),
    },
    feedback,
    turnKey,
    ...(e.at !== undefined ? { at: e.at } : {}),
  };
}

/** A string field of a JSON object held as text or as a value, "" otherwise. */
function stringField(v: unknown, key: string): string {
  const o = typeof v === "string" ? parseJSON(v) : v;
  const f = o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
  return typeof f === "string" ? f : "";
}

/**
 * Which call each subagent's work belongs to: agent id to the tool id of the
 * call that spawned it.
 *
 * Read over the whole turn before any row is placed, so two agents running at
 * once land under their own calls whichever of them wrote first. Three signals,
 * strongest first. A call's structured result names the agent it started
 * (`agentId`, on every Agent result on this box). An agent's first record is
 * the prompt it was given, word for word the call's own `prompt` input. And
 * failing both, agents and the calls still unclaimed pair in the order they
 * appeared, which is what a single `host` variable could only ever get right
 * for one agent at a time.
 */
function subagentCalls(events: Event[]): Map<string, string> {
  const calls: { toolId: string; prompt: string; at: number }[] = [];
  const out = new Map<string, string>();
  const firsts: { agentId: string; event: Event; at: number }[] = [];
  const seen = new Set<string>();
  events.forEach((e, at) => {
    if (e.kind === "tool_use" && e.toolId) {
      if (describeTool(e.tool ?? "", e.body).type === "collab_agent_tool_call") {
        const prompt = stringField(e.body, "prompt");
        // A call that spawns nothing (ListAgents, say, which also reads as
        // agent work) has no agent of its own to claim.
        if (prompt || e.tool === "Agent" || e.tool === "Task") {
          calls.push({ toolId: e.toolId, prompt, at });
        }
      }
    }
    if (e.kind === "tool_result" && e.toolId) {
      const started = stringField(e.result, "agentId");
      if (started) out.set(started, e.toolId);
    }
    if (e.sidechain && e.agentId && !seen.has(e.agentId)) {
      seen.add(e.agentId);
      firsts.push({ agentId: e.agentId, event: e, at });
    }
  });
  const claimed = new Set(out.values());
  for (const a of firsts) {
    if (out.has(a.agentId)) continue;
    const open = calls.filter((c) => c.at < a.at && !claimed.has(c.toolId));
    const body = a.event.kind === "user" ? (a.event.body ?? "") : "";
    const call = (body ? open.find((c) => c.prompt === body) : undefined) ?? open[0];
    if (!call) continue;
    out.set(a.agentId, call.toolId);
    claimed.add(call.toolId);
  }
  return out;
}

/**
 * Fold one turn's events into its rows: the user's message, and the work that
 * followed it. Every accumulator here is scoped to the turn, so they are locals
 * rather than state deriveRows has to carry.
 */
function collectTurnRows(turn: Turn): {
  userRow: UserRow | ContinuationRow | null;
  work: LeafRow[];
} {
  let userRow: UserRow | ContinuationRow | null = null;
  const work: LeafRow[] = [];
  const toolBy = new Map<string, ToolRow>();
  // Which call each subagent's work belongs to, by agent id (see above).
  const callOf = subagentCalls(turn.events);
  // Sidechain work that names no agent goes under the newest subagent call
  // still waiting on its result, the only rule there is for it.
  let lastHost: ToolRow | null = null;
  let lastTodo: TodoRow | null = null;
  // Rows awaiting the tool_result that resolves them, by tool_use_id. Local
  // to the turn: deriveRows runs on every event and must be pure, so nothing
  // here may outlive one derivation.
  const pendingByTool = new Map<string, QuestionRow | PlanRow>();
  // Each plan's text as the dialog shows it, which a Write or Edit to the plan
  // file can change after the call (see replayPlanWrite).
  const planText = new Map<PlanRow, PlanText>();
  // The approved plan still waiting for the permission-mode record that says
  // which mode the approval chose.
  let awaitingMode: PlanRow | null = null;
  // Skill calls of this turn, by the skill they named, so the `meta:skill`
  // that follows can fold its size onto the call rather than adding a second
  // row for the same load.
  const skillCalls = new Map<string, ToolRow>();

  /** The subagent call a sidechain event's row belongs under, if any. */
  const hostOf = (e: Event): ToolRow | null => {
    if (!e.sidechain) return null;
    if (!e.agentId) return lastHost;
    const call = callOf.get(e.agentId);
    return (call && toolBy.get(call)) || null;
  };
  /** Push a row into the turn, or into the subagent that spawned it. */
  const add = (row: LeafRow, e: Event) => {
    const host = hostOf(e);
    if (host) host.children.push(row);
    else work.push(row);
  };

  for (const e of turn.events) {
    switch (e.kind) {
      case "user": {
        // The model sheet's own keystrokes: its receipt says what changed.
        if (!e.sidechain && isPickerCommand(e.body ?? "")) break;
        // The record a clear context opens with is drawn as the continuation,
        // in the turn's user-row slot. A subagent's prompt never is.
        const cont = e.sidechain ? null : continuationRow(e, turn.key);
        if (cont) {
          userRow = cont;
          break;
        }
        const row: UserRow = {
          kind: "user",
          key: `user-${e.id}`,
          id: e.id,
          body: unwrapPasted(e.body ?? ""),
          turnKey: turn.key,
          ...(e.at !== undefined ? { at: e.at } : {}),
          ...(e.images?.length ? { images: e.images } : {}),
          ...(e.images?.length && e.record ? { record: e.record } : {}),
          ...(e.sending ? { sending: true as const } : {}),
        };
        // A subagent's prompt is its own first row, never the turn's.
        if (e.sidechain) add(row, e);
        else userRow = row;
        break;
      }
      case "text":
        add(
          {
            kind: "message",
            key: `msg-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          },
          e,
        );
        break;
      case "thinking":
        add(
          {
            kind: "thinking",
            key: `think-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          },
          e,
        );
        break;
      case "tool_use": {
        const d: Described = describeTool(e.tool ?? "", e.body);
        // TodoWrite is a checklist, not a call: one row per turn, updated in
        // place, so a turn that revises its list six times shows one list.
        if (d.type === "todo") {
          const steps = extractTodoSteps(parseJSON(e.body)) ?? [];
          if (lastTodo) {
            lastTodo.steps = steps;
            lastTodo.id = e.id;
          } else {
            lastTodo = {
              kind: "todo",
              key: `todo-${turn.key}`,
              id: e.id,
              steps,
              turnKey: turn.key,
              ...(e.at !== undefined ? { at: e.at } : {}),
            };
            add(lastTodo, e);
          }
          break;
        }
        if (d.type === "question") {
          const row: QuestionRow = {
            kind: "question",
            key: `q-${e.toolId || e.id}`,
            id: e.id,
            questions: questions(parseJSON(e.body)),
            answers: [],
            pending: true,
            turnKey: turn.key,
            ...(e.toolId !== undefined ? { toolId: e.toolId } : {}),
            ...(e.at !== undefined ? { at: e.at } : {}),
          };
          if (e.toolId) pendingByTool.set(e.toolId, row);
          add(row, e);
          break;
        }
        if (d.type === "plan") {
          const plan = parseJSON(e.body) as { plan?: unknown; planFilePath?: unknown } | null;
          const text = typeof plan?.plan === "string" ? plan.plan : (e.body ?? "");
          const row: PlanRow = {
            kind: "plan",
            key: `plan-${e.toolId || e.id}`,
            id: e.id,
            ...(e.toolId ? { toolId: e.toolId } : {}),
            body: text,
            pending: true,
            outcome: { kind: "pending" },
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          };
          planText.set(row, {
            path: typeof plan?.planFilePath === "string" ? plan.planFilePath : "",
            text,
            stale: false,
          });
          if (e.toolId) pendingByTool.set(e.toolId, row);
          add(row, e);
          break;
        }
        const row: ToolRow = {
          kind: "tool",
          key: `tool-${e.toolId || e.id}`,
          id: e.id,
          tool: e.tool ?? "",
          itemType: d.type,
          label: d.label,
          detail: d.detail,
          changedFiles: d.changedFiles,
          input: e.body ?? "",
          isError: false,
          done: false,
          truncated: false,
          children: [],
          turnKey: turn.key,
          ...(e.toolId !== undefined ? { toolId: e.toolId } : {}),
          ...(e.at !== undefined ? { at: e.at } : {}),
        };
        if (e.toolId) toolBy.set(e.toolId, row);
        // The load that follows folds its size onto this call (see the
        // `meta` case). Keyed on the skill's name, which `describe` put in
        // the label, so the two find each other across the tool result the
        // receipt arrived on.
        if (d.type === "skill" && d.label) skillCalls.set(d.label, row);
        // A subagent's own work arrives as sidechain records AFTER the call
        // that spawned it, so the call becomes the host for what follows.
        if (d.type === "collab_agent_tool_call") lastHost = row;
        add(row, e);
        break;
      }
      case "tool_result": {
        const waiting = e.toolId ? pendingByTool.get(e.toolId) : undefined;
        if (waiting) {
          waiting.pending = false;
          if (waiting.kind === "question") {
            waiting.answers = answersFrom(e.result, waiting.questions);
            const replied = e.isError ? chatReply(e.body ?? "") : undefined;
            if (replied !== undefined) waiting.replied = replied;
          } else {
            resolvePlan(waiting, e, planText.get(waiting));
            if (waiting.outcome.kind === "approved") awaitingMode = waiting;
          }
          pendingByTool.delete(e.toolId!);
          // A subagent's result closes its host.
          break;
        }
        const existing = e.toolId ? toolBy.get(e.toolId) : undefined;
        if (existing) {
          existing.result = e.body ?? "";
          existing.payload = e.result;
          existing.isError = !!e.isError;
          existing.done = true;
          if (e.at !== undefined) existing.doneAt = e.at;
          existing.truncated = !!e.truncated;
          if (e.images?.length) existing.images = e.images;
          if (e.files?.length) existing.files = e.files;
          if (!existing.isError) {
            for (const open of pendingByTool.values()) {
              if (open.kind === "plan") replayPlanWrite(open, existing, planText.get(open));
            }
          }
          if (existing.itemType === "collab_agent_tool_call" && lastHost === existing) {
            lastHost = null;
          }
          // A No with words: the words are the reader's own message, so they
          // go in the conversation where they were said, after the call they
          // declined. Deployed review round 2 of the T3 pass (2026-09-29):
          // Claude did what they said and wrote "as you asked", and the words
          // showed nowhere; the plan's and the question's own answers did.
          const said = declineWords(existing);
          if (said) {
            add(
              {
                kind: "permission",
                key: `said-${existing.key}`,
                id: e.id,
                reqId: "",
                tool: existing.tool,
                input: "",
                decision: "deny",
                said,
                turnKey: turn.key,
                ...(e.at !== undefined ? { at: e.at } : {}),
              },
              e,
            );
          }
        } else {
          add(
            {
              kind: "tool",
              key: `tool-${e.toolId || e.id}`,
              id: e.id,
              tool: "",
              itemType: "dynamic_tool_call",
              label: "",
              detail: "",
              changedFiles: [],
              input: "",
              result: e.body ?? "",
              payload: e.result,
              isError: !!e.isError,
              done: true,
              truncated: !!e.truncated,
              children: [],
              turnKey: turn.key,
              ...(e.toolId !== undefined ? { toolId: e.toolId } : {}),
              ...(e.at !== undefined ? { at: e.at, doneAt: e.at } : {}),
              ...(e.images?.length ? { images: e.images } : {}),
              ...(e.files?.length ? { files: e.files } : {}),
            },
            e,
          );
        }
        break;
      }
      case "meta": {
        const meta = e.meta ?? "mode";
        // `mode` and `permission-mode` are STATE, not events: the composer's
        // model sheet always shows the mode in force, so a divider announcing
        // each change interrupts the conversation to repeat what is already on
        // screen (Viktor, 2026-08-17). The EVENTS still flow, since
        // currentMode() reads them for that sheet; only the row is dropped, and dropped
        // outright rather than folded, since expanding a turn would put the
        // divider back.
        //
        // A permission-mode record still has one job here: the first one after
        // an approval names the mode the approval chose. "plan" is skipped,
        // since approving a plan always leaves plan mode.
        if (meta === "permission-mode" && awaitingMode && e.body && e.body !== "plan") {
          awaitingMode.outcome = { kind: "approved", mode: e.body };
          awaitingMode = null;
        }
        if (meta === "mode" || meta === "permission-mode") break;
        // A `/context` reading is state for the same reason, and the model
        // sheet's context line is where it shows. A reading also arrives as a
        // 15 KB block of markdown the CLI already rendered in the pane, so a
        // row per reading would be the biggest thing in the log.
        if (meta === "context") break;
        // Which model is answering is state as well, and the composer's
        // model button is where it shows. A change made from the lobby leaves its
        // own visible mark anyway: applying one types `/model` into the pane,
        // and that line arrives as an ordinary row.
        if (meta === "model") break;
        // A command the CLI answered itself (Claude Code 2.1.283 writes /context
        // as a local_command record). Its effect already shows where it lands,
        // the sheet's context line for /context, and the event exists so the store can
        // let go of the command's pending bubble.
        if (meta === "command") break;
        // A prompt a Stop took back: its bubble is gone (withoutRewound), and
        // a marker saying so would put it back in other words.
        if (meta === "rewound") break;
        // Where a prompt's pictures came from, for the composer's history
        // (promptHistory). The bubble already draws them.
        if (meta === "picture-source") break;
        // The queue's departures are bookkeeping for queuedPrompts(), the
        // same way the mode events are for the sheet: a divider saying a
        // prompt left the queue tells the reader nothing the queue itself
        // does not already say by shrinking.
        if (meta === "unqueued" || meta === "dequeued" || meta === "queue-cleared") break;
        // What the PANE says about a blocking dialog is state too, and its
        // card is where it shows (planFromPane, permissionFromPane). It is the one
        // reading that repeats: a dialog sits on screen for as long as nobody
        // answers it, and a row per reading would bury the conversation.
        if (meta === "asking") break;
        // The question the lobby's hook is holding is state as well: the
        // question card is where it shows (heldFromEvents).
        if (meta === "held") break;
        // A background task finishing is delivered THROUGH the queue, so the
        // queue reports enqueueing a wall of XML — 2,140 of them across this
        // box's transcripts, the single most common artifact in the text view
        // (measured 2026-09-02). queuedPrompts() already keeps them out of
        // the queue list for the same reason; this keeps them out of the
        // transcript. Nothing is lost: the notification also arrives as its
        // own record, which renders as one muted line (415 of the 419
        // measured), and the event still flows so the queue list stays in
        // step.
        if (meta === "queued" && isHarnessNotice(e.body ?? "")) break;
        // A REAL queued prompt earns no row either, since 2026-09-24. The
        // timeline draws what waits in the queue as ghost bubbles after its
        // last row (MessagesTimeline, off queuedPrompts), and the prompt
        // arrives as its own user row the moment Claude takes it, so a marker
        // here was a third copy of one message, the first thing on screen to
        // say it twice. A prompt taken out of the queue unsent now leaves no
        // trace, which is what happened to it.
        if (meta === "queued") break;
        // A skill load is TWO records: the `Skill` call, and the SKILL.md
        // body sessionio collapsed to this event. One thing happened, so it
        // reads as one card — the size lands on the call and this row is
        // dropped. Matched by name rather than by position, because the
        // receipt the load was detected from arrives on the call's own tool
        // result and anything may sit between them.
        //
        // Unmatched, the row stays: a body detected by its `Base directory`
        // marker with no Skill call before it is still a load, and dropping
        // it would lose the only trace of one.
        if (meta === "skill") {
          const call = skillCalls.get(e.body ?? "");
          if (call && call.bytes === undefined) {
            call.bytes = e.bytes ?? 0;
            break;
          }
        }
        add(
          {
            kind: "meta",
            key: `meta-${e.id}`,
            id: e.id,
            meta,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          },
          e,
        );
        break;
      }
      case "permission_request":
        work.push({
          kind: "permission",
          key: `perm-${e.reqId || e.id}`,
          id: e.id,
          reqId: e.reqId ?? "",
          tool: e.tool ?? "",
          input: e.body ?? "",
          turnKey: turn.key,
          ...(e.at !== undefined ? { at: e.at } : {}),
        });
        break;
      case "permission_resolved": {
        const pr = work.find(
          (r): r is PermissionRow => r.kind === "permission" && r.reqId === e.reqId,
        );
        if (pr) {
          pr.decision = e.body ?? "";
        } else {
          work.push({
            kind: "permission",
            key: `perm-${e.reqId || e.id}`,
            id: e.id,
            reqId: e.reqId ?? "",
            tool: e.tool ?? "",
            input: "",
            decision: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          });
        }
        break;
      }
      case "error":
        add(
          {
            kind: "error",
            key: `err-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          },
          e,
        );
        break;
      case "session":
      case "state":
      case "result":
        work.push({
          kind: "status",
          key: `status-${e.id}`,
          id: e.id,
          body: e.body ?? "",
          subtype: e.kind,
          turnKey: turn.key,
          ...(e.at !== undefined ? { at: e.at } : {}),
        });
        break;
      case "turn_end":
        break;
    }
  }

  return { userRow, work };
}

/** A leaf the fold hides, or a work group holding some: did anything fail? */
function foldedFailed(row: FoldedRow): boolean {
  return row.kind === "work-group" ? row.hasError : leafFailed(row);
}

/** How many steps a folded row stands for: a work group counts its rows. */
/** Rows a finished turn's fold leaves in view (see foldSettledTurn). */
function staysOutOfFold(row: FoldedRow): boolean {
  if (row.kind === "question") return !row.pending;
  if (row.kind === "permission") return row.said !== undefined;
  return row.kind === "plan" || row.kind === "status";
}

function foldedSteps(row: FoldedRow): number {
  return row.kind === "work-group" ? row.calls.length : 1;
}

/**
 * The rows a turn contributes below its user message. A settled turn with more
 * than one work row folds to its last reply; anything else hands back the work
 * as it stands. The fold hides replies and work groups in order (Viktor,
 * 2026-09-27: "a finished turn still folds to its last reply").
 */
function foldSettledTurn(turn: Turn, all: FoldedRow[], settled: boolean): TimelineRow[] {
  const rows: TimelineRow[] = [];
  // A turn the reader stopped ends on the CLI's interrupt notice. It stays out
  // of the fold, after it, where it says the turn was stopped rather than
  // standing in for the answer the turn never gave.
  const stop = settled && isInterrupt(all[all.length - 1]) ? all[all.length - 1] : undefined;
  const work = stop ? all.slice(0, -1) : all;
  if (settled && work.length > 1) {
    // Keep the last assistant message visible (the turn's "answer"); fold the
    // rest behind a "Worked for Ns" row. Fall back to the last work row when
    // the turn produced no assistant text.
    let visibleAt = -1;
    for (let i = work.length - 1; i >= 0; i--) {
      if (work[i]!.kind === "message") {
        visibleAt = i;
        break;
      }
    }
    if (visibleAt < 0) visibleAt = work.length - 1;
    // What stays in view besides the answer: the conversation rather than
    // Claude's work. An answered question names the question and shows the
    // reader's answer, a plan shows what was approved, and a status line is
    // already one quiet line; folded, each read "1 step" (deployed review
    // rounds 3 to 5, 2026-09-28).
    const kept = (r: FoldedRow, i: number): boolean => i === visibleAt || staysOutOfFold(r);
    const hidden = work.filter((r, i) => !kept(r, i));
    // One work group and the reply: the group's own row already stands for
    // the calls, folded, and a fold over it drew them twice (deployed review
    // round 1, 2026-09-28).
    if (hidden.length === 1 && hidden[0]!.kind === "work-group") {
      for (const r of all) rows.push(r);
      return rows;
    }
    const changed = [...new Set(work.flatMap(changedFilesOf))];
    const duration = turnDuration(turn);
    // Deployed review round 1 of the T3 pass (2026-09-29): opened, a plan
    // approved between two work groups read as coming after both.
    const firstHidden = work.findIndex((r, i) => !kept(r, i));
    let lastHidden = -1;
    work.forEach((r, i) => {
      if (!kept(r, i)) lastHidden = i;
    });
    const span = firstHidden >= 0 ? work.slice(firstHidden, lastHidden + 1) : [];
    const fold: TurnFoldRow | null =
      hidden.length > 0
        ? {
            kind: "turn-fold",
            key: `fold-${turn.key}`,
            turnKey: turn.key,
            count: hidden.reduce((n, r) => n + foldedSteps(r), 0),
            summary: foldSummary(hidden),
            hidden,
            hasError: hidden.some(foldedFailed),
            stopped: stop !== undefined || hidden.some((r) => r.kind === "work-group" && r.stopped),
            changedFiles: changed,
            pictures: hidden.flatMap((r) => (r.kind === "work-group" ? r.pictures : [])),
            ...(span.length > hidden.length ? { opened: span } : {}),
            ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
            ...(duration !== undefined ? { durationMs: duration } : {}),
          }
        : null;
    // Chronology: the fold stands in where its first hidden row was, and what
    // stays in view keeps its place around it. A turn whose last item is a
    // tool call keeps the message that ANNOUNCED the call above the fold
    // holding it.
    let placed = false;
    work.forEach((r, i) => {
      if (kept(r, i)) rows.push(r);
      else if (fold && !placed) {
        rows.push(fold);
        placed = true;
      }
    });
    if (stop) rows.push(stop);
  } else {
    for (const r of all) rows.push(r);
  }
  return rows;
}

/**
 * What a fold hides, in the work group's words: the calls summed up as one
 * group would say them, then the replies ("Ran 2 commands, edited 1 file,
 * wrote 2 replies"). It replaced "Worked for Ns · N steps" and a token count,
 * which the prototype does not draw (deployed review round 1, 2026-09-28).
 */
function foldSummary(hidden: readonly FoldedRow[]): string {
  const calls = hidden.flatMap((r): WorkLeaf[] =>
    r.kind === "work-group" ? r.calls : r.kind === "tool" || r.kind === "thinking" ? [r] : [],
  );
  const replies = hidden.filter((r) => r.kind === "message").length;
  const parts: string[] = [];
  if (calls.some((c) => c.kind === "tool")) parts.push(groupSummary(calls));
  if (replies > 0) parts.push(`wrote ${plural(replies, "reply", "replies")}`);
  if (parts.length === 0) parts.push(plural(hidden.length, "step", "steps"));
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The files a row changed: a call's own, or every call's in a group. A call
 *  that came back as an error, a declined one included, changed nothing. */
function changedFilesOf(row: FoldedRow): string[] {
  const own = (c: ToolRow): string[] => (c.isError ? [] : c.changedFiles);
  if (row.kind === "tool") return own(row);
  if (row.kind === "work-group") {
    return row.calls.flatMap((c) => (c.kind === "tool" ? own(c) : []));
  }
  return [];
}

/** What opens the notice Claude writes when a turn is interrupted (sessionio record.go). */
const INTERRUPT_MARKER = "[Request interrupted by user";

/** The status row an interrupt leaves in the turn, or false for any other row. */
function isInterrupt(row: FoldedRow | undefined): boolean {
  return row?.kind === "status" && row.subtype === "state" && row.body.startsWith(INTERRUPT_MARKER);
}

/**
 * What a status row says. The interrupt notice is the CLI's own bracketed
 * line, "[Request interrupted by user for tool use]", which a reader should
 * not have to decode; it reads the way the prototype's note does.
 */
export function statusText(row: StatusRow): string {
  if (isInterrupt(row)) return "Stopped. Claude's turn ended.";
  return row.body || row.subtype;
}

/**
 * Gather each run of tool calls, with the thinking among them, into one work
 * group. A run of thinking with no call in it stays as it is: there is no work
 * to summarise. Every other row ends a run and keeps its own place.
 *
 * In an open turn the group the work ends on is the running one and gets
 * `live`; `waiting` says Claude is stopped on a prompt rather than working.
 */
function groupWork(
  work: LeafRow[],
  turnKey: string,
  settled: boolean,
  waiting: boolean,
): FoldedRow[] {
  const out: FoldedRow[] = [];
  let run: WorkLeaf[] = [];
  const flush = (next: LeafRow | undefined) => {
    if (run.length === 0) return;
    if (!run.some((r) => r.kind === "tool")) {
      out.push(...run);
    } else {
      out.push(workGroup(run, turnKey, settled, next));
    }
    run = [];
  };
  for (const r of work) {
    if (r.kind === "tool" || r.kind === "thinking") {
      run.push(r);
      continue;
    }
    flush(r);
    out.push(r);
  }
  flush(undefined);
  // The group still running is the one the open turn ends on.
  const last = out[out.length - 1];
  if (!settled && last?.kind === "work-group") {
    last.live = liveOf(last, waiting);
  }
  return out;
}

/** One work group from a run of rows, and the row that ended it (if any). */
function workGroup(
  run: WorkLeaf[],
  turnKey: string,
  settled: boolean,
  next: LeafRow | undefined,
): WorkGroupRow {
  const calls = run.filter((r): r is ToolRow => r.kind === "tool");
  // Stopped: the interrupt notice is the row that ended the run, or the turn
  // settled with a call that never came back (an interrupt before Claude's
  // first token writes no notice at all).
  const stopped = isInterrupt(next) || (settled && calls.some((c) => !c.done));
  const start = calls[0]!.at;
  let end: number | undefined;
  for (const c of calls) {
    if (c.doneAt !== undefined && (end === undefined || c.doneAt > end)) end = c.doneAt;
  }
  if (stopped && next?.at !== undefined && (end === undefined || next.at > end)) end = next.at;
  const duration =
    start !== undefined && end !== undefined && end > start ? end - start : undefined;
  return {
    kind: "work-group",
    key: `group-${run[0]!.key}`,
    turnKey,
    calls: run,
    hasError: calls.some((c) => c.isError && !declinedCall(c)),
    stopped,
    pictures: calls.flatMap(picturesOf),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };
}

/** A call's pictures, image blocks first and then the files it wrote. */
function picturesOf(call: ToolRow): WorkPicture[] {
  const out: WorkPicture[] = [];
  const toolId = call.toolId;
  // A block is read back by the call's id, so a call without one has no
  // route to its pictures.
  if (toolId) {
    const label = call.detail || call.label;
    for (const ref of call.images ?? []) out.push({ kind: "block", toolId, n: ref.n, label });
  }
  for (const path of call.files ?? []) out.push({ kind: "file", path });
  return out;
}

/** The running group's live state: the call in flight, and how far along it is. */
function liveOf(group: WorkGroupRow, waiting: boolean): WorkGroupLive {
  let current: ToolRow | undefined;
  let done = 0;
  for (const c of group.calls) {
    if (c.kind !== "tool") continue;
    if (c.done) done++;
    else current = c;
  }
  const startedAt = group.calls[0]!.at;
  return {
    ...(current
      ? {
          tool: current.tool,
          label: current.label,
          itemType: current.itemType,
          ...(current.detail ? { detail: current.detail } : {}),
        }
      : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(current?.at !== undefined ? { callStartedAt: current.at } : {}),
    done,
    ...(waiting ? { waiting: true } : {}),
  };
}

/** How a work group's summary counts a call. */
type Tally = "skill" | "command" | "edit" | "read" | "search" | "picture" | "tool" | "agent";

/** A path whose Read hands back a picture rather than text. */
const PICTURE_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;

/**
 * What a call counts as. Grep and Glob classify as file reads (canonicalize),
 * but three of them are three searches, not three files read.
 */
function tallyOf(call: ToolRow): Tally {
  switch (call.itemType) {
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_read":
      if (call.tool === "Grep" || call.tool === "Glob") return "search";
      // A Read of a picture is Claude looking at it: the result is the image.
      return call.images?.length || PICTURE_FILE_RE.test(call.detail) ? "picture" : "read";
    case "web_search":
      return "search";
    case "image_view":
      return "picture";
    case "collab_agent_tool_call":
      return "agent";
    case "skill":
      return "skill";
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "todo":
    case "question":
    case "plan":
      return "tool";
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a declined call is called, one and many. */
const DECLINED_NOUN: Record<Tally, [string, string]> = {
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  read: ["read", "reads"],
  search: ["search", "searches"],
  picture: ["picture", "pictures"],
  tool: ["tool call", "tool calls"],
  agent: ["agent", "agents"],
  skill: ["skill", "skills"],
};

/** What a call waiting on the reader is waiting to do. */
function waitingPhrase(t: Tally, n: number): string {
  switch (t) {
    case "command":
      return `run ${plural(n, "command", "commands")}`;
    case "edit":
      return `edit ${plural(n, "file", "files")}`;
    case "read":
      return `read ${plural(n, "file", "files")}`;
    case "search":
      return n === 1 ? "search" : `search ${n} times`;
    case "picture":
      return `view ${plural(n, "picture", "pictures")}`;
    case "tool":
      return `use ${plural(n, "tool", "tools")}`;
    case "agent":
      return `run ${plural(n, "agent", "agents")}`;
    case "skill":
      return `load ${plural(n, "skill", "skills")}`;
  }
}

/**
 * A work group's one-line summary: "Ran 3 commands, edited 2 files".
 *
 * One phrase per kind of call, in the order each kind first appears. Edits and
 * reads count FILES, since Claude reads a long file in pages and edits one
 * file in several places; everything else counts calls. Thinking says nothing.
 *
 * A call the reader declined is not counted as done: it goes in a "declined 1
 * edit" phrase after the rest, or "stopped 1 command" when a Stop or a plain
 * No ended the turn on it (`stoppedCall`). An edit that failed changed nothing and goes in
 * a "1 edit failed" phrase. With `waiting` (the turn is waiting on the
 * reader), a call with no result yet is the one the permission prompt asks
 * about, and goes in a "waiting to edit 1 file" phrase last, so a group never
 * says an edit landed before the reader allowed it (found live 2026-09-27).
 */
export function groupSummary(calls: readonly WorkLeaf[], opts: { waiting?: boolean } = {}): string {
  const order: Tally[] = [];
  const counts = new Map<Tally, number>();
  const files = new Map<Tally, Set<string>>();
  const skills: string[] = [];
  const declined = new Map<Tally, number>();
  const stopped = new Map<Tally, number>();
  const pending = new Map<Tally, number>();
  const failedEdits = new Map<Tally, number>();
  const bump = (m: Map<Tally, number>, t: Tally): void => {
    m.set(t, (m.get(t) ?? 0) + 1);
  };
  for (const c of calls) {
    if (c.kind !== "tool") continue;
    const t = tallyOf(c);
    if (declinedCall(c)) {
      bump(stoppedCall(c) ? stopped : declined, t);
      continue;
    }
    // An edit that came back as an error changed nothing, so it is not a
    // file edited. A command that failed still ran, and says so.
    if (t === "edit" && c.done && c.isError) {
      bump(failedEdits, t);
      continue;
    }
    if (opts.waiting && !c.done) {
      bump(pending, t);
      continue;
    }
    if (!counts.has(t)) order.push(t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (t === "edit" || t === "read") {
      const seen = files.get(t) ?? new Set<string>();
      const ids =
        t === "edit" && c.changedFiles.length > 0 ? c.changedFiles : [c.detail || c.label || c.key];
      for (const id of ids) seen.add(id);
      files.set(t, seen);
    }
    if (t === "skill" && c.label && !skills.includes(c.label)) skills.push(c.label);
  }
  const phrase = (t: Tally): string => {
    const n = counts.get(t) ?? 0;
    switch (t) {
      case "command":
        return `ran ${plural(n, "command", "commands")}`;
      case "edit":
        return `edited ${plural(files.get(t)?.size ?? n, "file", "files")}`;
      case "read":
        return `read ${plural(files.get(t)?.size ?? n, "file", "files")}`;
      case "search":
        return n === 1 ? "searched once" : `searched ${n} times`;
      case "picture":
        return `viewed ${plural(n, "picture", "pictures")}`;
      case "tool":
        return `used ${plural(n, "tool", "tools")}`;
      case "agent":
        return `ran ${plural(n, "agent", "agents")}`;
      case "skill":
        if (skills.length === 1) return `loaded ${skills[0]}`;
        if (skills.length === 2) return `loaded ${skills[0]} and ${skills[1]}`;
        return `loaded ${plural(skills.length || n, "skill", "skills")}`;
    }
  };
  const said = order.map(phrase);
  for (const [t, n] of stopped) {
    const [one, many] = DECLINED_NOUN[t];
    said.push(`stopped ${plural(n, one, many)}`);
  }
  for (const [t, n] of declined) {
    const [one, many] = DECLINED_NOUN[t];
    said.push(`declined ${plural(n, one, many)}`);
  }
  for (const n of failedEdits.values()) said.push(`${plural(n, "edit", "edits")} failed`);
  for (const [t, n] of pending) said.push(`waiting to ${waitingPhrase(t, n)}`);
  const text = said.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The single progress indicator a running turn gets. */
function workingRowFor(turn: Turn, work: LeafRow[]): WorkingRow {
  // A running turn gets ONE progress indicator: the working row below.
  //
  // The last message used to be marked `streaming` as well, which drew a
  // blinking cursor after it. That cursor said something untrue — Claude
  // Code writes one transcript record per COMPLETED block, so a message
  // that has arrived is finished and will never grow — and it said it
  // directly above the tool rows the message had just announced, blinking
  // there for the rest of the turn. The working row already reports the
  // turn honestly: the tool actually running, its elapsed time, the step
  // count (Viktor, 2026-08-28).
  //
  // What is happening RIGHT NOW: the newest thing in the turn that has not
  // come back yet. The transcript records a tool_use the moment Claude
  // emits it, so this is specific without any second source (design
  // decision 6).
  //
  // Not all of those are work. A question, a plan put up for approval and a
  // permission request are all Claude STOPPING and waiting for the reader,
  // and they leave the turn open in exactly the same way — the assistant
  // record carries stop_reason "tool_use" and the result is not written
  // until somebody answers. Replaying the 357 session transcripts on this
  // box on 2026-09-04 found 3,212 windows where the last turn was open and
  // the transcript then went quiet for a minute or more, 1,562 hours in
  // total, and 742 windows / 895 hours of that (57%) was one unanswered
  // AskUserQuestion. The row said "Working…" with a running clock through
  // all of it, which is the complaint (Viktor, 2026-09-04).
  let live: ToolRow | undefined;
  let waitingFor: QuestionRow | PlanRow | PermissionRow | undefined;
  for (let i = work.length - 1; i >= 0; i--) {
    const r = work[i]!;
    if (r.kind === "tool" && !r.done) {
      live = r;
      break;
    }
    if ((r.kind === "question" || r.kind === "plan") && r.pending) {
      waitingFor = r;
      break;
    }
    if (r.kind === "permission" && r.decision === undefined) {
      waitingFor = r;
      break;
    }
  }
  // The held question covers the window the transcript misses: Claude Code
  // does not always write the AskUserQuestion record while its dialog is up.
  // The question card already docks off it, so the row above it has to agree.
  const paneAsking = !live && !waitingFor && heldFromEvents(turn.events) !== null;
  // A tool permission prompt holds the call it is about in flight, so it
  // waits with `live` set: the call has not run, and will not until somebody
  // answers (permissionFromPane).
  const panePermission = permissionFromPane(turn.events) !== null;
  const anchor = waitingFor?.at ?? live?.at;
  return {
    kind: "working",
    key: `working-${turn.key}`,
    turnKey: turn.key,
    steps: work.length,
    ...(turn.events[0]?.at !== undefined ? { startedAt: turn.events[0]!.at } : {}),
    ...(live
      ? {
          tool: live.tool,
          toolLabel: live.label,
          toolItemType: live.itemType,
          ...(live.detail ? { toolDetail: live.detail } : {}),
        }
      : {}),
    ...(anchor !== undefined ? { toolStartedAt: anchor } : {}),
    ...(waitingFor || paneAsking || panePermission ? { waiting: true } : {}),
  };
}

/**
 * Derive the folded row list from a session's events (see module doc).
 *
 * `fold: false` leaves every settled turn's work in place, and `group: false`
 * leaves every call as its own row rather than gathering each run into a work
 * group. The drill-in reads an agent's own transcript with both off: an agent
 * is one long turn, and folding it behind "Worked for 4m" or "Ran 40 commands"
 * would hide exactly the work the reader opened it for.
 */
export function deriveRows(
  events: Event[],
  opts: { fold?: boolean; group?: boolean } = {},
): TimelineRow[] {
  const turns = groupTurns(withoutRewound(events));
  const out: TimelineRow[] = [];
  const fold = opts.fold !== false;
  const group = opts.group !== false;

  turns.forEach((turn, ti) => {
    const isLast = ti === turns.length - 1;
    const settled = turn.ended || !isLast;
    const { userRow, work } = collectTurnRows(turn);
    // A plan left without a result in a turn that has settled was never
    // answered: the session moved on without it.
    if (settled) for (const r of work) if (r.kind === "plan" && r.pending) supersedePlan(r);
    // The working row reads the calls one by one, so it is worked out before
    // they are gathered into groups.
    const working = settled ? null : workingRowFor(turn, work);
    const shaped = group ? groupWork(work, turn.key, settled, working?.waiting === true) : work;

    if (userRow) out.push(userRow);
    for (const r of foldSettledTurn(turn, shaped, settled && fold)) out.push(r);
    if (working) out.push(working);
  });

  markSuperseded(out);
  return out;
}

/**
 * The events without the prompts a Stop took back.
 *
 * A Stop that lands before Claude has written anything for the turn puts the
 * prompt back on Claude Code's input line, and its own view no longer shows it
 * (CLI 2.1.283, measured 2026-09-28). The transcript keeps the prompt's record,
 * so session-events marks it with a `rewound` meta naming the turn it opened,
 * and that turn's prompt is dropped here. Kept, it read as sent, and whatever
 * started the next turn read as its answer. Returns `events` itself when
 * nothing was taken back.
 *
 * The markers go too. A batch of queued prompts is one turn per prompt, and
 * the Stop ends only the last one's; a marker left in an earlier one's turn
 * kept that turn open with nothing else in it, and the view drew "Working…"
 * after the Stop (deployed review round 4, 2026-09-28).
 */
function withoutRewound(events: Event[]): Event[] {
  let taken: Set<string> | null = null;
  for (const e of events) {
    if (e.kind === "meta" && e.meta === "rewound" && e.turnId) (taken ??= new Set()).add(e.turnId);
  }
  if (!taken) return events;
  const gone = taken;
  return events.filter(
    (e) =>
      !(e.kind === "user" && !e.sidechain && e.turnId && gone.has(e.turnId)) &&
      !(e.kind === "meta" && e.meta === "rewound"),
  );
}

/**
 * Clear the pending flag on every question the session has moved past.
 *
 * A question is pending because the transcript holds no result for it, and that
 * stays true forever when the dialog is taken down without one — measured in a
 * real session on 2026-08-16, where a background agent's task-notification
 * arrived as a queued message, took the dialog down, and Claude re-asked. The
 * row would otherwise keep the live-dialog highlight for the rest of the
 * session, and the answer card would dock over it.
 *
 * `superseded` is the honest state for those: asked, never answered, no longer
 * being asked. Questions asked together are the exception (`liveQuestions`).
 */
function markSuperseded(out: TimelineRow[]): void {
  const newest = newestSubstantive(out);
  const live = liveQuestions(out);
  for (const r of out) {
    for (const row of r.kind === "turn-fold" ? r.hidden : [r]) {
      if (row.kind === "question" && row.pending && !live.includes(row)) {
        row.pending = false;
        row.superseded = true;
      }
      if (row.kind === "plan" && row.pending && row !== newest) supersedePlan(row);
    }
  }
}

function supersedePlan(row: PlanRow): void {
  row.pending = false;
  row.outcome = { kind: "superseded" };
}

/**
 * The outcome a plan row shows, given this client's own answer in flight.
 *
 * The caller holds the transient state, since only the client that answered
 * knows it answered. An approval or feedback shows until the transcript's
 * result lands. A clear context also covers the rejection the old transcript
 * records, since the approval that cleared it is carried out in a new one
 * (the caller drops the transient after 20 s, or when the stream switches).
 */
export function shownPlanOutcome(row: PlanRow, transient: PlanTransient | undefined): PlanOutcome {
  if (!transient) return row.outcome;
  const k = row.outcome.kind;
  const open = k === "pending" || k === "superseded";
  if (open || (transient === "clear" && k === "rejected"))
    return { kind: "transient", action: transient };
  return row.outcome;
}

const TRANSIENT_HEADER: Record<PlanTransient, string> = {
  approve: "Approving…",
  feedback: "Sending back…",
  clear: "Clearing context…",
};

/** The words a plan row's header says for an outcome. */
export function planHeader(outcome: PlanOutcome): string {
  switch (outcome.kind) {
    case "pending":
      return "Waiting for your approval";
    case "approved":
      return outcome.mode ? `Plan approved · ${approvedModePhrase(outcome.mode)}` : "Plan approved";
    case "sent-back":
      return "Sent back with feedback";
    case "rejected":
      return "Plan rejected";
    case "superseded":
      return "Plan not answered";
    case "continuation":
      return "Plan approved · carrying it out in a fresh context";
    case "transient":
      return TRANSIENT_HEADER[outcome.action];
  }
}

/**
 * The line a resolved plan row folds to: the plan's first non-blank line,
 * without the markdown that would draw it as a heading or in bold, and whether
 * anything follows it.
 */
export function planSummary(body: string): { line: string; more: boolean } {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  const first = lines[0] ?? "";
  const line = first
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/(\*\*|__|`)/g, "")
    .trim();
  return { line, more: lines.length > 1 };
}

/** How an approval's header names the mode it chose. */
function approvedModePhrase(mode: string): string {
  switch (modeId(mode)) {
    case "auto":
      return "auto mode";
    case "manual":
      return "you approve each edit";
    case "acceptEdits":
      return "accept edits";
    default:
      return `${modeTitle(mode).toLowerCase()} mode`;
  }
}

/**
 * Expand folded turns: an expanded turn-fold row is followed by its children.
 *
 * The fold row STAYS — it is the only control that can put the turn back, and
 * splicing it out made expansion one-way until a reload.
 */
export function visibleRows(
  rows: TimelineRow[],
  expandedTurns: ReadonlySet<string>,
): TimelineRow[] {
  const out: TimelineRow[] = [];
  // Kept rows an opened fold has already drawn in their place (`opened`).
  let drawn: Set<string> | null = null;
  for (const r of rows) {
    if (drawn?.has(r.key)) continue;
    out.push(r);
    if (r.kind === "turn-fold" && expandedTurns.has(r.turnKey)) {
      for (const h of r.opened ?? r.hidden) out.push(h);
      if (r.opened) {
        drawn ??= new Set();
        for (const h of r.opened) drawn.add(h.key);
      }
    }
  }
  return out;
}

/**
 * Structural equality for two derivations of the same row.
 *
 * deriveRows allocates fresh objects on every call, so the renderer cannot use
 * reference identity to tell "this row changed" from "this row was recomputed".
 * It holds each row in a signal of its own and writes that signal only when
 * this function says the content moved: an unchanged row then never notifies
 * its view, which is what keeps an expanded tool row open and a rendered
 * mermaid diagram mounted across a stream append.
 */
export function sameRow(a: TimelineRow, b: TimelineRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  const fa = a as unknown as Record<string, unknown>;
  const fb = b as unknown as Record<string, unknown>;
  // `for…in` rather than Object.keys, which allocated one array per side per
  // call only to walk one of them and read the other's length. This runs once
  // per mounted row per stream event and recurses through every leaf a fold
  // hides, so on a 30-turn transcript it was 1,259 calls and 2,518 throwaway
  // arrays per event. Dropping them took one pass over that transcript from
  // 1.4 ms to 0.6 ms. Rows are object literals, so `for…in` enumerates exactly
  // the own keys Object.keys would, and counting them answers the same
  // question the two lengths did.
  //
  // What is NOT the cost here, measured on the same transcript: the two
  // JSON.stringify fallbacks below, which fire 180 times over ~14 KB per
  // event. A tool row's `payload` and a fold row's `usage` are carried by
  // reference off the event objects, so a re-derivation hands back the same
  // object and they settle on `va === vb` long before the stringify.
  let na = 0;
  for (const name in fa) {
    na++;
    const va = fa[name];
    const vb = fb[name];
    if (va === vb) continue;
    // Nested rows — `hidden`, a tool's `children` — compare the same way.
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        const ea = va[i];
        const eb = vb[i];
        if (ea === eb) continue;
        if (isRow(ea) && isRow(eb)) {
          if (!sameRow(ea, eb)) return false;
          continue;
        }
        // Plain values (changed files, todo steps, answers).
        if (JSON.stringify(ea) !== JSON.stringify(eb)) return false;
      }
      continue;
    }
    // Structured payloads are compared by value; they are small by
    // construction (MaxInlineResult caps them server-side).
    if (va && vb && typeof va === "object" && typeof vb === "object") {
      if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    }
    return false;
  }
  // The loop above only visited the fields A has, so "same fields on both
  // sides" is still an open question. It has to stay asked: a field present on
  // one side and absent on the other reads as `undefined` on both, and would
  // otherwise slip through the `va === vb` line above. Same comparison as
  // before, asked after the values rather than before them, which changes only
  // which mismatch is found first.
  let nb = 0;
  for (const _name in fb) nb++;
  return na === nb;
}

function isRow(v: unknown): v is TimelineRow {
  return !!v && typeof v === "object" && typeof (v as TimelineRow).kind === "string";
}

export interface PendingPermission {
  reqId: string;
  tool: string;
  input: string;
}

/** Pending (unresolved) permission requests, oldest first — drives the
 * composer-docked permission panel. */
export function pendingPermissions(events: Event[]): PendingPermission[] {
  const resolved = new Set(
    events.filter((e) => e.kind === "permission_resolved" && e.reqId).map((e) => e.reqId as string),
  );
  return events
    .filter((e) => e.kind === "permission_request" && e.reqId && !resolved.has(e.reqId))
    .map((e) => ({
      reqId: e.reqId as string,
      tool: e.tool ?? "",
      input: e.body ?? "",
    }));
}

/**
 * True while the last turn is still OPEN.
 *
 * Open is not the same as working, and this is deliberately the wider of the
 * two: a turn parked on a question is unfinished. It used to decide whether
 * the composer offered Stop, which is how a reader took a dialog down, and it
 * no longer does. Since the Quiet line composer (2026-09-24) Stop sits on the
 * thin line above the pill and shows only while something RUNS, read off the
 * live row's `waiting` (`liveRow` below). While Claude waits, the ways out are
 * the card's own buttons, Send, and the terminal.
 */
export function sessionWorking(rows: TimelineRow[]): boolean {
  return rows.some((r) => r.kind === "working");
}

/**
 * The open turn's live row, or undefined while no turn is open.
 *
 * The timeline drew this row at its foot until 2026-09-24, then the Quiet
 * line's status line read it, and since the T3 pass (2026-09-27) the live
 * work group at the end of the conversation says what the turn is doing. The
 * composer still reads it to decide whether Stop shows. The last row of its
 * kind, because only the last turn can be open.
 */
export function liveRow(rows: TimelineRow[]): WorkingRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "working") return r;
  }
  return undefined;
}

/** The turn id a pending prompt's stand-in event carries (withPendingPrompts). */
const PENDING_TURN = "cmd";

/**
 * The open turn's live row with the prompts still pending taken into account.
 *
 * `shown` are the rows drawn with the pending prompts appended, `base` the
 * transcript's own. A pending prompt's turn is open until the transcript
 * records the prompt, and for prose that is under a second away. A slash
 * command may never be recorded (/help, /status, an unknown command), and a
 * pending one held the status line on "Working" with Stop over an idle session
 * until a reload (measured 2026-09-27). So while every pending prompt is a
 * command, the live row is the transcript's: none at idle, and the running
 * turn's own, call and all, when the command was sent mid-turn.
 */
export function liveRowOf(
  shown: TimelineRow[],
  base: TimelineRow[],
  sent: ReadonlyArray<Pick<PendingPrompt, "command">>,
): WorkingRow | undefined {
  const row = liveRow(shown);
  if (
    row &&
    sent.length > 0 &&
    sent.every((p) => p.command) &&
    row.turnKey.startsWith(PENDING_TURN)
  ) {
    return liveRow(base);
  }
  return row;
}

/**
 * What the live group at the end of the conversation says.
 *
 * `groupKey` names the running work group that carries it, when the open turn
 * ends on one; otherwise the timeline draws a row of its own in the same place.
 * `since` is when the thing being timed began: the group's first call, the call
 * in flight, the wait, or the turn when nothing has run yet.
 */
export type LiveGroupState =
  | { kind: "idle" }
  /** This device's plan answer is clearing the context (TextView planClearing). */
  | { kind: "clearing" }
  | { kind: "waiting"; since?: number; groupKey?: string }
  | {
      kind: "working";
      /** The call in flight. Absent before the first call and between calls. */
      tool?: string;
      label?: string;
      itemType?: ItemType;
      detail?: string;
      /** How many of the running group's calls have come back. */
      done: number;
      since?: number;
      groupKey?: string;
    };

/**
 * The live group's state, by the precedence the status line had
 * (docs/plans/2026-09-27-text-view-t3-pass.md retires that line).
 *
 * A context clear this device started comes first: the old transcript records
 * it as a rejection and closes its turn, and for up to 20 s nothing else says
 * that Claude is about to start on the plan in a new conversation. Then the
 * open turn, waiting when Claude is stopped on the reader and working
 * otherwise. Then nothing.
 *
 * Watching is not an input. The line hid the turn behind "Watching"; the live
 * group sits in the conversation, and a device that only watches still wants
 * to see the work go by.
 *
 * `live` is the open turn's row as the view has it (TextView `lineLive`, which
 * knows about a docked plan card and pending slash commands). `last` is the
 * last row the timeline draws. When that is the open turn's running group, the
 * group carries the state and gives it its call and count.
 */
export function liveGroupState(o: {
  live?: WorkingRow;
  last?: TimelineRow;
  clearing?: boolean;
}): LiveGroupState {
  if (o.clearing) return { kind: "clearing" };
  const live = o.live;
  if (!live) return { kind: "idle" };
  const last = o.last;
  const group =
    last?.kind === "work-group" && last.live && last.turnKey === live.turnKey ? last : undefined;
  const groupKey = group ? { groupKey: group.key } : {};
  if (live.waiting) {
    return {
      kind: "waiting",
      ...(live.toolStartedAt !== undefined ? { since: live.toolStartedAt } : {}),
      ...groupKey,
    };
  }
  if (group?.live) {
    const g = group.live;
    return {
      kind: "working",
      ...(g.tool !== undefined ? { tool: g.tool } : {}),
      ...(g.label !== undefined ? { label: g.label } : {}),
      ...(g.itemType !== undefined ? { itemType: g.itemType } : {}),
      ...(g.detail !== undefined ? { detail: g.detail } : {}),
      done: g.done,
      ...(g.startedAt !== undefined ? { since: g.startedAt } : {}),
      ...groupKey,
    };
  }
  const since = live.toolStartedAt ?? live.startedAt;
  return {
    kind: "working",
    ...(live.tool !== undefined ? { tool: live.tool } : {}),
    ...(live.toolLabel !== undefined ? { label: live.toolLabel } : {}),
    ...(live.toolItemType !== undefined ? { itemType: live.toolItemType } : {}),
    ...(live.toolDetail !== undefined ? { detail: live.toolDetail } : {}),
    done: 0,
    ...(since !== undefined ? { since } : {}),
  };
}

/** The icons a live call can wear: the work group's own set (rows.tsx). */
export type LiveIcon = "command" | "edit" | "read" | "search" | "picture" | "tools";

/** What the live row says about the call in flight. */
export interface LiveCall {
  icon: LiveIcon;
  verb: string;
  /** The call's headline, as `describe` gave it: a command, a file name, a pattern. */
  target: string;
  /** Its second line where Claude gave one, first line only: a command's
   *  description, where a search looks, a subagent's task. */
  detail: string;
}

/**
 * The call in flight in words: "Editing session.ts", "Searching for
 * liveGroupState in src/", "Running npm test · Run the card tests".
 *
 * It used to be "Running <label>" for every tool, so an edit read "Running
 * session.ts". The verb follows the kind of call, as T3 Code's live row does.
 * A Read or an Edit gets no detail: its detail is the target's full path,
 * which the target's title already carries.
 */
export function liveCall(c: {
  tool?: string;
  itemType?: ItemType;
  label?: string;
  detail?: string;
}): LiveCall | null {
  if (!c.tool) return null;
  const target = c.label || c.tool;
  const second = (c.detail ?? "").trim().split("\n")[0]?.trim() ?? "";
  const call = (icon: LiveIcon, verb: string, detail = second): LiveCall => ({
    icon,
    verb,
    target,
    detail,
  });
  switch (c.tool) {
    case "Edit":
    case "NotebookEdit":
      return call("edit", "Editing", "");
    case "Write":
      return call("edit", "Writing", "");
    case "Read":
    case "NotebookRead":
      return call("read", "Reading", "");
    case "Grep":
      return call("search", "Searching for", second && `in ${second}`);
    case "Glob":
      return call("search", "Finding", second && `in ${second}`);
    case "WebSearch":
      return call("search", "Searching the web for");
    case "WebFetch":
      return call("search", "Fetching");
    case "Skill":
      return call("tools", "Loading skill");
  }
  switch (c.itemType) {
    case "command_execution":
      return call("command", "Running");
    case "image_view":
      return call("picture", "Viewing");
    case "collab_agent_tool_call":
      return call("tools", "Agent:");
    case "mcp_tool_call":
      return call("tools", "Using");
  }
  return call("tools", "Running");
}

/**
 * What the live group shows of a call's target.
 *
 * A path by its file name: the row has a few words of room, and the name is
 * the part that says which file. The title carries the whole path. A command
 * whole, since its first word is rarely its point (`npx vitest run
 * QuestionCard`), and an address whole, since its last segment says nothing on
 * its own. A token with no space in it and a slash somewhere is a path.
 */
export function shortTarget(label: string): string {
  const t = label.trim();
  if (!t || /\s/.test(t) || !t.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const parts = t.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? t;
}

/**
 * The newest row that says something happened — everything except the open
 * turn's working marker, which is appended after the turn's own rows and is
 * therefore what a LIVE question is followed by.
 */
function newestSubstantive(rows: TimelineRow[]): TimelineRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "working") continue;
    return r;
  }
  return null;
}

/**
 * The question the session is blocked on, if any — an AskUserQuestion whose
 * result has not arrived AND which nothing has happened since. This is the
 * transcript-derived half of ADR-0010: the options are recorded losslessly, so
 * only the ANSWER has to be inferred.
 *
 * The second half of that rule is not a nicety. An unresolved question is not
 * proof of a dialog on screen: Claude Code takes the dialog down when something
 * else claims the turn — a task-notification delivered as a queued message is
 * the case measured — and re-asks, leaving the first call unresolved for good.
 * Searching for the newest PENDING question found that abandoned one and docked
 * the answer card over it indefinitely, including right after the live question
 * was answered. So a question is being asked only while it is the last thing
 * that happened.
 */
export function pendingQuestion(rows: TimelineRow[]): QuestionRow | null {
  return liveQuestions(rows).find((q) => q.pending) ?? null;
}

/**
 * The question rows at the end of the conversation, oldest first: the newest
 * substantive row when it is a question, and the questions straight before it.
 *
 * More than one because Claude asks several calls in one message when it
 * grills, and Claude Code shows their menus one after another (measured
 * 2026-10-01). A call answered out of order does not move the session past the
 * others: only something else written after them does, a reply or a prompt,
 * which is the abandoned-dialog case above.
 */
function liveQuestions(rows: TimelineRow[]): QuestionRow[] {
  const out: QuestionRow[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "working") continue;
    if (r.kind !== "question") break;
    out.unshift(r);
  }
  return out;
}

/** `DialogView.kind` on a plan reading (sessionio DialogKindPlan). */
const DIALOG_KIND_PLAN = "plan";

/** `DialogView.kind` on a tool permission reading (sessionio DialogKindPermission). */
const DIALOG_KIND_PERMISSION = "permission";

/**
 * The tool permission prompt the PANE is showing, or null.
 *
 * The transcript holds the tool call and nothing about the prompt, so the pane
 * is the only source (sessionio permdialog.go). The newest reading wins, and
 * only while nothing has happened since, the rule the held question follows: the
 * call's result, or anything else Claude writes, means the prompt was
 * answered. A reading whose rows do not count up from 1 is refused whole,
 * because the card presses a row's number.
 *
 * "Since" is by the time each event was written, not by where it lands in the
 * stream. The pane watcher and the transcript tail tick apart, so the reading
 * can come in ahead of the transcript's record of the very call that raised
 * the prompt (1 prompt in 6 on 2026-09-27). That record was written before the
 * prompt was drawn, so it says nothing about whether it was answered. An event
 * with no time on it is taken to be after.
 */
export function permissionFromPane(events: Event[]): PermissionReading | null {
  let latest = "";
  let id = 0;
  let readAt = 0;
  for (const e of events) {
    if (e.kind === "meta") {
      if (e.meta === "asking") {
        latest = e.body ?? "";
        id = e.id;
        readAt = e.at ?? 0;
      }
      continue;
    }
    if (e.at !== undefined && e.at <= readAt) continue;
    latest = "";
  }
  if (!latest) return null;
  const raw = parseJSON(latest) as {
    kind?: unknown;
    title?: unknown;
    detail?: unknown;
    prompt?: unknown;
    options?: unknown;
  } | null;
  if (!raw || raw.kind !== DIALOG_KIND_PERMISSION || !Array.isArray(raw.options)) return null;
  const options: PlanOptionView[] = [];
  for (const item of raw.options as unknown[]) {
    const opt = item as { number?: unknown; label?: unknown } | null;
    if (!opt || opt.number !== options.length + 1 || typeof opt.label !== "string" || !opt.label) {
      return null;
    }
    options.push({ number: opt.number, label: opt.label });
  }
  if (options.length < 2) return null;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    detail: Array.isArray(raw.detail)
      ? raw.detail.filter((l): l is string => typeof l === "string")
      : [],
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    options,
  };
}

/** A tool permission prompt as the pane shows it (see permissionFromPane). */
export interface PermissionReading {
  /** The `asking` event this reading came in, which tells one prompt from the next. */
  id: number;
  /** The prompt's first line, "Bash command" or "Read file". */
  title: string;
  /** What the tool will do, as drawn under the title. */
  detail: string[];
  /** The question over the rows, "Do you want to proceed?". */
  prompt: string;
  /** The rows, numbered from 1, labels exactly as drawn. */
  options: PlanOptionView[];
}

/**
 * Claude Code's plan approval as the pane draws it, or null when `reading` is
 * not a plan reading that can be trusted.
 *
 * `reading` is either the body of an `asking` meta, still JSON, or the
 * `dialog` of an answer reply, already decoded: the server puts the same
 * reading in both places (sessionio/plandialog.go, contract 2 of
 * docs/plans/2026-09-24-text-composer-redesign.md).
 *
 * Every approve row needs a whole number and a label, and the feedback row
 * has to come after the last of them. A reading that fails any of that is
 * refused whole rather than repaired: the card offers what this returns, and
 * a row the pane does not draw, or a feedback row taken for an approve row,
 * is how a tap approves something the reader did not choose.
 *
 * This reads one reading and nothing else. When the card docks, which also
 * depends on the ExitPlanMode call in the transcript, is decided elsewhere.
 */
export function planFromPane(reading: string | DialogView | null | undefined): PlanReading | null {
  const raw: unknown = typeof reading === "string" ? parseJSON(reading) : reading;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { kind?: unknown; options?: unknown; feedbackRow?: unknown; planPath?: unknown };
  if (o.kind !== DIALOG_KIND_PLAN || !Array.isArray(o.options) || o.options.length === 0) {
    return null;
  }
  const options: PlanOptionView[] = [];
  for (const item of o.options as unknown[]) {
    const opt = item as { number?: unknown; label?: unknown } | null;
    if (!opt || !Number.isInteger(opt.number) || typeof opt.label !== "string" || !opt.label) {
      return null;
    }
    options.push({ number: opt.number as number, label: opt.label });
  }
  const last = options[options.length - 1]!.number;
  if (!Number.isInteger(o.feedbackRow) || (o.feedbackRow as number) <= last) return null;
  return {
    options,
    feedbackRow: o.feedbackRow as number,
    planPath: typeof o.planPath === "string" ? o.planPath : "",
  };
}

/** The plan approval as the pane shows it (see planFromPane). */
export interface PlanReading {
  /** The approve rows, numbered from 1, with their labels exactly as drawn. */
  options: PlanOptionView[];
  /** The "Tell Claude what to change" row, the one after the last approve row. */
  feedbackRow: number;
  /** The plan file the footer names, or "" when it names none. */
  planPath: string;
}

/** The mode in force, from the most recent mode marker. */
export function currentMode(events: Event[], seed?: SessionState | null): string {
  let mode = seed?.mode ?? "";
  for (const e of after(events, seed)) {
    if (e.kind === "meta" && e.meta === "permission-mode" && e.body) mode = e.body;
  }
  return mode;
}

/**
 * The model and effort the session last answered on, folded the same way.
 *
 * Undefined until it has answered once: both come off the transcript's
 * assistant records (sessionio MetaModel), so a session that has taken no turn
 * has said nothing about either — and a chip showing a guess would be worse
 * than one showing nothing.
 */
export function currentModel(events: Event[], seed?: SessionState | null): ModelState | undefined {
  let state = seed?.model;
  for (const e of after(events, seed)) {
    if (e.kind !== "meta" || e.meta !== "model" || !e.model) continue;
    // A reading with only an effort (one picked from the model sheet) changes
    // the effort and leaves the model before it standing.
    if (!e.model.model && e.model.effort) state = { ...state, effort: e.model.effort };
    else state = e.model;
  }
  return state;
}

/**
 * The events a seeded fold may apply: those the state frame does not already
 * account for.
 *
 * The frame is computed over the whole log, and the window a client holds sits
 * BELOW its `at` — so folding the window on top would apply the same queue
 * operations, prompts and mode changes twice. Without a frame this is the whole
 * list, which is what these folds did before there was one.
 */
function after(events: Event[], seed?: SessionState | null): Event[] {
  if (!seed) return events;
  const at = seed.at;
  return events.filter((e) => e.id > at);
}

/**
 * How many queued prompts the timeline draws before summarising the rest.
 *
 * They were chips above the composer's field until 2026-09-24 and are ghost
 * bubbles at the end of the conversation now, where each will land once
 * Claude takes it. Three is still where "+N more waiting" takes over.
 */
export const MAX_QUEUED_SHOWN = 3;

/**
 * Prompts sitting in Claude's queue, oldest first.
 *
 * Replayed from the queue's own operations rather than inferred. The CLI
 * reports every arrival AND every departure — enqueue, remove (that one),
 * dequeue (the head), popAll (all of them) — but only the arrivals were being
 * carried, so the list grew for the life of the session. Viktor's session had
 * an empty queue and showed three waiting (2026-08-18): his own message, which
 * had been answered, and two background task notifications consumed minutes
 * earlier.
 *
 * A windowed transcript can only make this UNDER-report — an enqueue older than
 * the window is missed along with its removal — which is the safe direction for
 * a list that claims work is still waiting.
 *
 * Task notifications are dropped: they are the harness telling Claude a
 * background job finished, not something a person is waiting on, and they
 * render as a wall of XML.
 */
export function queuedPrompts(events: Event[], seed?: SessionState | null): string[] {
  let queue: string[] = [...(seed?.queue ?? [])];
  for (const e of after(events, seed)) {
    if (e.kind !== "meta") continue;
    const text = (e.body ?? "").trim();
    switch (e.meta) {
      case "queued":
        if (text) queue.push(text);
        break;
      case "unqueued": {
        const at = queue.indexOf(text);
        if (at >= 0) queue.splice(at, 1);
        break;
      }
      case "dequeued":
        queue.shift();
        break;
      case "queue-cleared":
        queue = [];
        break;
      default:
        break;
    }
  }
  return queue.filter((t) => !isHarnessNotice(t)).map(unwrapPasted);
}

/**
 * The prompts sent from here that Claude has NOT queued, so the timeline draws
 * each message once.
 *
 * A prompt sent mid-turn shows at once as a pending bubble (withPendingPrompts
 * below), and seconds later the CLI records it as queued, which the timeline
 * draws as a dashed ghost at its end. Without this the one message showed
 * twice, as a bubble and as a ghost (spec risk R6). The change of look between
 * the two moments stays; the double does not.
 *
 * One queued entry accounts for ONE pending prompt, oldest first, the same way
 * the store releases pending prompts one transcript record at a time: two
 * identical messages with one of them queued are still two messages. Returns
 * `sent` itself when nothing is left out, so the caller's fold is reused.
 *
 * They are matched on their words (`wordsOf`): the CLI records a picture
 * attached from a path as "[Image #N]", with no path, where the prompt sent
 * from here holds the path. Matched on the whole text, a queued message with
 * a picture drew twice (deployed review round 1 of the T3 pass, 2026-09-29).
 */
export function withoutQueued<T extends { text: string }>(
  sent: readonly T[],
  queued: readonly string[],
): readonly T[] {
  if (sent.length === 0 || queued.length === 0) return sent;
  const waiting = new Map<string, number>();
  for (const q of queued) waiting.set(wordsOf(q), (waiting.get(wordsOf(q)) ?? 0) + 1);
  let dropped = false;
  const kept = sent.filter((p) => {
    const words = wordsOf(p.text);
    const n = waiting.get(words) ?? 0;
    if (n === 0) return true;
    waiting.set(words, n - 1);
    dropped = true;
    return false;
  });
  return dropped ? kept : sent;
}

/**
 * The ghosts for Claude's queue: each queued entry the CLI rewrote with
 * "[Image #N]" drawn as the message sent from here with the same words, whose
 * picture's path draws the picture (`withSentPictures`). An entry nothing
 * here sent stays as the CLI recorded it.
 */
export function queuedGhosts(
  queued: readonly string[],
  sent: ReadonlyArray<Pick<PendingPrompt, "text">>,
): string[] {
  return withSentPictures(
    queued,
    sent.map((p) => p.text.trim()),
  );
}

/**
 * What a Stop hands back to the composer, oldest first: the prompts Claude has
 * queued (the ghosts), and the prose sent from here that the transcript has not
 * recorded at all, which never reached the queue or is still on its way.
 *
 * `held` is the store's pending prompts, in send order, and that order is kept.
 * Each queued prompt stands for the oldest held one with the same words
 * (`wordsOf`) and goes back as that one was written, so a picture comes back
 * as its path rather than the CLI's "[Image #N]" (deployed review round 1 of
 * the T3 pass, 2026-09-29). A held prompt the queue does not have goes back
 * before the next queued one that was sent after it. Found in the live check
 * on 2026-09-27: two sends 100ms apart, the CLI recorded only the second
 * one's enqueue, and the first came back after it. Queued prompts nothing here sent (typed in the terminal)
 * keep their place in the queue.
 *
 * A slash command is left out: it may never be recorded at all
 * (store/session.ts), so a held one says nothing about the queue.
 *
 * A paste the CLI queued comes wrapped in its own marker,
 * `<pasted_content id="bae7">\n…\n</pasted_content id="bae7">` (CLI 2.1.283,
 * seen 2026-09-27), and the reader gets back what they pasted, not the marker.
 */
export function handedBack(queued: readonly string[], held: readonly PendingPrompt[]): string[] {
  const prose = held.map((p) => (p.command ? "" : p.text.trim()));
  const matched = new Set<number>();
  const out: string[] = [];
  let next = 0;
  const flushTo = (limit: number): void => {
    for (; next < limit; next++) if (prose[next] && !matched.has(next)) out.push(prose[next]!);
  };
  for (const q of queued) {
    const text = unwrapPasted(q);
    const words = wordsOf(text);
    const at = prose.findIndex((t, n) => t !== "" && !matched.has(n) && wordsOf(t) === words);
    if (at >= 0) {
      matched.add(at);
      flushTo(at);
      // As it was written here: a picture's path in place of the CLI's
      // "[Image #N]", which the field turns back into its chip.
      out.push(prose[at]!);
      continue;
    }
    out.push(text);
  }
  flushTo(prose.length);
  return out;
}

/**
 * The CLI's pasted_content markers taken off, keeping what they held.
 *
 * CLI 2.1.283 records a long paste as `\n\n<pasted_content id="ed39">\n…\n
 * </pasted_content id="ed39">\n`, after whatever was typed before it. The
 * reader sees their own words: the tags and the blank lines the CLI put around
 * them go, and a text with no marker comes back exactly as it was.
 */
function unwrapPasted(text: string): string {
  let found = false;
  const out = text.replace(
    /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g,
    (_m, _id: string, inner: string) => {
      found = true;
      return inner;
    },
  );
  return found ? out.trim() : text;
}

/** The harness's own injected notices, which nobody queued and nobody reads. */
function isHarnessNotice(text: string): boolean {
  return /^<(task-notification|system-reminder|local-command-stdout)\b/.test(text);
}

/**
 * A bare `/model` or `/effort`: what the model sheet types to open the CLI's
 * picker (sessionio/setmodel.go). Recorded as a user record, it drew a bubble
 * nobody wrote and a history entry ↑ kept landing on (deployed review round 5,
 * 2026-09-29). The CLI's receipt after it says what changed. A command typed
 * with an argument is the writer's own and is kept.
 */
function isPickerCommand(text: string): boolean {
  return /^\/(model|effort)$/.test(text.trim());
}

/** Every prompt this session has sent, oldest first — the composer's history. */
export function promptHistory(events: Event[], seed?: SessionState | null): string[] {
  const out: string[] = (seed?.prompts ?? []).map(unwrapPasted).filter((p) => !isPickerCommand(p));
  for (const e of after(events, seed)) {
    const text = unwrapPasted(e.body ?? "").trim();
    if (isPickerCommand(text)) continue;
    if (e.kind === "user" && text && out[out.length - 1] !== text) out.push(text);
    if (e.kind === "meta" && e.meta === "picture-source" && e.body && out.length > 0) {
      out[out.length - 1] = withPictureSources(out[out.length - 1]!, e.body.split("\n"));
    }
  }
  return out;
}

/** The stand-in Claude Code records for a picture it attached from a path. */
const IMAGE_PLACEHOLDER_RE = /\[Image #\d+\]/g;

/**
 * A recorded prompt as it was sent, for ↑: each "[Image #N]" swapped, in
 * order, for the file its picture-source marker names. The CLI takes a
 * picture's path off the end of the paste and puts the placeholder at the
 * start (CLI 2.1.283, 2026-09-28), so the paths go back at the end, where
 * the composer recalls them as chips. Any browser gets this, not only the one
 * that sent it (deployed review round 4, 2026-09-28). The same rule as
 * session-events' PromptWithPictures, which seeds the history.
 */
function withPictureSources(prompt: string, paths: readonly string[]): string {
  let taken = 0;
  const words = prompt.replace(IMAGE_PLACEHOLDER_RE, (ph) => {
    if (taken >= paths.length) return ph;
    taken += 1;
    return "";
  });
  if (taken === 0) return prompt;
  return `${words.trim()} ${paths.slice(0, taken).join(" ")}`.trim();
}

/**
 * Where the scroller must sit after rows were inserted ABOVE what the reader is
 * looking at, so nothing they can see moves.
 *
 * The inputs are the offsetTop of an ANCHOR row — one that was already mounted —
 * measured on both sides of the insertion. That is exactly the height that
 * appeared above it. Using the container's scrollHeight instead looks
 * equivalent and is not: scrollHeight also grows when rows BELOW get taller,
 * which they do here as markdown renders and code highlights, and compensating
 * for that scrolls the reader down through content they never asked to leave.
 * Measured with the scrollHeight version: a reader who scrolled to the top
 * mid-fill was dragged 5,780px and ended up back at the live end.
 *
 * PURE so the arithmetic is tested without a layout engine (jsdom has none).
 */
export function scrollTopAfterPrepend(
  scrollTop: number,
  anchorOffsetBefore: number,
  anchorOffsetAfter: number,
): number {
  const insertedAbove = anchorOffsetAfter - anchorOffsetBefore;
  if (insertedAbove <= 0) return scrollTop;
  return scrollTop + insertedAbove;
}

/**
 * The events the transcript reports, plus the prompts this surface has sent
 * that it has not shown yet.
 *
 * They go at the END rather than at their timestamp: a prompt is sent from the
 * bottom of a live conversation, and the transcript's own account of it arrives
 * later and replaces this. Each gets its own turn key, so a prompt still
 * waiting on a response reads as a turn with nothing in it yet — which is
 * exactly what it is.
 */
export function withPendingPrompts(events: Event[], sent: ReadonlyArray<PendingPrompt>): Event[] {
  if (sent.length === 0) return events;
  return [
    ...events,
    ...sent.map(
      (c): Event =>
        ({
          id: c.id,
          kind: "user",
          session: "",
          turnId: `${PENDING_TURN}${c.id}`,
          body: c.text,
          at: c.at,
          ...(c.sending ? { sending: true } : {}),
        }) as Event,
    ),
  ];
}
