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
  /** Which subagent a `sidechain` event belongs to, when its record says. */
  agentId?: string;
  /** body/result were capped for the wire; the rest is fetched on demand. */
  truncated?: boolean;
  /**
   * How much text a `meta` event whose meta is "skill" stands in for: the
   * length of the SKILL.md body sessionio collapsed to that one line.
   */
  bytes?: number;
  /** A `/context` reading, on `meta` events whose meta is "context". */
  context?: ContextReading;
  /**
   * What the session is answering as, on `meta` events whose meta is "model".
   * Emitted only when the pair changes: every assistant record names it, so a
   * marker per turn would say nothing (sessionio MetaModel).
   */
  model?: ModelState;
  /**
   * Set on ONE event: the user event of the record that opens a conversation
   * the plan approval started by clearing the context. `origin` is
   * `ORIGIN_AUTO_CONTINUATION` and `plan` the approved plan, so the Text view
   * can draw a marker and a plan row instead of the long "Implement the
   * following plan: ..." message the reader never typed. `body` keeps that
   * whole text (sessionio Event.Origin, Event.Plan).
   */
  origin?: string;
  plan?: string;
  /**
   * The pictures a `user` prompt (pasted into the terminal) or a `tool_result`
   * (a Read of an image, a screenshot handed back as a block) carried. The
   * bytes stay in the transcript and are read back by index through the
   * image-block routes (`promptImageUrl`, `toolImageUrl`), so the base64 never
   * crosses the stream and never meets its 8 KiB cap.
   */
  images?: ImageRef[];
  /** The uuid of the user record that carried `images`, which is how the
   *  prompt route finds the record again. Set only alongside `images`. */
  record?: string;
  /**
   * The files a screenshot tool wrote, as absolute paths, on its `tool_result`.
   * The tool links them relative to the directory Claude was started in, and
   * the server resolves them, because the browser never learns that directory.
   */
  files?: string[];
  /**
   * Never on the wire. Set by `withPendingPrompts` on a prompt sent from this
   * browser that the session has not taken yet, which draws dimmed.
   */
  sending?: boolean;
  /**
   * Never on the wire. Set by `withStreaming` (store/stream.ts) on the stand-in
   * for a content block Claude is still writing. Its body is read live from the
   * stream, not from here.
   */
  streaming?: boolean;
}

/**
 * Part of a reply Claude is still writing: the new text of one content block,
 * coalesced to about 50 ms by the mod (ADR-0036 `turn.step`).
 *
 * Live only. It arrives as a plain `data:` line with no `id:`, so it never
 * moves the resume cursor, and no backfill or replay carries it. The stored
 * `text` or `thinking` event for the same block follows with a real id and
 * supersedes it.
 */
export interface StreamDelta {
  kind: "delta";
  session: string;
  turnId: string;
  stream: "text" | "thinking";
  /** The content block's index within the current model response. */
  block: number;
  /** The text to append. */
  body: string;
  /** Set when the delta belongs to a subagent. */
  agentId?: string;
  at?: number;
}

/**
 * One picture block a user prompt or a tool result carried (sessionio
 * `ImageRef`). A reference, never the bytes.
 */
export interface ImageRef {
  /** The block's index among the record's (or the result's) image blocks,
   *  counting from 0, and the index the image-block route takes. */
  n: number;
  /** What the block declared. Advisory: the route sniffs the bytes. */
  mediaType?: string;
  /** The decoded size in bytes. */
  bytes?: number;
  /** The terminal paste id the prompt's text calls `[Image #N]`. Absent when
   *  the record's paste ids did not line up one to one with its blocks. */
  paste?: number;
}

/**
 * `Event.origin` on the record that opens a conversation after the plan
 * approval cleared the context: the transcript's `origin.kind` for it,
 * measured on CLI 2.1.281 on 2026-09-24 (sessionio OriginAutoContinuation).
 */
export const ORIGIN_AUTO_CONTINUATION = "auto-continuation";

/** The model a session answers on, and the effort it answers at. */
export interface ModelState {
  model?: string;
  effort?: string;
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
  | "asking"
  | "held"
  | "model"
  | "command"
  | "rewound"
  | "picture-source";

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
  const o = parseObject(data);
  return o ? eventFrom(o) : null;
}

/**
 * Parse one live `data:` payload: a stored event, or a streaming delta. One
 * JSON parse for both, since every live frame goes through here.
 */
