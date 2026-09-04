/**
 * Usage events from the lobby (docs/adr/0006-usage-telemetry.md).
 *
 * The page cannot write to the journal, so events are batched and POSTed to
 * tmux-api's /telemetry intake, which already authenticates the caller and
 * therefore owns attribution — the browser never says who it is. From there
 * they reach Loki via the journal promtail already ships.
 *
 * Two rules this module exists to keep:
 *
 *   1. Telemetry never breaks the app. Every failure path is swallowed, the
 *      buffer is bounded, and a dead intake costs one dropped batch.
 *   2. Nothing is recorded but WHICH feature ran. No prompt text, no file
 *      contents, no keystrokes — attribute values are ids, names and counts.
 *
 * `TlEvent` mirrors the Go catalog in telemetry/events.go: the union makes a
 * typo a compile error here, and the server drops anything it does not know.
 * Add an event to BOTH, in the same commit.
 */

import { apiUrl } from "../lib/config";
import { BUILD_ID } from "../lib/config";

export type TlEvent =
  // app lifecycle
  | "app.loaded"
  | "app.reloaded"
  | "app.update_failed"
  | "app.error"
  // session lifecycle
  // Emitted when a create input OPENS, so the gap to session.created is the
  // window a speculative pre-warm has to work in. Without it there is no way
  // to tell whether starting Claude at that moment covers its ~2.4s boot or
  // only part of it, which is what decides whether the standing pool slot is
  // still worth its ~530MB.
  | "session.create_opened"
  | "session.created"
  | "session.selected"
  | "session.attached"
  // Opening a transcript in Text mode: did this device already hold it, how
  // many events did it seed from, and how many did the server still send.
  // Without the pair, "the cache works" is a claim rather than a measurement.
  | "text.open"
  | "text.answer_sent"
  | "text.answer_failed"
  | "session.detached"
  | "session.moved"
  | "session.killed"
  | "session.restored"
  // projects & layout
  | "project.created"
  | "project.renamed"
  | "project.deleted"
  | "project.dir_changed"
  | "project.member_added"
  | "project.member_removed"
  | "project.mode_changed"
  | "project.coown_changed"
  | "layout.reordered"
  | "layout.group_toggled"
  | "sidebar.toggled"
  // sharing
  | "share.granted"
  | "share.revoked"
  // acting as another user (admin). tl.to is the target; the server emits its
  // own admin.actas at /whoami and at attach, which is the authoritative
  // record — these two are the CLIENT's view of when the switch was asked for.
  | "admin.actas"
  | "admin.actas.exit"
  // Text view load (the reverse-open design, 2026-08-28). first_paint is stream
  // open -> first row on screen, which nothing measured before: the change
  // exists to move it, and a number nobody can see is a change nobody can
  // verify. window_grew is one step back through history (tl.reason: scroll |
  // jump).
  | "text.first_paint"
  | "text.window_grew"
  // navigation & keyboard
  | "palette.opened"
  | "palette.action"
  | "help.opened"
  | "view.switched"
  // watch mode (attach read-only): tl.to is "ro" or "rw"
  | "watch.switched"
  // images & transfers
  | "gallery.opened"
  | "gallery.image_opened"
  | "image.pasted"
  | "image.uploaded"
  | "image.dropped"
  | "image.shown"
  | "file.transferred"
  // files
  | "file.previewed"
  | "file.edit_opened"
  | "file.saved"
  // terminal surface
  | "terminal.copied"
  | "terminal.pasted"
  | "terminal.paste_failed"
  | "terminal.softkey"
  | "terminal.gesture"
  // settings
  | "settings.opened"
  | "prefs.changed"
  | "theme.changed"
  // notifications
  | "notify.opt_in"
  | "notify.push_subscribed"
  | "notify.push_unsubscribed"
  | "notify.shown"
  | "notify.clicked"
  // The iOS cold-launch chain. sw.js reports notify.stash_written itself (it
  // cannot reach this batcher), and the page reports what boot decided.
  | "notify.stash_read"
  // Whether the app-icon count could be drawn at all (iOS may not expose the
  // Badging API inside a service worker).
  | "notify.badge_set"
  // the conversation
  | "claude.prompt_sent"
  | "claude.cancelled";

