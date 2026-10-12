/**
 * The lobby's HTTP APIs, called as the user the request came from.
 *
 * Every call relays what the browser's own request carried: the identity
 * header and the proxy secret (auth.ts RelayCredentials). tmux-api and
 * session-events then apply the lobby's own access rules, so the sidecar sees
 * exactly what the lobby would show that user, and a foreign session is
 * addressed with ?owner= the way the Text view addresses one (ADR-0043).
 */
import { PROXY_SECRET_HEADER, type RelayCredentials } from "../auth.ts";

export interface LobbySession {
  readonly id?: string;
  readonly name: string;
  readonly bornAs?: string;
  readonly title?: string;
  readonly state?: string;
  readonly tool?: string;
  readonly owner?: string;
  readonly access?: string;
  readonly project?: string;
  readonly origin?: string;
  readonly caller?: string;
  readonly cwd?: string;
  readonly created: number;
  readonly lastDrive?: number;
  readonly suspendedAt?: number;
}

export interface LobbyLayoutProject {
  readonly name: string;
  readonly sessions: ReadonlyArray<string>;
  readonly dir?: string;
}

export interface LobbyLayout {
  readonly projects: ReadonlyArray<LobbyLayoutProject>;
  readonly ungrouped: ReadonlyArray<string>;
}

/** A refusal from the lobby, with the status and the words it gave. */
export class LobbyError extends Error {
  override readonly name = "LobbyError";
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`lobby answered ${status}: ${body.trim().slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export interface PromptRequest {
  readonly text: string;
  /** promptonce.go: names the prompt across retries, 1-64 of [A-Za-z0-9_-]. */
  readonly id?: string;
  /** Hold until the running turn ends instead of steering (held.go). */
  readonly wait?: boolean;
  readonly awaitReady?: boolean;
}

export interface TakeReply {
  readonly restored: boolean;
  readonly queue: ReadonlyArray<string>;
}

export interface AnswerReply {
  readonly applied?: boolean;
  readonly done?: boolean;
  readonly reason?: string;
}

export interface ModeReply {
  readonly applied?: boolean;
  readonly mode?: string;
  readonly reason?: string;
}

export interface ModelReply {
  readonly model?: string;
  readonly effort?: string;
}

const TIMEOUT_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function parseSessions(raw: unknown): LobbySession[] {
  if (!Array.isArray(raw)) return [];
  const out: LobbySession[] = [];
  for (const entry of raw) {
    const o = asRecord(entry);
    const name = str(o.name);
    if (name === undefined) continue;
    const s: { -readonly [K in keyof LobbySession]: LobbySession[K] } = {
      name,
      created: num(o.created) ?? 0,
    };
    for (const key of [
      "id",
      "bornAs",
      "title",
      "state",
      "tool",
      "owner",
      "access",
      "project",
      "origin",
      "caller",
      "cwd",
    ] as const) {
      const value = str(o[key]);
      if (value !== undefined) s[key] = value;
    }
    const lastDrive = num(o.lastDrive);
    if (lastDrive !== undefined) s.lastDrive = lastDrive;
    const suspendedAt = num(o.suspendedAt);
    if (suspendedAt !== undefined) s.suspendedAt = suspendedAt;
    out.push(s);
  }
  return out;
}

export function parseLayout(raw: unknown): LobbyLayout {
  const o = asRecord(raw);
  const names = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const projects = Array.isArray(o.projects)
    ? o.projects.flatMap((p) => {
        const r = asRecord(p);
        const name = str(r.name);
        if (name === undefined) return [];
        const dir = str(r.dir);
        return [{ name, sessions: names(r.sessions), ...(dir === undefined ? {} : { dir }) }];
      })
    : [];
  return { projects, ungrouped: names(o.ungrouped) };
}

export class LobbyApi {
  readonly #tmuxApi: string;
  readonly #sessionEvents: string;
  readonly #fetch: typeof fetch;

  constructor(options: { tmuxApiUrl: string; sessionEventsUrl: string; fetch?: typeof fetch }) {
    this.#tmuxApi = options.tmuxApiUrl;
    this.#sessionEvents = options.sessionEventsUrl;
    this.#fetch = options.fetch ?? fetch;
  }

  headers(relay: RelayCredentials, extra: Record<string, string> = {}): Record<string, string> {
    return { [relay.header]: relay.identity, [PROXY_SECRET_HEADER]: relay.secret, ...extra };
  }

  /** session-events' URL for a session route, with ?owner= for someone else's session. */
  sessionUrl(
    route: string,
    session: string,
    owner: string | undefined,
    options: { readonly query?: string; readonly tail?: string } = {},
  ): string {
    const params = new URLSearchParams(options.query ?? "");
    if (owner !== undefined) params.set("owner", owner);
    const qs = params.toString();
    return `${this.#sessionEvents}${route}/${encodeURIComponent(session)}${options.tail ?? ""}${qs === "" ? "" : `?${qs}`}`;
  }

