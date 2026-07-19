/**
 * Shared event types — mirror the Go wire contract EXACTLY.
 *
 * Source of truth: session-events/event.go (`type Event struct`) and
 * session-events/permission.go. Field names, optionality and the `kind`
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
  return ev;
}
