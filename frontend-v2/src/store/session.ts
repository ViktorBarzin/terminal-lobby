import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import {
  SseClient,
  type ReadyFrame,
  type SessionState,
  type SseStatus,
} from "../sse/client";
import { track } from "../telemetry/track";
import {
  createTranscriptCache,
  indexedDbBackend,
  resumeCursor,
  type TranscriptCache,
} from "./transcript-cache";
import {
  cancelUrl,
  earlierUrl,
  eventsUrl,
  keysUrl,
  commandsUrl,
  paneUrl,
  permissionUrl,
  promptUrl,
  resultUrl,
  answerTextUrl,
  searchUrl,
} from "../lib/config";
import type { Event, PermissionDecision, SearchHit } from "../types/events";
import {
  isSlashCommand,
  sameCommand,
  type PendingPrompt,
  type SlashCommand,
} from "../components/compose.logic";
import { fetchWithDeadline } from "../lib/http";

/**
 * Transcript reads move real bytes — loadEarlier asks for up to 400KB
 * (EARLIER_STEPS_BYTES) and a full tool result is whatever the wire cap left
 * behind — so they get a longer deadline than the interactive calls beside
 * them, which are all a keystroke or a short JSON body.
 */
const TRANSCRIPT_READ_TIMEOUT_MS = 30_000;

export interface SessionStore {
  /** Reactive, ordered, deduped event list (Solid store proxy). */
  events: Event[];
  /** SSE connection status. */
  status: Accessor<SseStatus>;
  /** Open the transcript stream. Idempotent, and one-way: the first call
   *  connects, every later one is a no-op, and a call after close() leaves the
   *  store closed. Callers that construct with `autoStart: false` own the
   *  moment of the first connect (see the option). */
  start: () => void;
  /** Resolve a permission request. Returns true on the backend's 204. */
  resolvePermission: (
    reqId: string,
    decision: PermissionDecision,
  ) => Promise<boolean>;
  /** Send a prompt (provisional control endpoint — see blockers). Resolves
   *  false when the session refused it (409 mid-turn, 5xx, unreachable) so the
   *  composer can hand the typed text back instead of destroying it. */
  send: (text: string) => Promise<boolean>;
  /** Interrupt the running turn (provisional control endpoint). */
  interrupt: () => Promise<void>;
  /** Type an answer into the session's pane (ADR-0010). Returns true on 204. */
  answer: (keys: string[]) => Promise<boolean>;
  /** Read what the pane shows, for mirroring a blocking prompt. */
  pane: () => Promise<{ pane: string; state: string } | null>;
  /** Type free text into the pane WITHOUT submitting it — how the "Other"
   *  option of an AskUserQuestion is answered. Returns true on 204. */
  answerText: (text: string) => Promise<boolean>;
  /** Find text anywhere in the session. The server searches the whole
   *  transcript, not the window held here. */
  search: (q: string) => Promise<SearchHit[]>;
  /** The session's own slash commands, beyond the built-ins the page ships. */
  commands: () => Promise<SlashCommand[]>;
  /** Prompts sent from here that the transcript has not shown yet. */
  pendingPrompts: () => PendingPrompt[];
  /** True until the opening window has arrived — "not yet", not "nothing". */
  opening: () => boolean;
  /** One tool result in full, after the wire capped it. */
  fullResult: (toolId: string) => Promise<string | null>;
  /** Take one step further back through the transcript. Returns how many
   *  events arrived — 0 means the start of the session has been reached. */
  loadEarlier: (bytes?: number) => Promise<number>;
  /** False once paging has reached the start of the session. */
  hasEarlier: Accessor<boolean>;
  /** The session state frame: what a small backfill cannot carry (mode, the
   *  newest /context reading, the queue, prompt history). Null until it lands. */
  state: Accessor<SessionState | null>;
  close: () => void;
}

/**
 * How big a step back is, in bytes, as a reader keeps going.
 *
 * One glance upward is cheap; somebody genuinely reading backwards stops paying
 * a round trip per screen. The ladder resets when they stop, so the cost of
 * looking is always the first rung. The server clamps the top of it
 * independently (session-events MaxResponseBytes).
 */
export const EARLIER_STEPS_BYTES = [40_000, 80_000, 160_000, 400_000];

/** What a jump to a search hit asks for: it already knows it is reaching far. */
export const JUMP_STEP_BYTES = 400_000;