export function parseLive(data: string): Event | StreamDelta | null {
  const o = parseObject(data);
  if (!o) return null;
  return o.kind === "delta" ? deltaFrom(o) : eventFrom(o);
}

function parseObject(data: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function deltaFrom(o: Record<string, unknown>): StreamDelta | null {
  if (typeof o.session !== "string" || typeof o.body !== "string") return null;
  if (o.stream !== "text" && o.stream !== "thinking") return null;
  // sessionio marks `block` and `turnId` omitempty, so the first block of a
  // response arrives with no `block` at all.
  if (o.block !== undefined && typeof o.block !== "number") return null;
  const d: StreamDelta = {
    kind: "delta",
    session: o.session,
    turnId: typeof o.turnId === "string" ? o.turnId : "",
    stream: o.stream,
    block: typeof o.block === "number" ? o.block : 0,
    body: o.body,
  };
  if (typeof o.agentId === "string" && o.agentId) d.agentId = o.agentId;
  if (typeof o.at === "number") d.at = o.at;
  return d;
}

function eventFrom(o: Record<string, unknown>): Event | null {
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
  if (typeof o.bytes === "number") ev.bytes = o.bytes;
  if (o.sidechain === true) ev.sidechain = true;
  if (typeof o.agentId === "string" && o.agentId) ev.agentId = o.agentId;
  if (o.truncated === true) ev.truncated = true;
  if (o.context && typeof o.context === "object") {
    ev.context = o.context as ContextReading;
  }
  if (o.model && typeof o.model === "object") {
    ev.model = o.model as ModelState;
  }
  if (typeof o.origin === "string") ev.origin = o.origin;
  if (typeof o.plan === "string") ev.plan = o.plan;
  const images = Array.isArray(o.images) ? parseImageRefs(o.images) : [];
  if (images.length > 0) ev.images = images;
  if (typeof o.record === "string") ev.record = o.record;
  if (Array.isArray(o.files)) {
    const files = o.files.filter((f): f is string => typeof f === "string");
    if (files.length > 0) ev.files = files;
  }
  return ev;
}

/**
 * The picture references of one event, each copied field by field like the
 * event itself. A reference without a numeric `n` names no block the route can
 * serve, so it is dropped rather than drawn as a broken picture.
 */
function parseImageRefs(raw: readonly unknown[]): ImageRef[] {
  const out: ImageRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.n !== "number") continue;
    const ref: ImageRef = { n: r.n };
    if (typeof r.mediaType === "string") ref.mediaType = r.mediaType;
    if (typeof r.bytes === "number") ref.bytes = r.bytes;
    if (typeof r.paste === "number") ref.paste = r.paste;
    out.push(ref);
  }
  return out;
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
  /** What the session last answered on. Absent until it has answered once. */
  model?: ModelState;
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

/**
 * The session's concurrent work: the agents it spawned and the workflow runs it
 * started, read off the session directory rather than the transcript, which
 * carries none of it (docs/plans/2026-09-12-agent-workflow-visualisation-
 * design.md). Mirrors sessionio.AgentSet.
 *
 * It arrives as the named `agents` frame, once on every open and resume right
 * after `state`, then again whenever the set changes, at most once a second.
 * Nothing in it judges liveness: there is no heartbeat on disk, so the panel
 * shows elapsed time and last activity and never says "stuck".
 */
export interface AgentSet {
  /** Server clock, ms epoch, when this snapshot was built. */
  at: number;
  /** Spawn order: startedAt ascending, then id. */
  agents: AgentInfo[];
  /** Start order. Empty until the server reads workflow runs. */
  workflows: WorkflowInfo[];
}

export type AgentState = "queued" | "running" | "done" | "failed";

/** One agent. Every string is "" and every number 0 when the disk had nothing. */
export interface AgentInfo {
  /** agentId, from the file name agent-<id>.jsonl. */
  id: string;
  description: string;
  name: string;
  agentType: string;
  model: string;
  /** Claude Code's own colour name for the agent, "" when it assigned none. */
  color: string;
  /** meta.spawnDepth as written: 1 for a plain agent the main thread spawned,
   *  0 for a teammate or when absent, 2 or more for one another agent spawned.
   *  Nesting is drawn from parentId, not from this. */
  depth: number;
  /** The agent that spawned this one; "" means the session's main thread. */
  parentId: string;
  toolUseId: string;
  /** "wf_<runId>" for a workflow member, else "". */
  workflowId: string;
  phaseIndex: number;
  /** A workflow member's label, else "". */
  label: string;
  state: AgentState;
  startedAt: number;
  /** When the agent last wrote a record. */
  lastActivityAt: number;
  /** When the state became done or failed, else 0. */
  endedAt: number;
  /** The newest tool_use block's name, "" before the first. */
  tool: string;
  /** A one-line summary of that call's input, at most 120 characters. */
  toolDetail: string;
  toolCalls: number;
  outputTokens: number;
  /** After the agent ends, at most 200 characters of its final text or error. */
  result: string;
  /** Running, with its turn ended to wait on background work of its own: a
   *  Bash sent to the background, a Monitor, an Agent it launched. Absent when
   *  not, and from a server that predates the field. */
  waiting?: boolean;
}