  async sessions(relay: RelayCredentials): Promise<LobbySession[]> {
    return parseSessions(await this.#json(relay, `${this.#tmuxApi}/sessions`, "GET"));
  }

  async layout(relay: RelayCredentials): Promise<LobbyLayout> {
    return parseLayout(await this.#json(relay, `${this.#tmuxApi}/layout`, "GET"));
  }

  /** Opens a session's event stream (sse.go). The caller reads and closes the body. */
  async events(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    resume: { readonly lastEventId: number; readonly epoch: string | undefined } | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const query = new URLSearchParams({ rev: "1" });
    if (resume !== undefined && resume.lastEventId > 0) {
      query.set("lastEventId", String(resume.lastEventId));
      if (resume.epoch !== undefined) query.set("epoch", resume.epoch);
    }
    return this.#fetch(this.sessionUrl("/events", session, owner, { query: query.toString() }), {
      headers: this.headers(relay, { accept: "text/event-stream" }),
      signal,
    });
  }

  async prompt(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    body: PromptRequest,
  ): Promise<void> {
    await this.#send(relay, this.sessionUrl("/prompt", session, owner), body, 60_000);
  }

  async cancel(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    restoreQueue: boolean,
  ): Promise<TakeReply> {
    const text = await this.#send(
      relay,
      this.sessionUrl("/cancel", session, owner),
      restoreQueue ? { restoreQueue: ["*"] } : {},
    );
    return parseTake(text);
  }

  async unqueue(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
  ): Promise<TakeReply> {
    return parseTake(
      await this.#send(relay, this.sessionUrl("/prompt", session, owner, { tail: "/unqueue" }), {}),
    );
  }

  async cancelQueued(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    text: string,
  ): Promise<TakeReply> {
    return parseTake(
      await this.#send(
        relay,
        this.sessionUrl("/prompt", session, owner, { tail: "/cancel-queued" }),
        {
          text,
        },
      ),
    );
  }

  async answer(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    body: Readonly<Record<string, unknown>>,
  ): Promise<AnswerReply> {
    const text = await this.#send(relay, this.sessionUrl("/answer", session, owner), body, 60_000);
    const o = asRecord(safeJson(text));
    return {
      ...(typeof o.applied === "boolean" ? { applied: o.applied } : {}),
      ...(typeof o.done === "boolean" ? { done: o.done } : {}),
      ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    };
  }

  async mode(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    mode: string,
  ): Promise<ModeReply> {
    const o = asRecord(
      safeJson(await this.#send(relay, this.sessionUrl("/model", session, owner), { mode })),
    );
    return {
      ...(typeof o.applied === "boolean" ? { applied: o.applied } : {}),
      ...(typeof o.mode === "string" ? { mode: o.mode } : {}),
      ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    };
  }

  async model(
    relay: RelayCredentials,
    session: string,
    owner: string | undefined,
    want: { readonly model?: string; readonly effort?: string },
  ): Promise<ModelReply> {
    const o = asRecord(
      safeJson(
        await this.#send(
          relay,
          this.sessionUrl("/model", session, owner),
          { tool: "claude", model: want.model ?? "", effort: want.effort ?? "" },
          60_000,
        ),
      ),
    );
    return {
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
    };
  }

  /** tmux-api: warms a pre-warm slot for a directory (prewarm.go). */
  async prewarm(
    relay: RelayCredentials,
    body: { readonly dir: string; readonly model?: string; readonly effort?: string },
  ): Promise<void> {
    await this.#send(relay, `${this.#tmuxApi}/sessions/prewarm`, body);
  }

  /** tmux-api: claims a warm slot under a minted name, placing it in a project (claim.go). */
  async claim(
    relay: RelayCredentials,
    body: {
      readonly name: string;
      readonly dir: string;
      readonly model?: string;
      readonly effort?: string;
      readonly project?: string;
    },
  ): Promise<{ readonly claimed: boolean; readonly found: string; readonly placed: boolean }> {
    const o = asRecord(
      safeJson(
        await this.#send(relay, `${this.#tmuxApi}/sessions/claim`, {
          ...body,
          cmd: "claude",
          cols: 120,
          rows: 40,
        }),
      ),
    );
    return {
      claimed: o.claimed === true,
      found: typeof o.found === "string" ? o.found : "",
      placed: o.placed === true,
    };
  }

  async #json(relay: RelayCredentials, url: string, method: string): Promise<unknown> {
    const response = await this.#fetch(url, {
      method,
      headers: this.headers(relay),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new LobbyError(response.status, text);
    return safeJson(text);
  }

  async #send(
    relay: RelayCredentials,
    url: string,
    body: unknown,
    timeoutMs = TIMEOUT_MS,
  ): Promise<string> {
    const response = await this.#fetch(url, {
      method: "POST",
      headers: this.headers(relay, { "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new LobbyError(response.status, text);
    return text;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseTake(text: string): TakeReply {
  const o = asRecord(safeJson(text));
  const queue = Array.isArray(o.queue)
    ? o.queue.filter((q): q is string => typeof q === "string")
    : [];
  return { restored: o.restored === true, queue };
}
