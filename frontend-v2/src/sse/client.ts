import {
  parseEvent,
  type Event,
  type ReadyFrame,
  type SessionState,
} from "../types/events";

export type { ReadyFrame, SessionState };

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

/** A named frame's JSON payload, or null when it is not an object at all. */
function parseJSON<T>(data: string): T | null {
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** The status session-events returns when a session has no event stream. */
const NO_STREAM_STATUS = 404;

/** How long a classification probe may take before its answer stops mattering. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * How long a stream may go silent before a wake signal stops trusting it.
 * session-events heartbeats every 20s (session-events/main.go `-heartbeat`), so
 * two missed beats is the natural window — but note the heartbeat is a `:`
 * COMMENT, and the SSE spec has EventSource *ignore* comment lines entirely, so
 * the browser never surfaces one to us. Silence therefore does not prove a
 * stream is dead, only that it is UNVERIFIED, which is why this window gates a
 * wake-triggered revalidation rather than a standalone stall timer: an idle
 * session is silent for hours and must not be torn down for it.
 */
const DEFAULT_STALL_MS = 45000;

/**
 * Read the stream endpoint's HTTP status without consuming it. EventSource
 * hides the status behind an opaque `error` event, so this is the only way the
 * client can tell "there is nothing here" from "the connection dropped".
 * Returns null when the endpoint could not be reached at all (unknown → treat
 * as transient).
 *
 * The timeout is not a nicety: classifyFailure() awaits this with the source
 * already closed and no timer armed, so a request that never settles — the
 * signature of a half-open mobile network — stalls the client permanently.
 * Aborting turns that into a plain "unknown", which routes to the normal
 * reconnect ladder. The signal also bounds the body release below: aborting
 * errors the response stream, so a hung cancel() cannot outlive it either.
 */
export async function probeViaFetch(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(timeoutMs),
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
  /** Named events. Optional so a stub that only speaks `onmessage` still
   *  satisfies this — the only named event is `ready`, and a stream that never
   *  sends it is handled by a timeout rather than by waiting forever. */
  addEventListener?: (type: string, fn: (ev: { data: string }) => void) => void;
  close(): void;
}

export interface SseClientOptions {
  session: string;
  /** builds the stream URL, carrying the resume cursor (see lib/config). */
  url: (session: string, lastEventId: number) => string;
  onEvent: (e: Event) => void;
  /**
   * One frame of the opening backfill — history, newest first.
   *
   * A separate lane from `onEvent` because the two arrive in opposite
   * directions. The live lane dedups with `id <= cursor`, which is correct
   * while ids only ever rise; applied to a DESCENDING backfill it would drop
   * every frame after the first.
   */
  onBackfill?: (e: Event) => void;
  /** The session state frame, computed over the whole log (see SessionState). */
  onState?: (s: SessionState) => void;
  /**
   * The history held is not this session's any more — drop it.
   *
   * Called when the stream comes back on a log that is not the one this client
   * was reading (see `ready`), just before it re-opens from the start. Without
   * it the store would keep the previous conversation and paint the new one
   * underneath it.
   */
  onReset?: () => void;
  onStatus?: (s: SseStatus) => void;
  /**
   * The opening window is complete — everything the server had when the stream
   * opened has been delivered, and what follows is live.
   *
   * A client cannot tell that from the events alone: they just stop for a
   * moment. Without it the transcript paints a partial window and rebuilds it
   * as the rest lands (see store/session.ts).
   */
  onReady?: (r: ReadyFrame) => void;
  /** injectable for tests; defaults to the browser EventSource. */
  createSource?: (url: string) => EventSourceLike;
  /** reads the stream URL's HTTP status (null = unreachable). Injectable so
   *  tests and Node callers can supply the ingress' auth header. */
  probeStatus?: (url: string) => Promise<number | null>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
  /** wall clock, injectable so tests can age a connection without waiting. */
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** how often to re-check a session whose stream does not exist yet. */
  probeIntervalMs?: number;
  /** silence after which a wake signal stops trusting an open source. */
  stallTimeoutMs?: number;
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
 *   online — the two moments a mobile client most wants to catch up fast. Those
 *   are also the moments a socket most often died unannounced, so a source that
 *   has gone silent past the stall window is rebuilt rather than trusted.
 * - Dedups by id: the server replays from the cursor, so a resumed connection
 *   only surfaces events with id greater than the last one delivered.
 */
export class SseClient {
  private readonly o: Required<
    Omit<
      SseClientOptions,
      "onStatus" | "createSource" | "onReady" | "onBackfill" | "onState" | "onReset"
    >
  > &
    Pick<
      SseClientOptions,
      "onStatus" | "createSource" | "onReady" | "onBackfill" | "onState" | "onReset"
    >;
  private source: EventSourceLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastEventId = 0;
  /** Which log the held ids belong to — the server's `ready.epoch`. */
  private epoch = "";
  /** when the live source last proved itself; only read while one exists. */
  private lastActivityAt = 0;
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
      onReady: opts.onReady,
      onBackfill: opts.onBackfill,
      onState: opts.onState,
      onReset: opts.onReset,
      createSource: opts.createSource,
      probeStatus: opts.probeStatus ?? probeViaFetch,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((id) => clearTimeout(id)),
      random: opts.random ?? Math.random,
      now: opts.now ?? (() => Date.now()),
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 15000,
      probeIntervalMs: opts.probeIntervalMs ?? 30000,
      stallTimeoutMs: opts.stallTimeoutMs ?? DEFAULT_STALL_MS,
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
    // A source that never opens is as stale as one that stopped delivering, so
    // the liveness clock starts at creation, not at onopen.
    this.markAlive();
    es.onopen = () => {
      this.attempt = 0;
      this.markAlive();
      this.setStatus("open");
    };
    es.onmessage = (ev) => {
      // Anything the socket delivered is proof of life — including a frame this
      // client then throws away, so record it before the parse and dedup gates.
      this.markAlive();
      const e = parseEvent(ev.data);
      if (!e) return;
      if (e.id <= this.lastEventId) return; // already delivered via replay
      this.lastEventId = e.id;
      this.o.onEvent(e);
    };
    // History, newest first. No `id:` on these frames — the browser would take
    // the OLDEST as Last-Event-ID — so the cursor is read off the payload, and
    // only ever raised: a reconnect must ask for the gap above the newest event
    // held, never replay from the bottom of the backfill.
    es.addEventListener?.("back", (ev) => {
      this.markAlive();
      const e = parseEvent(ev.data);
      if (!e) return;
      if (e.id > this.lastEventId) this.lastEventId = e.id;
      this.o.onBackfill?.(e);
    });
    es.addEventListener?.("state", (ev) => {
      this.markAlive();
      const s = parseJSON<SessionState>(ev.data);
      if (s) this.o.onState?.(s);
    });
    es.addEventListener?.("ready", (ev) => {
      this.markAlive();
      // A server on the older contract sends the last replayed id here, which
      // parses as a number rather than an object; either way the frame only
      // has to mean "the opening exchange is over".
      const frame = parseJSON<ReadyFrame>(ev.data) ?? {};
      if (this.foreignLog(frame)) {
        this.resync();
        return;
      }
      if (frame.epoch) this.epoch = frame.epoch;
      this.o.onReady?.(frame);
    });
    es.onerror = () => this.onError();
  }

  private markAlive(): void {
    this.lastActivityAt = this.o.now();
  }

  /**
   * Is the log that just opened a different one from the ids we hold?
   *
   * Ids are per-source. The same transcript replayed by a new process assigns
   * the same ids, which is why a deploy costs a reader nothing — but a NEW
   * transcript under the same session name (a new Claude in that tmux window, a
   * stamp corrected after the fact) starts again at 1. A client holding id
   * 5,000 then asks for the gap above 5,000 and is answered with nothing, which
   * on the wire is indistinguishable from being up to date. It sat there
   * showing the previous conversation for as long as the tab stayed open, and a
   * question card docked at that moment stayed docked over a dialog that had
   * been answered in the terminal minutes before.
   *
   * Two signals, and either is enough. The epoch names the transcript. The head
   * id covers the narrower case where the same log comes back SHORTER than the
   * cursor we hold — a restart does not replay the permission events that were
   * injected into the id space, so the ids can move down under us.
   *
   * A server that sends neither is one from before this contract: nothing is
   * claimed, and the client behaves exactly as it did.
   */
  private foreignLog(frame: ReadyFrame): boolean {
    if (this.lastEventId === 0) return false; // nothing held, nothing to lose
    if (frame.epoch && this.epoch && frame.epoch !== this.epoch) return true;
    return typeof frame.head === "number" && frame.head > 0 && frame.head < this.lastEventId;
  }

  /** Drop everything held and open the session again from the start. */
  private resync(): void {
    this.epoch = "";
    this.lastEventId = 0;
    this.closeSource();
    this.o.onReset?.();
    this.attempt = 0;
    this.clearTimer();
    this.connect();
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

  /**
   * Reconnect now, resetting backoff — used on tab-visible / network-online.
   *
   * Both triggers mark a moment a socket commonly died without the browser
   * noticing: a phone that slept, or a network that changed under an
   * established connection. Such a stream fires no error, so `this.source` is
   * still set and simply never delivers again — and bailing out on a live
   * source stranded the client on exactly that. A source silent past the stall
   * window is therefore dropped and rebuilt; one that just delivered is left
   * alone, since reconnecting mid-turn is a visible stall for no gain. Guessing
   * wrong is cheap: the reconnect resumes from the cursor and the id dedup
   * discards whatever the replay repeats.
   */
  instantRetry(): void {
    if (this.stopped) return;
    if (this.source) {
      const silentFor = this.o.now() - this.lastActivityAt;
      if (silentFor < this.o.stallTimeoutMs) return; // still delivering
      this.closeSource();
    }
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
