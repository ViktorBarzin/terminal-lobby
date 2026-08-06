import { parseEvent, type Event } from "../types/events";

/**
 * Connection status.
 *
 * `no-transcript` is NOT a failure: session-events answers
 * `404 session not registered` for a tmux session no Claude ever ran in
 * (session-events/main.go), and Text mode is the default view for EVERY
 * session — so a plain shell lands on this state by design. It is terminal
 * until the session registers, which is why it is distinct from
 * `reconnecting`.
 */
export type SseStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "no-transcript"
  | "closed";

/** The status session-events returns when a session has no event stream. */
const NO_STREAM_STATUS = 404;

/**
 * Read the stream endpoint's HTTP status without consuming it. EventSource
 * hides the status behind an opaque `error` event, so this is the only way the
 * client can tell "there is nothing here" from "the connection dropped".
 * Returns null when the endpoint could not be reached at all (unknown → treat
 * as transient).
 */
async function probeViaFetch(url: string): Promise<number | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
    });
    // A 200 here is a LIVE stream; cancelling releases it immediately so the
    // EventSource — not this probe — is what actually reads the events.
    try {
      await res.body?.cancel();
    } catch {
      /* already closed */
    }
    return res.status;
  } catch {
    return null;
  }
}

/** Minimal EventSource surface — abstracted so tests inject a fake. */
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  close(): void;
}

export interface SseClientOptions {
  session: string;
  /** builds the stream URL, carrying the resume cursor (see lib/config). */
  url: (session: string, lastEventId: number) => string;
  onEvent: (e: Event) => void;
  onStatus?: (s: SseStatus) => void;
  /** injectable for tests; defaults to the browser EventSource. */
  createSource?: (url: string) => EventSourceLike;
  /** reads the stream URL's HTTP status (null = unreachable). Injectable so
   *  tests and Node callers can supply the ingress' auth header. */
  probeStatus?: (url: string) => Promise<number | null>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** how often to re-check a session whose stream does not exist yet. */
  probeIntervalMs?: number;
}

/**
 * Resumable SSE client for a single session's event stream.
 *
 * - Resumes via the Last-Event-ID cursor (carried in the URL query, since we
 *   recreate the source on every reconnect — see lib/config.eventsUrl).
 * - Reconnects with exponential backoff + jitter; native EventSource auto-retry
 *   is disabled (we close on error and drive reconnection ourselves).
 * - Classifies a failure before reacting to it: a 404 means the session has no
 *   transcript to stream, so the ladder stops and the status says so instead of
 *   retrying a permanent condition forever. A slow re-probe keeps a session
 *   that registers LATER from being stranded.
 * - Instant retry when the tab becomes visible or the network comes back
 *   online — the two moments a mobile client most wants to catch up fast.
 * - Dedups by id: the server replays from the cursor, so a resumed connection
 *   only surfaces events with id greater than the last one delivered.
 */
export class SseClient {
  private readonly o: Required<
    Omit<SseClientOptions, "onStatus" | "createSource">
  > &
    Pick<SseClientOptions, "onStatus" | "createSource">;
  private source: EventSourceLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastEventId = 0;
  private stopped = false;
  private status: SseStatus = "connecting";
  private readonly onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      this.instantRetry();
    }
  };
  private readonly onOnline = () => this.instantRetry();

  constructor(opts: SseClientOptions) {
    this.o = {
      session: opts.session,
      url: opts.url,
      onEvent: opts.onEvent,
      onStatus: opts.onStatus,
      createSource: opts.createSource,
      probeStatus: opts.probeStatus ?? probeViaFetch,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((id) => clearTimeout(id)),
      random: opts.random ?? Math.random,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 15000,
      probeIntervalMs: opts.probeIntervalMs ?? 30000,
    };
  }

  /** The highest event id delivered so far (the resume cursor). */
  get cursor(): number {
    return this.lastEventId;
  }

  private setStatus(s: SseStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus?.(s);
  }

  private defaultCreate(url: string): EventSourceLike {
    if (typeof EventSource === "undefined") {
      throw new Error("EventSource is not available in this environment");
    }
    return new EventSource(url) as unknown as EventSourceLike;
  }

  /** Open the stream and start listening. Idempotent while a source is live. */
  connect(): void {
    if (this.stopped || this.source) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const create = this.o.createSource ?? this.defaultCreate.bind(this);
    const es = create(this.o.url(this.o.session, this.lastEventId));
    this.source = es;
    es.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };
    es.onmessage = (ev) => {
      const e = parseEvent(ev.data);
      if (!e) return;
      if (e.id <= this.lastEventId) return; // already delivered via replay
      this.lastEventId = e.id;
      this.o.onEvent(e);
    };
    es.onerror = () => this.onError();
  }

  private onError(): void {
    if (this.stopped) return;
    this.closeSource();
    void this.classifyFailure();
  }

  /**
   * Ask the server what the failure MEANT before reacting to it. EventSource
   * reports every failure identically, so without this a permanent 404 ("this
   * session has no transcript") is indistinguishable from a dropped connection
   * and gets the same endless retry ladder.
   */
  private async classifyFailure(): Promise<void> {
    const status = await this.o.probeStatus(
      this.o.url(this.o.session, this.lastEventId),
    );
    // close() or an instantRetry may have overtaken the probe.
    if (this.stopped || this.source) return;
    if (status === NO_STREAM_STATUS) this.enterNoTranscript();
    else this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const backoff = Math.min(
      this.o.maxDelayMs,
      this.o.baseDelayMs * 2 ** (this.attempt - 1),
    );
    // Full jitter in [backoff/2, backoff] avoids reconnection thundering herds.
    const delay = backoff / 2 + this.o.random() * (backoff / 2);
    this.setStatus("reconnecting");
    this.clearTimer();
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /**
   * There is no stream for this session. Leave the retry ladder, report the
   * state honestly, and re-check on a slow timer — a session becomes
   * registered the moment a Claude starts in it (POST /hooks/session-start),
   * and that must still be picked up.
   */
  private enterNoTranscript(): void {
    this.attempt = 0; // the next real connect is a first attempt, not a retry
    this.setStatus("no-transcript");
    this.clearTimer();
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.reprobe();
    }, this.o.probeIntervalMs);
  }

  private async reprobe(): Promise<void> {
    if (this.stopped || this.source) return;
    const status = await this.o.probeStatus(
      this.o.url(this.o.session, this.lastEventId),
    );
    if (this.stopped || this.source) return;
    if (status === NO_STREAM_STATUS) this.enterNoTranscript();
    else this.connect(); // registered (or unknown) → back to the normal path
  }

  /** Reconnect now, resetting backoff — used on tab-visible / network-online. */
  instantRetry(): void {
    if (this.stopped || this.source) return; // already connected/connecting
    this.attempt = 0;
    this.clearTimer();
    this.connect();
  }

  /** Attach visibility/online instant-retry listeners. No-op off-browser. */
  start(): void {
    this.stopped = false;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisible);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
    this.connect();
  }

  /** Permanently stop: remove listeners, cancel timers, close the source. */
  close(): void {
    this.stopped = true;
    this.clearTimer();
    this.closeSource();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    this.setStatus("closed");
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.o.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private closeSource(): void {
    if (this.source) {
      this.source.onopen = null;
      this.source.onmessage = null;
      this.source.onerror = null;
      try {
        this.source.close();
      } catch {
        /* already closed */
      }
      this.source = null;
    }
  }
}
