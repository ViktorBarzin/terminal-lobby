import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { SseClient, type SseStatus } from "../sse/client";
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
  /** Prepend the window of turns before the oldest event held. Returns how
   *  many arrived — 0 means the start of the session has been reached. */
  loadEarlier: () => Promise<number>;
  /** False once loadEarlier has reached the start of the session. */
  hasEarlier: Accessor<boolean>;
  close: () => void;
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
export function createSessionStore(
  session: string,
  opts: SessionStoreOptions = {},
): SessionStore {
  const [events, setEvents] = createStore<Event[]>([]);
  const [status, setStatus] = createSignal<SseStatus>("connecting");
  // A fresh open replays a WINDOW of recent turns (session-events
  // OpenWindowTurns), so there is usually history behind the oldest event held.
  // Assumed present until a load comes back empty.
  const [hasEarlier, setHasEarlier] = createSignal(true);

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
  let flushHandle = 0;

  /**
   * Hold the first paint until the opening window has all arrived.
   *
   * The server sends the window it had when the stream opened, then goes live.
   * Painting as it arrives means deriving turns and folds from a PARTIAL
   * transcript and then re-deriving them: rows that were already on screen
   * change identity and are rebuilt under the reader. Measured opening a real
   * session (2026-08-18): with the row count flat at 14, the content went
   * 2194px -> 594px -> 851px as the markdown and code blocks in those rows were
   * torn down and built again, and what sat at the middle of the screen changed
   * four times inside a second.
   *
   * One paint, from a complete window, lands the newest messages where they
   * belong and leaves them there. `ready` is a named SSE event, so a stream
   * that never sends it — an older server, a proxy that drops named events —
   * falls back to the timeout and behaves as before rather than showing
   * nothing.
   */
  const [opening, setOpening] = createSignal(true);
  let holding = true;
  const OPEN_WINDOW_TIMEOUT_MS = 2500;
  let holdTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    holdTimer = undefined;
    release();
  }, OPEN_WINDOW_TIMEOUT_MS);

  const release = (): void => {
    if (!holding) return;
    holding = false;
    setOpening(false);
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
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

  const flush = (): void => {
    flushHandle = 0;
    // Still waiting on the rest of the opening window: keep buffering.
    if (holding) return;
    if (pending.length === 0) return;
    const arrived = pending;
    pending = [];
    // batch() so the derivation runs once for the whole group rather than once
    // per index write.
    batch(() => {
      for (const e of arrived) setEvents(events.length, e);
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

  const client = new SseClient({
    session,
    url: eventsUrl,
    onEvent: (e: Event) => {
      pending.push(e);
      scheduleFlush();
    },
    onStatus: setStatus,
    // The opening window is complete: paint it, once.
    onReady: release,
  });

  /** has the stream been opened, and has it been closed for good? */
  let started = false;
  let closed = false;

  const start = (): void => {
    // Idempotent because the caller drives this from a Solid effect, which
    // re-runs for reasons that have nothing to do with this stream. `closed` is
    // the guard that carries weight: SseClient.start() clears the client's own
    // `stopped` flag, so an effect flushing after disposal would otherwise
    // re-open a stream the view that owned it no longer exists to read.
    if (started || closed) return;
    started = true;
    client.start();
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
      const res = await fetch(permissionUrl(reqId), {
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
      const res = await fetch(promptUrl(session), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        // 409 = a turn is already running (config.promptUrl contract).
        opts.notify?.(
          res.status === 409
            ? "A turn is already running"
            : `Couldn't send prompt (HTTP ${res.status})`,
          "error",
        );
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
      const res = await fetch(cancelUrl(session), {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) opts.notify?.(`Couldn't interrupt (HTTP ${res.status})`, "error");
    } catch {
      /* best-effort cancel */
      opts.notify?.("Couldn't interrupt the session", "error");
    }
  };

  const answer = async (keys: string[]): Promise<boolean> => {
    try {
      const res = await fetch(keysUrl(session), {
        method: "POST",
        credentials: "same-origin",
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
      const res = await fetch(answerTextUrl(session), {
        method: "POST",
        credentials: "same-origin",
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
      const res = await fetch(searchUrl(session, q), { credentials: "same-origin" });
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
      const res = await fetch(commandsUrl(session), { credentials: "same-origin" });
      if (!res.ok) return [];
      return ((await res.json()) as SlashCommand[] | null) ?? [];
    } catch {
      return [];
    }
  };

  const pane = async (): Promise<{ pane: string; state: string } | null> => {
    try {
      const res = await fetch(paneUrl(session), { credentials: "same-origin" });
      if (!res.ok) return null;
      return (await res.json()) as { pane: string; state: string };
    } catch {
      return null;
    }
  };

  const fullResult = async (toolId: string): Promise<string | null> => {
    try {
      const res = await fetch(resultUrl(session, toolId), {
        credentials: "same-origin",
      });
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

  const loadEarlier = async (): Promise<number> => {
    const oldest = events[0]?.id ?? 0;
    if (oldest <= 1) {
      setHasEarlier(false);
      return 0;
    }
    try {
      const res = await fetch(earlierUrl(session, oldest), {
        credentials: "same-origin",
      });
      if (!res.ok) return 0;
      const older = ((await res.json()) as Event[] | null) ?? [];
      if (older.length === 0) {
        setHasEarlier(false);
        return 0;
      }
      setEvents((prev) => [...older, ...prev]);
      return older.length;
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
    close,
  };
}