/**
 * Merge two id-ordered event lists into one, dropping ids already present.
 *
 * Backfill arrives newest-first and below what is held; live events arrive
 * above it; a split turn's prompt arrives from below the cursor and can repeat
 * on the next step. One ordered merge covers all three without the caller
 * having to know which case it is in.
 */
export function mergeById(held: Event[], arrived: Event[]): Event[] {
  if (arrived.length === 0) return held;
  const out: Event[] = [];
  let i = 0;
  let j = 0;
  while (i < held.length || j < arrived.length) {
    const a = held[i];
    const b = arrived[j];
    if (a && (!b || a.id <= b.id)) {
      if (b && b.id === a.id) j++; // already held
      out.push(a);
      i++;
    } else if (b) {
      out.push(b);
      j++;
    }
  }
  return out;
}

/** Toast severity forwarded to the app (subset of the toast ToastKind). */
export type NotifyKind = "info" | "error" | "warning" | "success";

export interface SessionStoreOptions {
  /** surface a control-channel error to the app's toast stack. Omitted in
   *  tests; when present, failures ALSO toast but still never throw (the read
   *  path stays intact). */
  notify?: (message: string, kind: NotifyKind) => void;
  /** connect the stream at construction (default true). `false` hands the first
   *  connect to `start()`, for a caller that knows whether the transcript is
   *  being LOOKED at: v1 opens a session on the Terminal view, so constructing
   *  the store is no longer evidence that anyone wants the stream. Same shape as
   *  the lobby store's `autoStart`. */
  autoStart?: boolean;
  /** injected in tests; defaults to the tab's shared IndexedDB-backed cache. */
  cache?: TranscriptCache;
}

/**
 * Wires the resumable SSE client into a Solid store. Events arrive already
 * ordered + deduped by the client (server replays from the Last-Event-ID
 * cursor), so we simply append. Control writes POST to session-events'
 * /prompt/<session> (body {text}) and /cancel/<session>; failures never break
 * the read path (the transcript still tails), but they surface as an error
 * toast via `notify` so a dropped prompt/cancel/permission isn't silent.
 *
 * The stream itself is opened at construction by default, or by `start()` when
 * built with `autoStart: false` — one connect either way, never a reconnect on
 * top of a live one, and `close()` is final.
 */
let sharedCache: TranscriptCache | null = null;
/** The tab's transcript cache. One IndexedDB handle for every session store. */
function defaultTranscriptCache(): TranscriptCache {
  if (!sharedCache) sharedCache = createTranscriptCache(indexedDbBackend());
  return sharedCache;
}

