/**
 * The live connection status — one store, six providers, two readers.
 *
 * The providers push in from where the facts already are: TerminalNative
 * reports its socket, SessionView forwards its SSE status, the lobby store
 * reports its poll, the push module answers for notifications and the deploy
 * healer says when an update is waiting. Nothing here polls anything; a channel
 * that has not spoken stays `unknown`, which is the honest answer and never
 * paints a fault.
 *
 * THE SIXTH SUBSCRIBES INSTEAD OF BEING PUSHED, because the box is the one
 * channel nothing on the client can observe. Its verdict arrives stamped on
 * whichever request landed last (`X-TL-Machine`, read in lib/lobby-api.ts's
 * `req` beside the network id, for the same reason and at the same cost), and a
 * header riding somebody else's request has no component to be pushed from. So
 * this store listens to the client that reads it, and `dispose` is what stops
 * listening — the one teardown in a file where the other five providers have
 * nothing to release.
 *
 * It still polls nothing of its own. The header rides the five-second session
 * poll for free, and the faster direct read is started by the Right now panel
 * through `watchMachine` and stopped when the panel closes.
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
  machineChannel,
  notificationsChannel,
  sessionsChannel,
  terminalChannel,
  transcriptChannel,
  type Channel,
  type ChannelId,
  type MachinePoint,
  type MachineReport,
  type NotificationsReport,
  type ChannelState,
  type SessionsReport,
  type StatusEvent,
  type TerminalReport,
} from "./status";
import {
  currentMachineReport,
  currentMachineSeries,
  onMachineReport,
  startMachineFastPoll,
} from "../lib/lobby-api";
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
  /** All six channels, in row order, whatever has reported so far. */
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

  /**
   * The machine's own figures, which no other channel has: the row shows the
   * three stall percentages and the load average, and only the reading itself
   * carries them. Null until one has arrived, which is the same fact the
   * channel's `unknown` states and not a second opinion about it.
   */
  machine: Accessor<MachineReport | null>;
  /** The hour behind the reading, for the sparkline. Empty until the panel's
   *  own read has fetched it — the header cannot carry a series. */
  machineSeries: Accessor<readonly MachinePoint[]>;

  setTerminal(report: TerminalReport | null): void;
  setTranscript(status: SseStatus | null): void;
  setSessions(report: SessionsReport): void;
  setNotifications(report: NotificationsReport): void;
  setBuild(report: { updateReady: boolean }): void;
  /** The sixth provider, for a caller with a fresher reading than the header —
   *  the probe's answer, and every test in this repo. The live wiring subscribes
   *  on its own and needs nobody to call this. */
  setMachine(report: MachineReport | null): void;

  /**
   * Read the machine directly while someone is watching it, and hand back the
   * teardown. The panel owns the lifetime, because "faster while the panel is
   * open" has to stop being true when it closes.
   */
  watchMachine(): () => void;

  /** Run every probe, filling `lastCheck` row by row as answers land. */
  check(probes: readonly CheckProbe[]): Promise<CheckOutcome[]>;

  /** Stop listening for machine readings. The other five channels are pushed
   *  in and have nothing to release; this one subscribes, so it does. */
  dispose(): void;
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
  /**
   * The machine's figures and the hour behind them, passed through from the
   * store. They ride here rather than arriving as props on the panel so that
   * every row's facts reach it by one route, and `watchMachine` is the
   * panel-open fast read — call it on mount, call what it returns on cleanup.
   */
  machine: Accessor<MachineReport | null>;
  machineSeries: Accessor<readonly MachinePoint[]>;
  watchMachine(): () => void;
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
  // The reading itself, beside the channel it produces. The channel says what
  // colour the row is; these are the figures printed under it, and nothing else
  // in the model carries them.
  const [machine, setMachineReport] = createSignal<MachineReport | null>(null);
  const [machineSeries, setMachineSeries] = createSignal<readonly MachinePoint[]>([]);

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
      // The tier is part of "unchanged" because on the machine row it is the
      // only thing that separates two readings: busy and very-busy share a
      // state AND a phrase — both say "waiting on the disk" while IO is the
      // worst resource — so comparing state and detail alone dropped the
      // escalation and left "may feel slow" on screen through a sustained
      // grind. It is absent on the other five, where it compares equal.
      if (
        before &&
        before.state === next.state &&
        before.detail === next.detail &&
        before.tier === next.tier
      ) {
        return prev;
      }
      if (before && before.state !== next.state) {
        const e: StatusEvent = { id: next.id, from: before.state, to: next.state, at: now() };
        setLog((l) => (l.length >= LOG_MAX ? [...l.slice(1), e] : [...l, e]));
        onTransition(e);
      }
      return prev.map((c) => (c.id === next.id ? next : c));
    });
  }

  function takeMachine(report: MachineReport | null): void {
    setMachineReport(report);
    // The hour only ever changes on a direct read, which publishes a reading in
    // the same breath — so taking it here keeps the graph and the figures
    // beside it from being drawn from two different moments.
    setMachineSeries(currentMachineSeries());
    put(machineChannel(report));
  }

  // Live from here on. Seeding before subscribing matters on a page where a
  // poll answered before this store existed: without it the row would say "not
  // reporting" for another five seconds about a reading already in hand.
  takeMachine(currentMachineReport());
  const stopMachine = onMachineReport(takeMachine);

  return {
    channels,
    log,
    bootedAt,
    lastCheck,
    checkedAt,
    checking,
    machine,
    machineSeries,

    setTerminal: (r) => put(terminalChannel(r)),
    setTranscript: (s) => put(transcriptChannel(s)),
    setSessions: (r) => put(sessionsChannel(r)),
    setNotifications: (r) => put(notificationsChannel(r)),
    setBuild: (r) => put(buildChannel(r)),
    setMachine: takeMachine,

    watchMachine: () => startMachineFastPoll(),

    dispose: stopMachine,

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
          //
          // The tier rides along because the machine is the one channel whose
          // sentence hangs on something other than its state (status.ts
          // SENTENCE). Dropped here, a very busy box would go back to saying
          // "may feel slow" for as long as the check's answer stood.
          put({ id: r.id, state: r.state, detail: r.detail, ...(r.tier ? { tier: r.tier } : {}) });
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
