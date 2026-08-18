import type { Event, MetaKind, PermissionDecision, TokenUsage } from "../types/events";
import type { PendingPrompt } from "./compose.logic";
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
 * begins; the running (last, unsettled) turn never folds and shows a working
 * row. Tool_use/tool_result are paired by toolId (T3's collapseKey).
 *
 * The folding rules follow t3code's MessagesTimeline.logic.ts (MIT, T3 Tools
 * Inc): the last assistant message of a settled turn stays visible as the
 * turn's answer and everything else folds behind "Worked for Ns". What a tool
 * row SAYS comes from canonicalize.ts, which reads the transcript's own payloads.
 */

export interface UserRow {
  kind: "user";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  at?: number;
}
export interface MessageRow {
  kind: "message";
  key: string;
  id: number;
  body: string;
  turnKey: string;
  streaming: boolean;
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
  /** The payload was capped; the full one is fetched by toolId. */
  truncated: boolean;
  /** Subagent work belonging to this call (collab_agent_tool_call only). */
  children: LeafRow[];
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
  /** What was chosen, once the transcript records an answer. */
  answers: string[];
  pending: boolean;
  turnKey: string;
  at?: number;
}
/** ExitPlanMode — a plan put up for approval. */
export interface PlanRow {
  kind: "plan";
  key: string;
  id: number;
  body: string;
  pending: boolean;
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
  count: number;
  durationMs?: number;
  hidden: LeafRow[];
  /** At least one hidden row is a failure — the collapsed row must say so. */
  hasError: boolean;
  /** Files the turn changed, summarised on the collapsed row. */
  changedFiles: string[];
  usage?: TokenUsage;
}
export interface WorkingRow {
  kind: "working";
  key: string;
  turnKey: string;
  startedAt?: number;
  /** The call currently in flight, if the turn is inside one. */
  tool?: string;
  toolLabel?: string;
  toolStartedAt?: number;
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
export type TimelineRow = LeafRow | TurnFoldRow | WorkingRow;

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
    (row.kind === "tool" && row.isError) ||
    (row.kind === "meta" && row.meta === "hook-error")
  );
}

function turnDuration(turn: Turn): number | undefined {
  const ats = turn.events
    .map((e) => e.at)
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (ats.length < 2) return undefined;
  const first = ats[0]!;
  const last = ats[ats.length - 1]!;
  const d = last - first;
  return d > 0 ? d : undefined;
}

/** The answers an AskUserQuestion result records, as flat labels. */
function answersFrom(payload: unknown): string[] {
  const raw = (payload as { answers?: unknown } | null)?.answers;
  if (!raw) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === "object") Object.values(raw as object).forEach(push);
  return out;
}

