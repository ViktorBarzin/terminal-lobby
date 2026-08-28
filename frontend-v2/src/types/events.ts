/**
 * Shared event types — mirror the Go wire contract EXACTLY.
 *
 * Source of truth: sessionio/event.go (`type Event struct`) — all of it. It
 * moved out of session-events into the shared sessionio package.
 * This file used to cite a second source, the web-mediated permission broker;
 * 575d4f5 deleted that broker, and the file it lived in. event.go still
 * declares the permission_request / permission_resolved kinds, so the union
 * below stays faithful to the wire, but nothing emits them today and there is
 * no route to resolve one. Field names, optionality and the `kind`
 * discriminator strings are load-bearing across the wire — do not rename.
 *
 * Go → TS mapping notes:
 *   - Go `int64` ids/timestamps → TS `number` (ids are small monotonic seqs).
 *   - Go `omitempty` fields → optional (`?`) here.
 *   - `body` is a plain string on the wire (JSON-encoded tool input arrives as a
 *     string; tool_result / text arrive as decoded strings; permission_resolved
 *     `body` is the decision string).
 */

/** The `kind` discriminator. Matches the Go `Kind` constants verbatim. */
export type EventKind =
  | "session"
  | "user"
  | "text"
  | "thinking"
  | "meta"
  | "tool_use"
  | "tool_result"
  | "result"
  | "state"
  | "permission_request"
  | "permission_resolved"
  | "error"
  | "turn_end";

/** The renderer's event contract — one normalized event off the SSE stream. */
export interface Event {
  id: number;
  kind: EventKind;
  session: string;
  turnId?: string;
  body?: string;
  tool?: string;
  toolId?: string;
  reqId?: string;
  isError?: boolean;
  at?: number;
  /** `toolUseResult` — the structured result (stdout/stderr, structuredPatch). */
  result?: unknown;
  /** `message.usage` from the assistant message that closed the turn. */
  usage?: TokenUsage;
  /** Set on `meta` events only. */
  meta?: MetaKind;
  /** Subagent work, nested rather than interleaved. */
  sidechain?: boolean;
  /** body/result were capped for the wire; the rest is fetched on demand. */
  truncated?: boolean;
  /** A `/context` reading, on `meta` events whose meta is "context". */
  context?: ContextReading;
}

/** One row of the `/context` usage-by-category table. */
export interface ContextCategory {
  name: string;
  tokens: number;
  percent: number;
}

/**
 * A `/context` reading, as the CLI published it.
 *
 * The numbers are its own rounded display values — 65.2k arrives as 65,200 —
 * because the point of reading `/context` rather than doing the arithmetic is
 * that the CLI knows the ceiling and we do not: it is not on the wire, and it is
 * not a constant (a session on this box reads 65.2k / 1m).
 */
export interface ContextReading {
  model?: string;
  usedTokens: number;
  maxTokens: number;
  percent: number;
  categories?: ContextCategory[];
}

/** One search hit. `id` is the event to scroll to, in the same id space the
 *  stream and Last-Event-ID use. */
export interface SearchHit {
  id: number;
  kind: EventKind;
  tool?: string;
  /** Where the match was: message | thinking | input | result. */
  field: string;
  snippet: string;
  at?: number;
}

/** The subtype of a `meta` event — the session's lifecycle, not its content. */
export type MetaKind =
  | "mode"
  | "permission-mode"
  | "queued"
  | "unqueued"
  | "dequeued"
  | "queue-cleared"
  | "skill"
  | "compact"
  | "hook-error"
  | "context"
  | "asking";

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Permission decision the web client can POST. Matches Go DecisionAllow/Deny. */
export type PermissionDecision = "allow" | "deny";

/**
 * Parse + validate one SSE `data:` payload into an Event. Returns null for
 * anything that isn't a well-formed event (malformed JSON, missing id/kind),
 * so a single bad frame can never poison the store.
 */
const KINDS: ReadonlySet<string> = new Set<EventKind>([
  "session",
  "user",
  "text",
  "thinking",
  "meta",
  "tool_use",
  "tool_result",
  "result",
  "state",
  "permission_request",
  "permission_resolved",
  "error",
  "turn_end",
]);

export function parseEvent(data: string): Event | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "number" || typeof o.kind !== "string") return null;
  if (!KINDS.has(o.kind)) return null;
  if (typeof o.session !== "string") return null;
  const ev: Event = { id: o.id, kind: o.kind as EventKind, session: o.session };
  if (typeof o.turnId === "string") ev.turnId = o.turnId;
  if (typeof o.body === "string") ev.body = o.body;
  if (typeof o.tool === "string") ev.tool = o.tool;
  if (typeof o.toolId === "string") ev.toolId = o.toolId;
  if (typeof o.reqId === "string") ev.reqId = o.reqId;
  if (typeof o.isError === "boolean") ev.isError = o.isError;
  if (typeof o.at === "number") ev.at = o.at;
  if (o.result !== undefined) ev.result = o.result;
  if (o.usage && typeof o.usage === "object") ev.usage = o.usage as TokenUsage;
  if (typeof o.meta === "string") ev.meta = o.meta as MetaKind;
  if (o.sidechain === true) ev.sidechain = true;
  if (o.truncated === true) ev.truncated = true;
  if (o.context && typeof o.context === "object") {
    ev.context = o.context as ContextReading;
  }
  return ev;
}

/**
 * The session state a bounded backfill cannot carry.
 *
 * The permission mode, the newest `/context` reading and the prompt queue are
 * folded from the whole conversation rather than read off a row, so a client
 * holding the last 100 KB cannot derive them — and the queue is the one that
 * goes WRONG rather than merely short, because a `dequeued` whose `queued` fell
 * outside the window takes the head off a queue that never held it.
 *
 * session-events computes all of it over its in-memory log and sends it once,
 * ahead of the backfill. `at` is the newest event id it accounts for: a reader
 * seeds from this and folds only what is newer, so nothing inside the window is
 * applied twice. Mirrors sessionio.SessionState.
 */
export interface SessionState {
  at: number;
  mode?: string;
  context?: ContextReading;
  contextTurnsAgo?: number;
  queue: string[];
  prompts: string[];
}

/** The end of the opening exchange. `cursor` is where the next step back
 *  begins, and is absent on a resume — there the client's own is correct. */
export interface ReadyFrame {
  cursor?: number;
  /** The newest id in the server's log for this session. */
  head?: number;
  /** Which log those ids belong to — a new transcript is a new epoch. */
  epoch?: string;
}