export function createSessionStore(
  session: string,
  opts: SessionStoreOptions = {},
): SessionStore {
  const [events, setEvents] = createStore<Event[]>([]);
  const [status, setStatus] = createSignal<SseStatus>("connecting");
  // A fresh open backfills a bounded number of BYTES (session-events
  // OpenBackfillBytes), so there is usually history behind it. Assumed present
  // until the server's cursor says otherwise.
  const [hasEarlier, setHasEarlier] = createSignal(true);
  const [sessionState, setSessionState] = createSignal<SessionState | null>(null);
  /**
   * Where the next step back begins.
   *
   * The server's, not `events[0].id`. A split turn's prompt rides along from
   * BELOW the cursor, so the oldest event held is not where the next step
   * starts — paging from it would skip everything in between, permanently.
   */
  let cursor = 0;
  /** Which log the held ids belong to (the server's ready.epoch), and the cache
   *  that stores the transcript against it. */
  let cachedEpoch = "";
  /** How many events this open started with, from disk. The other half of the
   *  measurement is what the server sent anyway. */
  let seededFromCache = 0;
  let openReported = false;
  const cache = opts.cache ?? defaultTranscriptCache();
  /** How far up the step ladder a run of paging has climbed. */
  let step = 0;
  /** Every id held, so a repeat costs a lookup rather than a scan. */
  const seen = new Set<number>();
  /** The events in `list` not already held, claiming them as it goes — so a
   *  repeat WITHIN one batch is caught too, not just one across batches. */
  const takeFresh = (list: Event[]): Event[] => {
    const out: Event[] = [];
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  };

  /**
   * Arriving events are COALESCED into one store write per frame.
   *
   * Appending each event on its own made opening a session quadratic: every
   * append re-ran the transcript→rows derivation over the whole array, plus the
   * memos beside it (pending permissions, working state, prompt history, queued
   * prompts, current mode). Measured on a real 1,383-event window: deriving
   * once costs 10 ms, and deriving once per event costs 2,644 ms — 263x, and the
   * bulk of it lands during the replay burst, when hundreds of events arrive in
   * a single network chunk.
   *
   * A frame is the right grain. It collapses the burst into a couple of
   * derivations, and for live events it adds at most one frame of latency to a
   * transcript that is already a tail of a file being polled every 200 ms.
   */
  let pending: Event[] = [];
  /** History, arriving newest-first. Its own lane: it does NOT wait behind the
   *  opening hold, because painting it is what ends that hold. */
  let backfill: Event[] = [];
  let flushHandle = 0;
  const openedAt = Date.now();

  /**
   * When the first rows go on screen.
   *
   * Against a server that backfills in reverse this is the first frame that
   * arrives: history comes newest-first, so the first batch IS the last thing
   * that happened, and it lands at the bottom where it belongs and stays there.
   * Nothing is gained by waiting for the rest, and the wait is the whole
   * complaint.
   *
   * The hold survives for the other case — an older server, or a proxy that
   * drops named events — where the opening window arrives ASCENDING on the live
   * lane. Painting that as it arrives means deriving turns and folds from a
   * partial transcript and re-deriving them: measured opening a real session
   * (2026-08-18), with the row count flat at 14, the content went 2194px ->
   * 594px -> 851px as rows were torn down and rebuilt, and what sat mid-screen
   * changed four times inside a second. There, `ready` (or the timeout) is
   * still what releases it.
   */
  const [opening, setOpening] = createSignal(true);
  let holding = true;
  const OPEN_WINDOW_TIMEOUT_MS = 2500;
  let holdTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    holdTimer = undefined;
    release();
  }, OPEN_WINDOW_TIMEOUT_MS);

  /** Flip to painted, without driving a flush (the flush may be the caller). */
  const paint = (): void => {
    if (!holding) return;
    holding = false;
    setOpening(false);
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
    // The number this whole design exists to move, and one nothing recorded
    // before: stream open to first row on screen.
    track("text.first_paint", {
      "tl.session": session,
      "tl.ms": Date.now() - openedAt,
      "tl.count": events.length,
    });
  };

  const release = (): void => {
    if (!holding) return;
    paint();
    flush();
  };

  /**
   * Prompts sent from here that the transcript has not shown yet.
   *
   * Measured 2026-08-18 on a live session: the POST returns in ~23ms and the
   * tail delivers in ~50ms, but the CLI takes 620-680ms to write its own record
   * of a prompt (1.2s on a session's first turn), and unboundedly longer when
   * the prompt is QUEUED behind a running turn. Waiting for that record is why
   * a message sat invisible for most of a second after Send.
   *
   * So the prompt is shown the moment the send is accepted, and let go when the
   * transcript catches up. For a slash command that may be never — /help,
   * /context and /status are not recorded at all — which is why the two are let
   * go by different rules.
   */
  const [pendingPrompts, setPendingPrompts] = createSignal<PendingPrompt[]>([]);
  let pendingSeq = 0;

  /**
   * Persist the transcript, off the render path.
   *
   * requestIdleCallback for the same reason the progressive mount uses it: the
   * opening burst is hundreds of events and the derivation behind it is the
   * expensive part of this view (measured 10 ms per derivation, 2,644 ms when
   * run per event). A cache write that competed with that would trade a fetch
   * the user cannot see for jank they can. Coalesced, so a burst writes once.
   */
  let cacheWriteHandle: ReturnType<typeof setTimeout> | number = 0;
  const scheduleCacheWrite = (): void => {
    if (cacheWriteHandle || closed) return;
    const run = (): void => {
      cacheWriteHandle = 0;
      if (closed || !cachedEpoch) return;
      void cache.save(session, cachedEpoch, events);
    };
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    cacheWriteHandle = idle
      ? idle(run, { timeout: 2_000 })
      : setTimeout(run, 500);
  };

  const flush = (): void => {
    flushHandle = 0;
    // History first, and never behind the hold: this batch is what ends it.
    if (backfill.length > 0) {
      const older = backfill.reverse(); // arrived newest-first
      backfill = [];
      const fresh = takeFresh(older);
      if (fresh.length > 0) setEvents((prev) => mergeById(prev, fresh));
      paint();
    }
    // Still waiting on the rest of an ASCENDING opening window: keep buffering.
    if (holding) return;
    if (pending.length === 0) return;
    const arrived = takeFresh(pending);
    pending = [];
    if (arrived.length === 0) return;
    scheduleCacheWrite();
    // batch() so the derivation runs once for the whole group rather than once
    // per index write.
    batch(() => {
      // Ordered merge rather than a bare append: with a reverse backfill in
      // flight, a live event and a history frame can land in the same batch.
      const newest = events.length > 0 ? events[events.length - 1]!.id : 0;
      if (arrived.every((e) => e.id > newest)) {
        for (const e of arrived) setEvents(events.length, e);
      } else {
        setEvents((prev) => mergeById(prev, [...arrived].sort((a, b) => a.id - b.id)));
      }
      // The transcript caught up with something we were standing in for.
      // One record accounts for ONE prompt, oldest first: sending two in
      // quick succession queues them, and the first record must not clear the
      // second prompt as well.
      const spoken = arrived.filter((e) => e.kind === "user");
      if (spoken.length > 0) {
        setPendingPrompts((cur) => {
          let left = cur;
          const drop = (i: number) => (left = left.filter((_, n) => n !== i));
          for (const e of spoken) {
            // Either kind is let go when the transcript says the same thing.
            const said = left.findIndex((p) => sameCommand(e.body ?? "", p.text));
            if (said >= 0) {
              drop(said);
              continue;
            }
            // No text match. Prose is ALWAYS recorded, so a record made after
            // one was sent is that one — whatever the CLI did to the text on
            // the way in (it trims trailing whitespace). A command is not
            // released this way: it may never be recorded at all, and a later
            // prompt must not sweep away the only account of it.
            const oldest = left.findIndex((p) => !p.command && p.afterId < e.id);
            if (oldest >= 0) drop(oldest);
          }
          return left;
        });
      }
    });
  };

  const scheduleFlush = (): void => {
    if (flushHandle) return;
    flushHandle =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 0) as unknown as number);
  };

  /**
   * Let go of the transcript held: it belongs to a log this session is no
   * longer reading.
   *
   * The client calls this when a stream comes back on a DIFFERENT log — a new
   * Claude in the same tmux window writes a new transcript, and its ids start
   * again at 1 (see SseClient.foreignLog). What is held is then a finished
   * conversation while the events about to arrive belong to another one, and
   * keeping both would interleave two sessions in one timeline. Keeping the
   * old one alone is what this defect looked like from the outside: a
   * transcript frozen mid-conversation, with an answer card still docked over a
   * question that had been answered in the terminal minutes before.
   *
   * The opening hold is re-armed with it, so the view waits for the new window
   * the way it waits for the first one rather than flashing an empty transcript.
   */
  const reset = (): void => {
    // The server named a different log, or its head is behind our cursor: what
    // is stored describes a transcript that no longer exists, so it goes too.
    // Keeping it would mean seeding the same wrong ids on the next open.
    cachedEpoch = "";
    void cache.drop(session);
    pending = [];
    backfill = [];
    seen.clear();
    cursor = 0;
    step = 0;
    batch(() => {
      setEvents([]);
      setPendingPrompts([]);
      setSessionState(null);
      setHasEarlier(true);
    });
    holding = true;
    setOpening(true);
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      release();
    }, OPEN_WINDOW_TIMEOUT_MS);
  };

  const client = new SseClient({
    session,
    url: eventsUrl,
    onReset: reset,
    onEvent: (e: Event) => {
      pending.push(e);
      scheduleFlush();
    },
    onBackfill: (e: Event) => {
      backfill.push(e);
      scheduleFlush();
    },
    onState: (st: SessionState) => setSessionState(st),
    onStatus: setStatus,
    onReady: (r: ReadyFrame) => {
      // A reverse open names where the next step back begins; a resume does
      // not, because the client's own cursor is the correct one and clobbering
      // it with a backfill cursor would strand the history already held.
      if (typeof r.cursor === "number") {
        cursor = r.cursor;
        setHasEarlier(r.cursor > 0);
      }
      // Which log the ids in this stream belong to. Stored beside the events so
      // a later open can tell whether what it holds still describes this
      // transcript; without it the events are unusable and are not written.
      if (r.epoch) cachedEpoch = r.epoch;
      release();
      scheduleCacheWrite();
      // One record per open, once the server has said where the window ends:
      // what this device supplied against what still had to be fetched.
      if (!openReported) {
        openReported = true;
        track("text.open", {
          "tl.session": session,
          "tl.cache": seededFromCache > 0 ? "hit" : "miss",
          "tl.cached": seededFromCache,
          "tl.fetched": Math.max(0, events.length - seededFromCache),
        });
      }
    },
  });

  /** has the stream been opened, and has it been closed for good? */
  let started = false;
  let closed = false;

  /**
   * Open the stream, resuming from what this device already holds.
   *
   * The cache read is awaited rather than raced: seeding after the window has
   * begun arriving would mean paying for the window anyway, which is the cost
   * this exists to remove. It is one IndexedDB read of one record, and it fails
   * soft — no cache, or a slow one, and this is exactly the open it always was.
   */
  const startWithCache = async (): Promise<void> => {
    const cached = await cache.read(session);
    if (closed) return;
    if (cached && cached.events.length > 0) {
      cachedEpoch = cached.epoch;
      const fresh = takeFresh([...cached.events]);
      if (fresh.length > 0) {
        seededFromCache = fresh.length;
        batch(() => {
          setEvents(fresh);
          setOpening(false);
        });
        holding = false;
      }
      client.resumeFrom(resumeCursor(cached.events), cached.epoch);
    }
    client.start();
  };

  const start = (): void => {
    // Idempotent because the caller drives this from a Solid effect, which
    // re-runs for reasons that have nothing to do with this stream. `closed` is
    // the guard that carries weight: SseClient.start() clears the client's own
    // `stopped` flag, so an effect flushing after disposal would otherwise
    // re-open a stream the view that owned it no longer exists to read.
    if (started || closed) return;
    started = true;
    // With nothing stored there is nothing to wait for, and the stream opens
    // exactly as it always did — synchronously, in this tick.
    if (!cache.enabled) {
      client.start();
      return;
    }
    void startWithCache();
  };

  const close = (): void => {
    closed = true;
    // Anything buffered is delivered rather than dropped: a client that closes
    // right after the replay would otherwise show a timeline missing its tail.
    // The frame is cancelled first so the flush cannot run twice.
    if (flushHandle) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushHandle);
      clearTimeout(flushHandle);
      flushHandle = 0;
    }
    flush();
    // Safe on a client that never opened anything: with no source, no timer and
    // no registered listeners, every teardown step inside is a no-op.
    client.close();
  };

  if (opts.autoStart !== false) start();
  onCleanup(close);

  const resolvePermission = async (
    reqId: string,
    decision: PermissionDecision,
  ): Promise<boolean> => {
    try {
      const res = await fetchWithDeadline(permissionUrl(reqId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        opts.notify?.(`Couldn't resolve permission (HTTP ${res.status})`, "error");
      }
      return res.ok; // 204 No Content on success
    } catch {
      opts.notify?.("Couldn't resolve permission", "error");
      return false;
    }
  };

  const send = async (text: string): Promise<boolean> => {
    try {
      const res = await fetchWithDeadline(promptUrl(session), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // No 409 arm any more. It used to say "A turn is already running", from
        // a gate session-events removed on 2026-08-15 — a mid-turn send is a
        // normal thing to do now, and Claude queues it. What is left is 400 (an
        // empty body) and 502 (the injection failed), which mean the same thing
        // to a reader: it did not land.
        opts.notify?.(`Couldn't send prompt (HTTP ${res.status})`, "error");
      }
      if (res.ok) {
        pendingSeq += 1;
        setPendingPrompts((cur) => [
          ...cur,
          {
            id: -pendingSeq,
            text: text.trim(),
            at: Date.now(),
            command: isSlashCommand(text),
            afterId: events.length > 0 ? (events[events.length - 1]?.id ?? 0) : 0,
          },
        ]);
      }
      return res.ok;
    } catch {
      /* the prompt still shows once the transcript tails */
      opts.notify?.("Couldn't reach the session", "error");
      return false;
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      const res = await fetchWithDeadline(cancelUrl(session), {
        method: "POST",
      });
      if (!res.ok) opts.notify?.(`Couldn't interrupt (HTTP ${res.status})`, "error");
    } catch {
      /* best-effort cancel */
      opts.notify?.("Couldn't interrupt the session", "error");
    }
  };

  const answer = async (keys: string[]): Promise<boolean> => {
    try {
      const res = await fetchWithDeadline(keysUrl(session), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      if (!res.ok) opts.notify?.(`Couldn't answer (HTTP ${res.status})`, "error");
      return res.ok;
    } catch {
      opts.notify?.("Couldn't reach the session", "error");
      return false;
    }
  };

  // Free text for an "Other" answer. Separate from `send` because the pane is
  // showing a dialog, not a prompt: this types and stops, and the caller sends
  // the Enter itself once it has read the pane back and confirmed the text
  // landed in the field.
  const answerText = async (text: string): Promise<boolean> => {
    try {
      const res = await fetchWithDeadline(answerTextUrl(session), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) opts.notify?.(`Couldn't type the answer (HTTP ${res.status})`, "error");
      return res.ok;
    } catch {
      opts.notify?.("Couldn't reach the session", "error");
      return false;
    }
  };

  const search = async (q: string): Promise<SearchHit[]> => {
    try {
      const res = await fetchWithDeadline(searchUrl(session, q));
      if (!res.ok) return [];
      return ((await res.json()) as SearchHit[] | null) ?? [];
    } catch {
      opts.notify?.("Couldn't search this session", "error");
      return [];
    }
  };

  /**
   * The session's own slash commands. Fetched once per view rather than polled:
   * skills and commands are files on disk, and a session that gains one mid-turn
   * is rare enough that a reload is a fair price. An unreachable catalogue is
   * not an error — the composer still has the built-ins the page ships.
   */
  const commands = async (): Promise<SlashCommand[]> => {
    try {
      const res = await fetchWithDeadline(commandsUrl(session));
      if (!res.ok) return [];
      return ((await res.json()) as SlashCommand[] | null) ?? [];
    } catch {
      return [];
    }
  };

  const pane = async (): Promise<{ pane: string; state: string } | null> => {
    try {
      const res = await fetchWithDeadline(paneUrl(session));
      if (!res.ok) return null;
      return (await res.json()) as { pane: string; state: string };
    } catch {
      return null;
    }
  };

  const fullResult = async (toolId: string): Promise<string | null> => {
    try {
      const res = await fetchWithDeadline(
        resultUrl(session, toolId),
        undefined,
        TRANSCRIPT_READ_TIMEOUT_MS,
      );
      if (!res.ok) {
        opts.notify?.("That output is no longer in the transcript", "warning");
        return null;
      }
      const body = (await res.json()) as { body?: string };
      return body.body ?? "";
    } catch {
      opts.notify?.("Couldn't load the full output", "error");
      return null;
    }
  };

  const loadEarlier = async (bytes?: number): Promise<number> => {
    // Before the first `ready`, fall back to the oldest event held. It is the
    // right answer while nothing has split — and the only one available against
    // a server that does not send a cursor at all.
    const before = cursor > 0 ? cursor : (events[0]?.id ?? 0);
    if (before <= 1) {
      setHasEarlier(false);
      return 0;
    }
    const ask =
      bytes ??
      EARLIER_STEPS_BYTES[Math.min(step, EARLIER_STEPS_BYTES.length - 1)]!;
    try {
      const res = await fetchWithDeadline(
        earlierUrl(session, before, ask),
        undefined,
        TRANSCRIPT_READ_TIMEOUT_MS,
      );
      if (!res.ok) return 0;
      const body = (await res.json()) as {
        events?: Event[];
        cursor?: number;
      } | null;
      const older = body?.events ?? [];
      if (typeof body?.cursor === "number") cursor = body.cursor;
      if (older.length === 0 || (body && body.cursor === 0)) setHasEarlier(false);
      if (older.length === 0) return 0;
      const fresh = takeFresh(older);
      if (fresh.length > 0) setEvents((prev) => mergeById(prev, fresh));
      // Only a step the reader drove climbs the ladder; a jump names its own
      // size and should not make the next glance upward expensive.
      if (bytes === undefined) step++;
      track("text.window_grew", {
        "tl.session": session,
        "tl.count": fresh.length,
        "tl.bytes": ask,
        "tl.reason": bytes === undefined ? "scroll" : "jump",
      });
      return fresh.length;
    } catch {
      opts.notify?.("Couldn't load earlier turns", "error");
      return 0;
    }
  };

  return {
    events,
    status,
    start,
    resolvePermission,
    send,
    interrupt,
    answer,
    answerText,
    search,
    pane,
    commands,
    pendingPrompts,
    opening,
    fullResult,
    loadEarlier,
    hasEarlier,
    state: sessionState,
    close,
  };
}