/** Derive the folded row list from a session's events (see module doc). */
export function deriveRows(events: Event[]): TimelineRow[] {
  const turns = groupTurns(events);
  const out: TimelineRow[] = [];

  turns.forEach((turn, ti) => {
    const isLast = ti === turns.length - 1;
    const settled = turn.ended || !isLast;

    let userRow: UserRow | null = null;
    const work: LeafRow[] = [];
    const toolBy = new Map<string, ToolRow>();
    // The subagent call currently collecting sidechain work, if any.
    let host: ToolRow | null = null;
    let lastTodo: TodoRow | null = null;
    // Rows awaiting the tool_result that resolves them, by tool_use_id. Local
    // to the turn: deriveRows runs on every event and must be pure, so nothing
    // here may outlive one derivation.
    const pendingByTool = new Map<string, QuestionRow | PlanRow>();

    /** Push a row into the turn, or into the subagent that spawned it. */
    const add = (row: LeafRow, sidechain?: boolean) => {
      if (sidechain && host) host.children.push(row);
      else work.push(row);
    };

    for (const e of turn.events) {
      switch (e.kind) {
        case "user":
          userRow = {
            kind: "user",
            key: `user-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          };
          break;
        case "text":
          add(
            {
              kind: "message",
              key: `msg-${e.id}`,
              id: e.id,
              body: e.body ?? "",
              turnKey: turn.key,
              streaming: false,
              ...(e.at !== undefined ? { at: e.at } : {}),
            },
            e.sidechain,
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
            e.sidechain,
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
              add(lastTodo, e.sidechain);
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
            add(row, e.sidechain);
            break;
          }
          if (d.type === "plan") {
            const plan = parseJSON(e.body) as { plan?: string } | null;
            const row: PlanRow = {
              kind: "plan",
              key: `plan-${e.toolId || e.id}`,
              id: e.id,
              body: plan?.plan ?? e.body ?? "",
              pending: true,
              turnKey: turn.key,
              ...(e.at !== undefined ? { at: e.at } : {}),
            };
            if (e.toolId) pendingByTool.set(e.toolId, row);
            add(row, e.sidechain);
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
          // A subagent's own work arrives as sidechain records AFTER the call
          // that spawned it, so the call becomes the host for what follows.
          if (d.type === "collab_agent_tool_call") host = row;
          add(row, e.sidechain);
          break;
        }
        case "tool_result": {
          const waiting = e.toolId ? pendingByTool.get(e.toolId) : undefined;
          if (waiting) {
            waiting.pending = false;
            if (waiting.kind === "question") {
              waiting.answers = answersFrom(e.result);
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
            existing.truncated = !!e.truncated;
            if (existing.itemType === "collab_agent_tool_call" && host === existing) {
              host = null;
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
                ...(e.at !== undefined ? { at: e.at } : {}),
              },
              e.sidechain,
            );
          }
          break;
        }
        case "meta": {
          const meta = e.meta ?? "mode";
          // `mode` and `permission-mode` are STATE, not events: the composer's
          // chip always shows the mode in force, so a divider announcing each
          // change interrupts the conversation to repeat what is already on
          // screen (Viktor, 2026-08-17). The EVENTS still flow — currentMode()
          // reads them for that chip — only the row is dropped, and dropped
          // outright rather than folded, since expanding a turn would put the
          // divider back.
          if (meta === "mode" || meta === "permission-mode") break;
          add({
            kind: "meta",
            key: `meta-${e.id}`,
            id: e.id,
            meta,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          });
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
            (r): r is PermissionRow =>
              r.kind === "permission" && r.reqId === e.reqId,
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
          add({
            kind: "error",
            key: `err-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            ...(e.at !== undefined ? { at: e.at } : {}),
          });
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

    if (userRow) out.push(userRow);

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
      const visible = work[visibleAt];
      const hidden = work.filter((_, i) => i !== visibleAt);
      const changed = [
        ...new Set(
          work.flatMap((r) => (r.kind === "tool" ? r.changedFiles : [])),
        ),
      ];
      const fold: TurnFoldRow | null =
        hidden.length > 0
          ? {
              kind: "turn-fold",
              key: `fold-${turn.key}`,
              turnKey: turn.key,
              count: hidden.length,
              hidden,
              hasError: hidden.some(leafFailed),
              changedFiles: changed,
              ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
              ...(turnDuration(turn) !== undefined
                ? { durationMs: turnDuration(turn) }
                : {}),
            }
          : null;
      // Chronology: the fold stands for the run of hidden rows that begins at
      // the first one, so it goes above the visible message only when hidden
      // work preceded it. A turn whose last item is a tool call keeps the
      // message that ANNOUNCED the call above the fold holding it.
      if (fold && visibleAt > 0) out.push(fold);
      if (visible) out.push(visible);
      if (fold && visibleAt === 0) out.push(fold);
    } else {
      for (const r of work) out.push(r);
    }

    if (!settled) {
      // Mark the last assistant message as streaming and append a working row.
      for (let i = work.length - 1; i >= 0; i--) {
        const r = work[i]!;
        if (r.kind === "message") {
          r.streaming = true;
          break;
        }
      }
      // What is happening RIGHT NOW: the newest tool call that has not come
      // back yet. The transcript records a tool_use the moment Claude emits it,
      // so this is specific without any second source (design decision 6).
      let live: ToolRow | undefined;
      for (let i = work.length - 1; i >= 0; i--) {
        const r = work[i]!;
        if (r.kind === "tool" && !r.done) {
          live = r;
          break;
        }
      }
      out.push({
        kind: "working",
        key: `working-${turn.key}`,
        turnKey: turn.key,
        steps: work.length,
        ...(turn.events[0]?.at !== undefined
          ? { startedAt: turn.events[0]!.at }
          : {}),
        ...(live
          ? {
              tool: live.tool,
              toolLabel: live.label,
              ...(live.at !== undefined ? { toolStartedAt: live.at } : {}),
            }
          : {}),
      });
    }
  });

  return out;
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
  for (const r of rows) {
    out.push(r);
    if (r.kind === "turn-fold" && expandedTurns.has(r.turnKey)) {
      for (const h of r.hidden) out.push(h);
    }
  }
  return out;
}