/** Attribute values are scalars only — see the no-content rule above. */
export type TlAttrs = Record<string, string | number | boolean | null | undefined>;

/** Buffer ceiling. Feature-level events are sparse; this is a runaway guard. */
export const MAX_BUFFER = 200;

/** Default flush cadence: often enough to survive a crash, rare enough to batch. */
const DEFAULT_FLUSH_MS = 10_000;

interface QueuedEvent {
  name: TlEvent;
  attrs: TlAttrs;
}

export interface TrackerOptions {
  /** Sends one batch. Injected in tests; defaults to fetch against the intake. */
  post?: (batch: unknown) => Promise<void>;
  /** Page-unload transport. Defaults to navigator.sendBeacon. */
  beacon?: (url: string, body: string) => boolean;
  flushMs?: number;
  /** Off in tests that drive flushing by hand. */
  autoFlush?: boolean;
}

export interface Tracker {
  track(name: TlEvent, attrs?: TlAttrs): void;
  flush(): Promise<void>;
  /** Best-effort synchronous flush for pagehide (uses sendBeacon). */
  flushSync(): void;
  dispose(): void;
}

const INTAKE = "/telemetry";
/** How long a telemetry POST may hang before it is abandoned. */
const TELEMETRY_TIMEOUT_MS = 8000;

export function createTracker(opts: TrackerOptions = {}): Tracker {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const post =
    opts.post ??
    (async (batch: unknown) => {
      await fetch(apiUrl(INTAKE), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        // A beacon that never settles is a beacon that leaks: the batch is
        // already dropped from the buffer, so a hung POST holds a connection
        // (and, before it stopped being tracked, a sticky slow-request toast)
        // for as long as the tab lives. Nothing here is worth retrying, so the
        // deadline just lets it go.
        signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
      });
    });
  const beacon =
    opts.beacon ??
    ((url: string, body: string): boolean => {
      if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
      return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    });

  let buffer: QueuedEvent[] = [];
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const batchOf = (events: QueuedEvent[]) => ({
    client: "lobby-v2",
    build: BUILD_ID,
    events,
  });

  function track(name: TlEvent, attrs: TlAttrs = {}): void {
    if (disposed) return;
    buffer.push({ name, attrs });
    // Keep the NEWEST events: during a storm the recent ones explain it.
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  }

  async function flush(): Promise<void> {
    if (disposed || buffer.length === 0) return;
    const batch = batchOf(buffer);
    buffer = []; // drop-on-failure: never retry into an unbounded buffer
    try {
      await post(batch);
    } catch {
      /* telemetry is never worth surfacing */
    }
  }

  function flushSync(): void {
    if (disposed || buffer.length === 0) return;
    const body = JSON.stringify(batchOf(buffer));
    buffer = [];
    try {
      beacon(apiUrl(INTAKE), body);
    } catch {
      /* the tab is going away regardless */
    }
  }

  if (opts.autoFlush !== false) {
    timer = setInterval(() => void flush(), flushMs);
    if (typeof window !== "undefined") {
      // pagehide, not unload: it is the event that actually fires on iOS and
      // on bfcache navigations.
      window.addEventListener("pagehide", flushSync);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushSync();
      });
    }
  }

  return {
    track,
    flush,
    flushSync,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", flushSync);
    },
  };
}

/**
 * The app-wide tracker. A module singleton because call sites are spread across
 * stores, components and keybindings, and threading one through all of them
 * would be noise — telemetry is not part of any component's contract.
 */
export const tracker: Tracker = createTracker();

/** Shorthand used at call sites. */
export const track = (name: TlEvent, attrs?: TlAttrs): void => tracker.track(name, attrs);