export type WorkflowState = "running" | "done" | "failed" | "killed";

export interface WorkflowPhase {
  index: number;
  title: string;
  detail: string;
}

/** One `Workflow` run. Its members are ordinary entries in `agents`. */
export interface WorkflowInfo {
  /** "wf_<runId>". */
  id: string;
  /** The script's own name (meta.name). */
  name: string;
  /** The script's description (meta.description). */
  summary: string;
  state: WorkflowState;
  startedAt: number;
  /** 0 while running. */
  endedAt: number;
  phases: WorkflowPhase[];
  /** The highest phaseIndex with a running member, else the highest started. */
  currentPhase: number;
  agentCount: number;
  /** The run file's totalTokens, which counts input and cache tokens too. */
  tokens: number;
  toolCalls: number;
}

const AGENT_STATES: ReadonlySet<string> = new Set<AgentState>([
  "queued",
  "running",
  "done",
  "failed",
]);
const WORKFLOW_STATES: ReadonlySet<string> = new Set<WorkflowState>([
  "running",
  "done",
  "failed",
  "killed",
]);

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseAgent(v: unknown): AgentInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = text(o.id);
  if (!id) return null;
  return {
    id,
    description: text(o.description),
    name: text(o.name),
    agentType: text(o.agentType),
    model: text(o.model),
    color: text(o.color),
    depth: count(o.depth),
    parentId: text(o.parentId),
    toolUseId: text(o.toolUseId),
    workflowId: text(o.workflowId),
    phaseIndex: count(o.phaseIndex),
    label: text(o.label),
    // A state this client does not know is never read as live work: claiming
    // an agent is running is the one thing the panel must not guess.
    state: AGENT_STATES.has(text(o.state)) ? (o.state as AgentState) : "done",
    startedAt: count(o.startedAt),
    lastActivityAt: count(o.lastActivityAt),
    endedAt: count(o.endedAt),
    tool: text(o.tool),
    toolDetail: text(o.toolDetail),
    toolCalls: count(o.toolCalls),
    outputTokens: count(o.outputTokens),
    result: text(o.result),
    ...(o.waiting === true ? { waiting: true } : {}),
  };
}

function parsePhase(v: unknown): WorkflowPhase | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { index: count(o.index), title: text(o.title), detail: text(o.detail) };
}

function parseWorkflow(v: unknown): WorkflowInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = text(o.id);
  if (!id) return null;
  const phases = Array.isArray(o.phases) ? o.phases.map(parsePhase) : [];
  return {
    id,
    name: text(o.name),
    summary: text(o.summary),
    state: WORKFLOW_STATES.has(text(o.state)) ? (o.state as WorkflowState) : "done",
    startedAt: count(o.startedAt),
    endedAt: count(o.endedAt),
    phases: phases.filter((p): p is WorkflowPhase => p !== null),
    currentPhase: count(o.currentPhase),
    agentCount: count(o.agentCount),
    tokens: count(o.tokens),
    toolCalls: count(o.toolCalls),
  };
}

/**
 * Parse one `agents` frame into an AgentSet, or null when it is not one.
 *
 * Every field is filled in, so nothing downstream has to ask whether a string
 * is there. An entry with no id is dropped rather than rendered as a row that
 * cannot be told from the next one. A `null` list, which is what a nil Go
 * slice marshals to, reads as an empty one.
 */
export function parseAgentSet(data: string): AgentSet | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const agents = Array.isArray(o.agents) ? o.agents.map(parseAgent) : [];
  const workflows = Array.isArray(o.workflows) ? o.workflows.map(parseWorkflow) : [];
  return {
    at: count(o.at),
    agents: agents.filter((a): a is AgentInfo => a !== null),
    workflows: workflows.filter((w): w is WorkflowInfo => w !== null),
  };
}
