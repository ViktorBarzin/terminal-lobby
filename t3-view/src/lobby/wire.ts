/**
 * The lobby's wire, as session-events and tmux-api send it.
 *
 * The event shape mirrors sessionio/event.go (`Event`) and the frames mirror
 * session-events/sse.go: `state` (sessionio.SessionState), `ready`, `epoch`,
 * `back` (a backfill event, newest first), `head`, `agents`, and from
 * nomod.go `nomod` and `starting`. Default (unnamed) frames carry a stored
 * event or a live `delta`.
 *
 * Every parser returns undefined for something it does not recognise, so one
 * odd frame never takes a thread down.
 */

export type LobbyEventKind =
  | "session"
  | "user"
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "result"
  | "state"
  | "meta"
  | "permission_request"
  | "permission_resolved"
  | "error"
  | "turn_end"
  | "delta";

const KINDS: ReadonlySet<string> = new Set<LobbyEventKind>([
  "session",
  "user",
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "result",
  "state",
  "meta",
  "permission_request",
  "permission_resolved",
  "error",
  "turn_end",
  "delta",
]);

export interface ModelState {
  readonly model?: string;
  readonly effort?: string;
}

export interface LobbyEvent {
  readonly id: number;
  readonly kind: LobbyEventKind;
  readonly session: string;
  readonly turnId?: string;
  readonly body?: string;
  readonly tool?: string;
  readonly toolId?: string;
  readonly isError?: boolean;
  readonly at?: number;
  readonly result?: unknown;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly meta?: string;
  readonly sidechain?: boolean;
  readonly agentId?: string;
  readonly truncated?: boolean;
  readonly model?: ModelState;
  readonly origin?: string;
  readonly plan?: string;
  readonly steer?: boolean;
  /** On a delta: "text" or "thinking". */
  readonly stream?: string;
  /** On a delta: the content block's index in the response. */
  readonly block?: number;
}

export interface SessionState {
  readonly at: number;
  readonly mode?: string;
  readonly model?: ModelState;
  readonly queue: ReadonlyArray<string>;
  readonly prompts: ReadonlyArray<string>;
}

export interface ReadyFrame {
  readonly cursor?: number;
  readonly head: number;
  readonly epoch?: string;
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

type Json = Record<string, unknown>;

function object(data: string): Json | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Json) : undefined;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function modelState(value: unknown): ModelState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { model, effort } = value as Json;
  const out: { model?: string; effort?: string } = {};
  if (typeof model === "string" && model !== "") out.model = model;
  if (typeof effort === "string" && effort !== "") out.effort = effort;
  return out;
}

export function parseLobbyEvent(data: string): LobbyEvent | undefined {
  const o = object(data);
  if (o === undefined) return undefined;
  const id = num(o.id);
  const kind = str(o.kind);
  const session = str(o.session);
  if (id === undefined || kind === undefined || !KINDS.has(kind) || session === undefined) {
    return undefined;
  }
  const event: { -readonly [K in keyof LobbyEvent]: LobbyEvent[K] } = {
    id,
    kind: kind as LobbyEventKind,
    session,
  };
  const set = <K extends keyof LobbyEvent>(key: K, value: LobbyEvent[K] | undefined) => {
    if (value !== undefined) event[key] = value;
  };
  set("turnId", str(o.turnId));
  set("body", str(o.body));
  set("tool", str(o.tool));
  set("toolId", str(o.toolId));
  if (o.isError === true) event.isError = true;
  set("at", num(o.at));
  if (o.result !== undefined) event.result = o.result;
  if (typeof o.usage === "object" && o.usage !== null) event.usage = o.usage as Json;
  set("meta", str(o.meta));
  if (o.sidechain === true) event.sidechain = true;
  const agentId = str(o.agentId);
  if (agentId !== undefined && agentId !== "") event.agentId = agentId;
  if (o.truncated === true) event.truncated = true;
  set("model", modelState(o.model));
  set("origin", str(o.origin));
  set("plan", str(o.plan));
  if (o.steer === true) event.steer = true;
  set("stream", str(o.stream));
  set("block", num(o.block));
  return event;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseSessionState(data: string): SessionState | undefined {
  const o = object(data);
  const at = o === undefined ? undefined : num(o.at);
  if (o === undefined || at === undefined) return undefined;
  const out: { -readonly [K in keyof SessionState]: SessionState[K] } = {
    at,
    queue: strings(o.queue),
    prompts: strings(o.prompts),
  };
  const mode = str(o.mode);
  if (mode !== undefined && mode !== "") out.mode = mode;
  const model = modelState(o.model);
  if (model !== undefined) out.model = model;
  return out;
}

export function parseReadyFrame(data: string): ReadyFrame | undefined {
  const o = object(data);
  if (o === undefined) return undefined;
  const head = num(o.head);
  if (head === undefined) return undefined;
  const out: { -readonly [K in keyof ReadyFrame]: ReadyFrame[K] } = { head };
  const cursor = num(o.cursor);
  if (cursor !== undefined) out.cursor = cursor;
  const epoch = str(o.epoch);
  if (epoch !== undefined && epoch !== "") out.epoch = epoch;
  return out;
}

export function parseEpochFrame(data: string): string | undefined {
  const epoch = str(object(data)?.epoch);
  return epoch === undefined || epoch === "" ? undefined : epoch;
}

/** nomod.go's two frames: why the session has no stream yet. */
export type NoStream =
  | { readonly kind: "starting"; readonly waitS: number }
  | { readonly kind: "exited" }
  | { readonly kind: "restart-when-idle" };

export function parseNoStream(event: string, data: string): NoStream | undefined {
  const o = object(data);
  if (o === undefined) return undefined;
  if (event === "starting") return { kind: "starting", waitS: num(o.waitS) ?? 0 };
  if (event !== "nomod") return undefined;
  if (o.claude === "exited") return { kind: "exited" };
  return { kind: "restart-when-idle" };
}

/**
 * An incremental text/event-stream parser: feed it chunks, get whole frames.
 * Comment lines (": hb") are dropped; `event` defaults to "message".
 */
export class SseParser {
  #buffer = "";

  feed(chunk: string): SseFrame[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return undefined;
  return id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id };
}