/**
 * Structural equality for two derivations of the same row.
 *
 * deriveRows allocates fresh objects on every call, so the renderer cannot use
 * reference identity to tell "this row changed" from "this row was recomputed".
 * It holds each row behind a memo whose equality is this function: an unchanged
 * row then never notifies its view, which is what keeps an expanded tool row
 * open and a rendered mermaid diagram mounted across a stream append.
 */
export function sameRow(a: TimelineRow, b: TimelineRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  const fa = a as unknown as Record<string, unknown>;
  const fb = b as unknown as Record<string, unknown>;
  const names = Object.keys(fa);
  if (names.length !== Object.keys(fb).length) return false;
  for (const name of names) {
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
  return true;
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
    events
      .filter((e) => e.kind === "permission_resolved" && e.reqId)
      .map((e) => e.reqId as string),
  );
  return events
    .filter(
      (e) => e.kind === "permission_request" && e.reqId && !resolved.has(e.reqId),
    )
    .map((e) => ({
      reqId: e.reqId as string,
      tool: e.tool ?? "",
      input: e.body ?? "",
    }));
}

/** True while the last turn is still running (drives the Send↔Stop morph). */
export function sessionWorking(rows: TimelineRow[]): boolean {
  return rows.some((r) => r.kind === "working");
}

/**
 * The question the session is blocked on, if any — an AskUserQuestion whose
 * result has not arrived. This is the transcript-derived half of ADR-0010: the
 * options are recorded losslessly, so only the ANSWER has to be inferred.
 */
export function pendingQuestion(rows: TimelineRow[]): QuestionRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "question" && r.pending) return r;
    if (r.kind === "turn-fold") {
      for (const h of r.hidden) {
        if (h.kind === "question" && h.pending) return h;
      }
    }
  }
  return null;
}

/** The mode in force, from the most recent mode marker. */
export function currentMode(events: Event[]): string {
  let mode = "";
  for (const e of events) {
    if (e.kind === "meta" && e.meta === "permission-mode" && e.body) mode = e.body;
  }
  return mode;
}

/** How many queued prompts the composer shows before summarising the rest. */
export const MAX_QUEUED_SHOWN = 3;

/**
 * Prompts sitting in Claude's queue.
 *
 * Only those enqueued since the last thing the human actually said, and only
 * while the turn that will consume them is still running. The transcript never
 * reports a prompt LEAVING the queue, so a list built from every queue-operation
 * in the session only grows: measured on a real session it reached twelve rows
 * of background-task notifications and took a third of the screen. Anchoring to
 * the running turn keeps the list to what is genuinely still waiting.
 */
export function queuedPrompts(events: Event[]): string[] {
  const spoken = new Set(
    events.filter((e) => e.kind === "user").map((e) => (e.body ?? "").trim()),
  );
  // Everything after the last real prompt is the turn now running.
  let from = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "user") {
      from = i;
      break;
    }
  }
  const out: string[] = [];
  for (const e of events.slice(from)) {
    if (e.kind !== "meta" || e.meta !== "queued") continue;
    const text = (e.body ?? "").trim();
    if (text && !spoken.has(text) && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Every prompt this session has sent, oldest first — the composer's history. */
export function promptHistory(events: Event[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const text = (e.body ?? "").trim();
    if (e.kind === "user" && text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
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
export function withPendingPrompts(
  events: Event[],
  sent: ReadonlyArray<PendingPrompt>,
): Event[] {
  if (sent.length === 0) return events;
  return [
    ...events,
    ...sent.map(
      (c): Event =>
        ({
          id: c.id,
          kind: "user",
          session: "",
          turnId: `cmd${c.id}`,
          body: c.text,
          at: c.at,
        }) as Event,
    ),
  ];
}
