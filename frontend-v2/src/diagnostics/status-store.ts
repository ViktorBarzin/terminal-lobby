/**
 * The live connection status — one store, five providers, two readers.
 *
 * The providers push in from where the facts already are: TerminalNative
 * reports its socket, SessionView forwards its SSE status, the lobby store
 * reports its poll, the push module answers for notifications and the deploy
 * healer says when an update is waiting. Nothing here polls anything; a channel
 * that has not spoken stays `unknown`, which is the honest answer and never
 * paints a fault.
 *
 * The readers are the badge (session bar and sidebar header, each scoped to
 * what its surface can honestly report) and the Right now panel in Settings.
 *
 * HISTORY LIVES HERE, IN MEMORY, FOR THE LIFE OF THE PAGE. "Is it flapping?" is
 * the difference between a bad link and a broken one, and one live state cannot
 * answer it. It is deliberately not persisted: the durable copy is the
 * diagnostics channel in Loki, keyed by tab, and keeping a second one on the
 * device would buy a storage decision and a privacy question for a readout that
 * is most useful about the session in front of you.
 *
 * Each transition is also pushed into diag.js's flight recorder, so any
 * `diag.incident` raised afterwards carries the connection history that led to
 * it — which is the context those records have never had.
 */

import { createSignal, type Accessor } from "solid-js";
import {
  SESSION_CHANNELS,
  buildChannel,
  channelPhrase,
  notificationsChannel,
  sessionsChannel,
  terminalChannel,
  transcriptChannel,
  type Channel,
  type ChannelId,
  type NotificationsReport,
  type ChannelState,
  type SessionsReport,
  type StatusEvent,
  type TerminalReport,
} from "./status";
import { runCheck, type CheckOutcome, type CheckProbe } from "./check";
import type { SseStatus } from "../sse/client";
import { diag } from "../telemetry/diag";

/**
 * How many transitions to keep. Deep enough to show a flapping link over a few
 * minutes, shallow enough that a socket fighting a dead network for an hour
 * cannot grow without bound.
 */
export const LOG_MAX = 100;

export interface StatusStore {
  /** All five channels, in row order, whatever has reported so far. */
  channels: Accessor<Channel[]>;
  /** Every transition since the page loaded, oldest first. */
  log: Accessor<readonly StatusEvent[]>;
  /** epoch ms this store started watching. */
  bootedAt: number;
  /** The last check's outcome per channel, empty until one has run. */
  lastCheck: Accessor<Partial<Record<ChannelId, CheckOutcome>>>;
  /** When the last check finished, or null. */
  checkedAt: Accessor<number | null>;
  checking: Accessor<boolean>;

  setTerminal(report: TerminalReport | null): void;
  setTranscript(status: SseStatus | null): void;
  setSessions(report: SessionsReport): void;
  setNotifications(report: NotificationsReport): void;
  setBuild(report: { updateReady: boolean }): void;

  /** Run every probe, filling `lastCheck` row by row as answers land. */
  check(probes: readonly CheckProbe[]): Promise<CheckOutcome[]>;
}

/**
 * What the Right now panel is handed. The store holds the state; this adds the
 * two things only the app can supply — how to probe each channel, and what
 * repairing one means — so the panel itself stays a readout with buttons.
 */
export interface ConnectionControl {
  channels: Accessor<readonly Channel[]>;
  log: Accessor<readonly StatusEvent[]>;
  lastCheck: Accessor<Partial<Record<ChannelId, CheckOutcome>>>;
  checkedAt: Accessor<number | null>;
  checking: Accessor<boolean>;
  bootedAt: number;
  /** the worst state across every channel, for the verdict's colour. */
  worstNow: Accessor<ChannelState>;
  runCheck(): Promise<void>;
  /** What this row's repair button says, or null when there is nothing to
   *  offer. A row nobody can fix from here must not grow a button that lies. */
  repairLabel(id: ChannelId): string | null;
  repair(id: ChannelId): void | Promise<void>;
}

export interface StatusStoreOptions {
  now?: () => number;
  /** injectable for tests; defaults to the app's diagnostics handle. */
  onTransition?: (e: StatusEvent) => void;
  /** injectable for tests; defaults to reporting one diag.selfcheck record. */
  onChecked?: (rows: readonly CheckOutcome[]) => void;
}

/** Report a finished check to diagnostics, subject to the usual opt-out —
 *  someone pressing Run check is having a problem, which makes it the single
 *  highest-value moment on the whole channel. */
function reportCheck(rows: readonly CheckOutcome[]): void {
  const attrs: Record<string, string | number> = {};
  for (const r of rows) {
    attrs[`tl.chk.${r.id}`] = r.state;
    attrs[`tl.chk.${r.id}_ms`] = r.ms;
  }
  diag().selfcheck(attrs);
}

export function createStatusStore(opts: StatusStoreOptions = {}): StatusStore {
  const now = opts.now ?? (() => Date.now());
  const bootedAt = now();

  const [channels, setChannels] = createSignal<Channel[]>(
    // Seeded with each channel's own phrase rather than an empty string: a row
    // with a label and no text beside it reads as a rendering bug, where "not
    // reporting" reads as an answer.
    SESSION_CHANNELS.map((id) => ({ id, state: "unknown" as const, detail: channelPhrase(id, "unknown") })),
  );
  const [log, setLog] = createSignal<readonly StatusEvent[]>([]);
  const [lastCheck, setLastCheck] = createSignal<Partial<Record<ChannelId, CheckOutcome>>>({});
  const [checkedAt, setCheckedAt] = createSignal<number | null>(null);
  const [checking, setChecking] = createSignal(false);

  const onTransition =
    opts.onTransition ??
    ((e: StatusEvent) => {
      // Geometry and control keys only is the ring's rule; a channel id and two
      // state words carry no content, so this is safe to record verbatim.
      diag().ring({ ev: "conn.state", ch: e.id, from: e.from, to: e.to });
    });

  function put(next: Channel): void {
    setChannels((prev) => {
      const before = prev.find((c) => c.id === next.id);
      if (before && before.state === next.state && before.detail === next.detail) return prev;
      if (before && before.state !== next.state) {
        const e: StatusEvent = { id: next.id, from: before.state, to: next.state, at: now() };
        setLog((l) => (l.length >= LOG_MAX ? [...l.slice(1), e] : [...l, e]));
        onTransition(e);
      }
      return prev.map((c) => (c.id === next.id ? next : c));
    });
  }

  return {
    channels,
    log,
    bootedAt,
    lastCheck,
    checkedAt,
    checking,

    setTerminal: (r) => put(terminalChannel(r)),
    setTranscript: (s) => put(transcriptChannel(s)),
    setSessions: (r) => put(sessionsChannel(r)),
    setNotifications: (r) => put(notificationsChannel(r)),
    setBuild: (r) => put(buildChannel(r)),

    async check(probes) {
      if (checking()) return [];
      setChecking(true);
      // A check starts from nothing rather than from the previous run's rows: a
      // stale tick beside a row still spinning reads as this check's answer.
      setLastCheck({});
      try {
        const rows = await runCheck(probes, (r) => {
          setLastCheck((prev) => ({ ...prev, [r.id]: r }));
          // A probe's verdict is a real observation of the channel, so it feeds
          // the live state too — otherwise the panel could show a row that
          // just timed out sitting above a green dot.
          put({ id: r.id, state: r.state, detail: r.detail });
        });
        setCheckedAt(now());
        (opts.onChecked ?? reportCheck)(rows);
        return rows;
      } finally {
        setChecking(false);
      }
    },
  };
}
