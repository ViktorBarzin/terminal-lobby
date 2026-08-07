import type { Event, PermissionDecision } from "../types/events";

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
export interface ToolRow {
  kind: "tool";
  key: string;
  id: number;
  tool: string;
  toolId?: string;
  input: string;
  result?: string;
  isError: boolean;
  done: boolean;
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
export interface TurnFoldRow {
  kind: "turn-fold";
  key: string;
  turnKey: string;
  count: number;
  durationMs?: number;
  hidden: LeafRow[];
  /** At least one hidden row is a failure — the collapsed row must say so. */
  hasError: boolean;
}
export interface WorkingRow {
  kind: "working";
  key: string;
  turnKey: string;
  startedAt?: number;
}

/** Rows that can be hidden inside a fold (everything except fold/working). */
export type LeafRow =
  | UserRow
  | MessageRow
  | ToolRow
  | PermissionRow
  | ErrorRow
  | StatusRow;
export type TimelineRow = LeafRow | TurnFoldRow | WorkingRow;

interface Turn {
  key: string;
  events: Event[];
  ended: boolean;
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
    if (e.kind === "turn_end") t.ended = true;
  }

  // A turn is implicitly settled once a later turn has started.
  turns.forEach((t, i) => {
    if (i < turns.length - 1) t.ended = true;
  });
  return turns;
}

/** A leaf row that stands for something that went wrong. */
function leafFailed(row: LeafRow): boolean {
  return row.kind === "error" || (row.kind === "tool" && row.isError);
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
          work.push({
            kind: "message",
            key: `msg-${e.id}`,
            id: e.id,
            body: e.body ?? "",
            turnKey: turn.key,
            streaming: false,
            ...(e.at !== undefined ? { at: e.at } : {}),
          });
          break;
        case "tool_use": {
          const row: ToolRow = {
            kind: "tool",
            key: `tool-${e.toolId || e.id}`,
            id: e.id,
            tool: e.tool ?? "",
            input: e.body ?? "",
            isError: false,
            done: false,
            turnKey: turn.key,
            ...(e.toolId !== undefined ? { toolId: e.toolId } : {}),
            ...(e.at !== undefined ? { at: e.at } : {}),
          };
          if (e.toolId) toolBy.set(e.toolId, row);
          work.push(row);
          break;
        }
        case "tool_result": {
          const existing = e.toolId ? toolBy.get(e.toolId) : undefined;
          if (existing) {
            existing.result = e.body ?? "";
            existing.isError = !!e.isError;
            existing.done = true;
          } else {
            work.push({
              kind: "tool",
              key: `tool-${e.toolId || e.id}`,
              id: e.id,
              tool: "",
              input: "",
              result: e.body ?? "",
              isError: !!e.isError,
              done: true,
              turnKey: turn.key,
              ...(e.toolId !== undefined ? { toolId: e.toolId } : {}),
              ...(e.at !== undefined ? { at: e.at } : {}),
            });
          }
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
          work.push({
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
      const fold: TurnFoldRow | null =
        hidden.length > 0
          ? {
              kind: "turn-fold",
              key: `fold-${turn.key}`,
              turnKey: turn.key,
              count: hidden.length,
              hidden,
              hasError: hidden.some(leafFailed),
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
      out.push({
        kind: "working",
        key: `working-${turn.key}`,
        turnKey: turn.key,
        ...(turn.events[0]?.at !== undefined
          ? { startedAt: turn.events[0]!.at }
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
    // `hidden` — the only nested field; compare its rows the same way.
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        if (!sameRow(va[i] as TimelineRow, vb[i] as TimelineRow)) return false;
      }
      continue;
    }
    return false;
  }
  return true;
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
