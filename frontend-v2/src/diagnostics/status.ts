/**
 * Connection status — the model behind the dot, the Right now panel and the
 * check (docs/adr/0016-connection-status-in-the-ui.md).
 *
 * A client keeps six **channels**, and until the ADR a person could see two of
 * them: the transcript stream had a badge in the session bar, and the terminal
 * socket painted a pill of its own. The session list, notifications and a stale
 * build reported nothing at all, which is why "it stopped working" had no
 * answer a user could reach on their own.
 *
 * THE SIXTH IS NOT ABOUT THE CLIENT. Five channels answer "why is this slow"
 * five ways, all of them about the browser's end, and none of them can say that
 * the box itself is stalling while every one of them is healthy. `machine`
 * reports that, from Linux pressure-stall time, and it reaches degraded and
 * stops there (docs/adr/0027-stall-time-says-the-box-is-busy.md).
 *
 * The word "channel" belongs to this file, CONTEXT.md and the ADR. It is never
 * shown on screen: the rows are labelled Terminal, Transcript, Session list,
 * Notifications, Build and This machine, and six labelled rows do not need a
 * category name above them.
 *
 * THREE STATES, PLUS ONE THAT IS NOT A VERDICT. working / degraded / down is
 * the whole vocabulary, and it holds the one distinction a frozen terminal
 * actually needs: degraded means wait, down means act. `unknown` is the fourth
 * value and it is deliberately NOT a severity — a channel that has not reported
 * is skipped by every rule here rather than counted as either health or fault.
 * A terminal still booting, a lobby build too old to report, and a browser with
 * no push support all land there, and none of them is a failure to show
 * someone.
 *
 * Everything in this file is pure. The live wiring is status-store.ts and the
 * probes are check.ts, so the rules that decide what a person is told can be
 * tested without a browser, a socket or a clock.
 */

import type { SseStatus } from "../sse/client";
import type { DeviceSubscriptionState } from "../pwa/push";

export type { SseStatus };

export type ChannelId =
  | "terminal"
  | "transcript"
  | "sessions"
  | "notifications"
  | "build"
  | "machine";

export type ChannelState = "working" | "degraded" | "down" | "unknown";

export interface Channel {
  id: ChannelId;
  state: ChannelState;
  /** The short phrase the row shows after its label. Always present. */
  detail: string;
  /**
   * A number the BADGE may show beside its word — today only the terminal's
   * retry attempt. It exists because the badge is the single connection
   * indicator on a session screen: the terminal's own pill defers to it, so the
   * one thing the pill showed that a bare "Reconnecting" cannot is a climbing
   * attempt count, which is how a reader tells a ladder that is working from
   * one that is stuck. Absent on a first connect, which has nothing to count.
   */
  count?: number;
  /**
   * How busy the box is, on the one channel that has two things to say inside
   * a single state. The machine reaches `degraded` and stops there, so the dot
   * cannot separate a brush past a threshold from a sustained grind and the
   * SENTENCE map does it instead. Absent on every other channel, whose states
   * already carry that distinction.
   */
  tier?: MachineTier;
}

/**
 * Every channel, in reading order — which is also the order of the rows, and is
 * fixed here rather than left to whichever provider reported first.
 */
export const SESSION_CHANNELS: readonly ChannelId[] = [
  "terminal",
  "transcript",
  "sessions",
  "notifications",
  "build",
  "machine",
] as const;

/**
 * What the sidebar can honestly report. The list screen has no terminal and no
 * transcript, so a session's dead socket must not colour a badge sitting above
 * a list of sessions — it would name the wrong problem on the one screen that
 * cannot show the right one.
 *
 * The machine is here for the mirror-image reason. A terminal socket is a fact
 * about one screen; the box is the same box whichever screen you are on, so
 * every surface can report it without claiming anything it cannot see.
 */
export const LOBBY_CHANNELS: readonly ChannelId[] = [
  "sessions",
  "notifications",
  "build",
  "machine",
] as const;

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  terminal: "Terminal",
  transcript: "Transcript",
  sessions: "Session list",
  notifications: "Notifications",
  build: "Build",
  machine: "This machine",
};

/** Severity order. `unknown` is absent on purpose: it is not a severity. */
const RANK: Record<Exclude<ChannelState, "unknown">, number> = {
  working: 0,
  degraded: 1,
  down: 2,
};

/**
 * How long the session list may fail before it stops being "slow" and starts
 * being "not working". The poll's own backoff ladder caps at 30s
 * (store/lobby.ts MAX_POLL_INTERVAL_MS), so a minute of failure is two full
 * rungs with nothing to show for them — past the point where a person waiting
 * is being told something useful by "slow".
 */
export const SESSIONS_DOWN_AFTER_MS = 60_000;

/** What the terminal reports about its socket (TerminalNative's `onConn`). */
export interface TerminalReport {
  state: "open" | "connecting" | "offline" | "suspended" | "closed";
  /** which attempt the ladder is on; 0 or 1 is a first connect, not a retry. */
  attempt: number;
}

export interface SessionsReport {
  /** consecutive failed polls. */
  failures: number;
  /** ms since the last poll that returned; null before the first one does. */
  lastOkMs: number | null;
  /** ms since the polls started failing; null while they are not. */
  downMs: number | null;
}

export interface NotificationsReport {
  permission: NotificationPermission | "unsupported";
  device: DeviceSubscriptionState;
  /** whether the SERVER still holds this device's endpoint. */
  server: "holds" | "missing" | "unknown";
}

/**
 * Which resource the verdict is talking about. The three pressures, plus
 * `load` — which appears only on the fallback path, where a kernel without
 * /proc/pressure leaves load1/nproc as the thing being read.
 *
 * It names the resource nearest its OWN line, which is a meaningful answer
 * whether or not anything is over one: the sparkline draws a resource at every
 * point, including the healthy ones, and "nothing is wrong" is not the same
 * statement as "there is nothing to name".
 */
export type MachineResource = "cpu" | "io" | "memory" | "load";

/**
 * How busy the box is, in the two steps the sentences distinguish: over a
 * resource's amber line, and over its separate very-busy line. `fine` is under
 * every line and has nothing to say.
 *
 * The two lines are calibrated per resource rather than one being a multiple of
 * the other. Doubling was the first design and it was wrong: IO's amber line is
 * 50% and a stall rate cannot exceed 100%, so IO could never reach the tier at
 * all. See ADR-0027.
 */
export type MachineTier = "fine" | "busy" | "very-busy";

/**
 * What tmux-api's health verdict says about the box, as it arrives on the
 * client (docs/plans/2026-09-12-machine-health-indicator-design.md).
 *
 * The percentages are ten-minute rates computed from the cumulative `total=`
 * counters in /proc/pressure, not the kernel's own avg fields: the thresholds
 * were calibrated against ten-minute rates, and avg60 is noisier and would fire
 * more often than the calibration says.
 *
 * `state` is the verdict's OWN claim and is not taken on trust — machineChannel
 * clamps it, and the reason is written there.
 */
export interface MachineReport {
  state: ChannelState;
  /** The resource nearest its own line. Always set; see MachineResource. */
  worst: MachineResource;
  /** CPU `some` stall, as a percentage of the window. */
  cpuPct: number;
  /** IO `full` stall, same window. */
  ioPct: number;
  /** memory `full` stall, same window. */
  memPct: number;
  /** The one-minute load average, and the cores it is spread over. Displayed,
   *  and on the fallback path below it is also what decides. */
  load1: number;
  nproc: number;
  tier: MachineTier;
  /** Memory headroom, displayed beside the stall figures. */
  memAvailableMb: number;
  memTotalMb: number;
  /**
   * How much history the rates were computed over, and whether that is less
   * than the ten minutes they are calibrated for. A rate over a window too
   * short to mean anything is reported as `unknown` rather than as a colour,
   * so `partialWindow` is what lets the panel say WHY it is not answering yet.
   */
  windowSeconds: number;
  partialWindow: boolean;
  /**
   * Which reading this is. `psi` is /proc/pressure; `load` is the fallback for
   * a kernel that has none — older kernels, some container runtimes — where the
   * verdict comes from load1/nproc and memory headroom instead. `unknown` is
   * the answer before the sampler has taken its first sample, which any handler
   * running early in the process's life will see.
   */
  source: "psi" | "load" | "unknown";
}

/**
 * One point of the hour the sparkline draws, as tmux-api's `series()` marshals
 * it. Field names are Go's, deliberately: this crosses the wire often enough
 * that renaming it on arrival would buy nothing but a place for the two sides
 * to drift.
 *
 * Draw `ofLimit`, never `pct`. It is the rate divided by that resource's own
 * threshold, so 1.0 is the amber line for every resource and one line can carry
 * all three — where a raw 20% means "fine" for IO and "over the line" for CPU.
 * `pct` and `res` are for the figures beside the graph.
 */
export interface MachinePoint {
  /** unix seconds. */
  at: number;
  res: MachineResource;
  pct: number;
  ofLimit: number;
}

/**
 * The worst state across a set of channels, which is what the badge shows.
 *
 * Skipping `unknown` is the whole subtlety: a set of one unknown channel and
 * one working channel is working, and a set of nothing but unknowns is unknown
 * rather than healthy. Reporting "everything is fine" on the strength of
 * channels that have not spoken is the failure this panel exists to remove.
 */
export function worst(channels: readonly Channel[]): ChannelState {
  let seen: Exclude<ChannelState, "unknown"> | null = null;
  for (const c of channels) {
    if (c.state === "unknown") continue;
    if (seen === null || RANK[c.state] > RANK[seen]) seen = c.state;
  }
  return seen ?? "unknown";
}

/** The channels that are actually complaining, in row order. */
function problems(channels: readonly Channel[]): Channel[] {
  return channels.filter((c) => c.state === "degraded" || c.state === "down");
}

/**
 * Whether a complaint is about the CONNECTION. Two channels are degraded
 * without the link being in trouble: a stale build, where the page is old, and
 * a busy machine, where the box is slow. Neither may produce the word
 * "Reconnecting", which would send a reader to check their wifi.
 */
function aboutTheLink(c: Channel): boolean {
  return c.id !== "build" && c.id !== "machine";
}

/**
 * The word beside the badge's dot, or null to leave the dot on its own.
 *
 * Healthy is the state 99% of the time, and it does not earn text in a session
 * bar that is already tight on a phone. A problem does.
 */
export function badgeWord(channels: readonly Channel[]): string | null {
  const w = worst(channels);
  if (w === "working" || w === "unknown") return null;
  const bad = problems(channels);
  // A stale build and a busy machine each get their own word, and only when no
  // connection is also complaining — a real connection problem outranks both.
  // Between the two, the machine speaks: it is slow NOW, while an update only
  // sits there waiting. "Machine busy" stays short enough for a phone's
  // session bar, where this badge shares the row with a session title.
  if (!bad.some(aboutTheLink)) {
    return bad.some((c) => c.id === "machine") ? "Machine busy" : "Update ready";
  }
  if (w === "down") return "Offline";
  // The count comes from the channel the word is ABOUT — the first degraded
  // connection in row order — not from whichever channel happens to carry one.
  const lead = bad.find((c) => c.state === "degraded" && aboutTheLink(c));
  return lead?.count ? `Reconnecting ${lead.count}` : "Reconnecting";
}

/**
 * Which key a channel's sentences hang on. Five of them separate "reconnecting"
 * from "not connected" by STATE. The machine has one usable bad state and two
 * things to say inside it, so its sentences hang on the tier instead.
 */
type SentenceKey<K extends ChannelId> = K extends "machine" ? MachineTier : ChannelState;

/**
 * The sentence at the top of the panel. Per-channel rather than assembled from
 * a label and a phrase, because English will not agree with a template here:
 * the terminal *is* not connected, notifications *are* off.
 *
 * Effect first and cause second in the machine's two, because the reader
 * arrived at this panel already holding the effect.
 */
const SENTENCE: { [K in ChannelId]: Partial<Record<SentenceKey<K>, string>> } = {
  terminal: {
    degraded: "The terminal is reconnecting.",
    down: "The terminal is not connected.",
  },
  transcript: {
    degraded: "The transcript stream is reconnecting.",
    down: "The transcript stream is not connected.",
  },
  sessions: {
    degraded: "The session list is slow to refresh.",
    down: "The session list is not refreshing.",
  },
  notifications: {
    degraded: "Notifications may not arrive.",
    down: "Notifications are off.",
  },
  build: {
    degraded: "An update is ready.",
    down: "This page cannot check for updates.",
  },
  // No `fine` entry: a box under every line has nothing to say, and a working
  // channel never reaches this map anyway.
  machine: {
    busy: "Typing and commands may feel slow. The machine is busy.",
    "very-busy": "Typing and commands are slow right now. The machine is very busy.",
  },
};

/**
 * The machine's sentence for a tier, or null at `fine`, which has nothing to
 * say.
 *
 * Exported because the Right now panel prints this sentence on the machine ROW
 * itself, where the other five rows carry only their short detail phrase. The
 * alternative was to hand `verdict()` a one-element array and take what came
 * back, which works today only by coincidence: `verdict` answers "what is wrong
 * with this SET of channels", and its one-complaint branch happens to return
 * that channel's sentence. Anything that ever made `verdict` summarise
 * differently would silently change the row.
 */
export function machineSentence(tier: MachineTier): string | null {
  return SENTENCE.machine[tier] ?? null;
}

/** The sentence for one complaining channel, or undefined where the map has
 *  nothing for that combination. */
function sentenceFor(c: Channel): string | undefined {
  // The machine's TIER, not its state — see SENTENCE. A row that reached
  // degraded without saying how busy gets the quieter of the two, which is all
  // the threshold it crossed actually supports.
  if (c.id === "machine") return SENTENCE.machine[c.tier ?? "busy"];
  return SENTENCE[c.id][c.state];
}

export function verdict(channels: readonly Channel[]): string {
  const bad = problems(channels);
  if (bad.length === 0) {
    // WORKING, not connected: with a row that reports the box, "connected"
    // claims something narrower than the six rows above it check.
    return worst(channels) === "unknown" ? "Checking…" : "Everything is working.";
  }
  const only = bad.length === 1 ? bad[0] : undefined;
  if (only) return sentenceFor(only) ?? `${CHANNEL_LABEL[only.id]} needs attention.`;
  return `${bad.length} things need attention.`;
}

/**
 * Narrow a set of channels to the ones a surface can honestly report, in the
 * declared order, filling anything that has not reported with `unknown`.
 *
 * Filling rather than omitting is deliberate: a row that disappears reads as a
 * bug and cannot be asked about, while a row that says "not reporting" is
 * answering the question.
 */
export function scope(channels: readonly Channel[], ids: readonly ChannelId[]): Channel[] {
  return ids.map(
    (id) =>
      channels.find((c) => c.id === id) ?? {
        id,
        state: "unknown" as const,
        detail: channelPhrase(id, "unknown"),
      },
  );
}

export function terminalChannel(report: TerminalReport | null): Channel {
  if (!report) return { id: "terminal", state: "unknown", detail: "not reporting" };
  switch (report.state) {
    case "open":
      return { id: "terminal", state: "working", detail: "connected" };
    case "connecting":
      return {
        id: "terminal",
        state: "degraded",
        detail: report.attempt > 1 ? `reconnecting, attempt ${report.attempt}` : "connecting",
        ...(report.attempt > 1 ? { count: report.attempt } : {}),
      };
    // Battery saver closed the socket on purpose and the next visibility change
    // brings it back. Painting that red would report a fault the app caused
    // deliberately, on a phone that is behaving exactly as designed.
    case "suspended":
      return { id: "terminal", state: "working", detail: "paused to save battery" };
    case "offline":
      return { id: "terminal", state: "down", detail: "this device is offline" };
    case "closed":
      return { id: "terminal", state: "down", detail: "not connected" };
  }
}

export function transcriptChannel(status: SseStatus | null): Channel {
  if (status === null) return { id: "transcript", state: "unknown", detail: "not open" };
  switch (status) {
    case "open":
      return { id: "transcript", state: "working", detail: "streaming" };
    case "connecting":
      return { id: "transcript", state: "degraded", detail: "connecting" };
    case "reconnecting":
      return { id: "transcript", state: "degraded", detail: "reconnecting" };
    // session-events answers 404 for a tmux session no Claude ever ran in, and
    // a plain shell is a legitimate session. There is nothing to stream, which
    // is not the same as being broken.
    case "no-transcript":
      return { id: "transcript", state: "working", detail: "no transcript yet" };
    case "closed":
      return { id: "transcript", state: "down", detail: "not connected" };
  }
}

export function sessionsChannel(report: SessionsReport): Channel {
  if (report.lastOkMs === null) return { id: "sessions", state: "unknown", detail: "first check" };
  if (report.failures === 0) return { id: "sessions", state: "working", detail: "up to date" };
  const downMs = report.downMs ?? report.lastOkMs;
  if (downMs >= SESSIONS_DOWN_AFTER_MS) {
    return {
      id: "sessions",
      state: "down",
      detail: `no answer for ${Math.round(downMs / 1000)}s`,
    };
  }
  return { id: "sessions", state: "degraded", detail: "retrying" };
}

export function notificationsChannel(report: NotificationsReport): Channel {
  if (report.device === "unsupported" || report.permission === "unsupported") {
    return { id: "notifications", state: "unknown", detail: "not available in this browser" };
  }
  // NOT SET UP IS NOT BROKEN. Push off is the default state of a fresh browser
  // and a deliberate choice in a browser that refused it — neither is a fault of
  // this client, and painting the badge red for it teaches people to ignore the
  // badge. (Caught by opening the real page: a browser that had never subscribed
  // made the whole client read "Offline" while every connection was healthy.)
  // The row still says so plainly, and still offers Turn on.
  if (report.permission === "denied") {
    return { id: "notifications", state: "unknown", detail: "blocked by the browser" };
  }
  if (report.device === "no") {
    return { id: "notifications", state: "unknown", detail: "off for this device" };
  }
  // The silent failure this row exists for. Everything local reads healthy —
  // permission granted, subscription in hand — while the server dropped the
  // endpoint after a 410 and nothing has been delivered since.
  if (report.server === "missing") {
    return {
      id: "notifications",
      state: "degraded",
      detail: "the server has no record of this device",
    };
  }
  return { id: "notifications", state: "working", detail: "on" };
}

export function buildChannel(report: { updateReady: boolean }): Channel {
  // Degraded, never down. A tab running old JavaScript against a new server is
  // a fault worth naming — it looks exactly like a broken connection — but the
  // page in front of the reader is still working.
  return report.updateReady
    ? { id: "build", state: "degraded", detail: "update ready" }
    : { id: "build", state: "working", detail: "up to date" };
}

/**
 * What a stalled resource is called on the row. The panel prints the three
 * percentages directly above it, so the row itself owes the reader the plain
 * sentence rather than a second copy of the numbers: someone holding a slow
 * terminal can act on "waiting on the disk" and cannot act on "io_full 62%".
 */
const RESOURCE_PHRASE: Record<MachineResource, string> = {
  cpu: "the processor is busy",
  io: "waiting on the disk",
  memory: "low on memory",
  // Only reachable on the fallback path, which machineDetail answers before it
  // gets here. Present because the map is exhaustive over MachineResource, and
  // an exhaustive map is what makes a new resource a compile error rather than
  // a blank phrase on screen.
  load: "busy",
};

function machineDetail(report: MachineReport, state: ChannelState): string {
  // NO PRESSURE ON THIS KERNEL, so the row says what it IS reading instead of
  // presenting a coarser number as the same one. ADR-0016's reasoning carries:
  // a row that explains itself can be asked about, while one that disappears
  // reads as a bug. Load average is a single figure for the whole box, so there
  // is no resource to name here and naming one would be an invention.
  if (report.source === "load") {
    return state === "working" ? "Fine, by load average" : "busy, by load average";
  }
  if (state === "working") return "Fine";
  return RESOURCE_PHRASE[report.worst];
}

/**
 * What the box itself is doing, from tmux-api's health verdict.
 *
 * AMBER AT WORST, and the clamp below is where that is enforced rather than
 * assumed. `degraded` means wait and `down` means act: there is no action to
 * take about a busy machine, and the box is plainly not down, because this
 * reading came from it. If load ever gets bad enough to break the poll, the
 * session-list channel turns red on its own row, which is the accurate
 * statement — so red keeps its single meaning here, "you are disconnected".
 */
export function machineChannel(report: MachineReport | null): Channel {
  // Not reporting is not a fault. The reading rides the session-list poll, so
  // it is absent for the first seconds of every page, and for the whole life of
  // a page talking to a server too old to send it.
  if (!report || report.source === "unknown") {
    return { id: "machine", state: "unknown", detail: "not reporting" };
  }
  // A READING WITH TOO SHORT A WINDOW IS NOT THE SAME AS NO READING. tmux-api
  // fills in every figure from the first sample but withholds the verdict until
  // it has four minutes of history, because the thresholds are ten-minute rates
  // and a narrower one crosses a line at a rate nobody calibrated. Both arrive
  // here as `unknown`, and they must not say the same thing: the row shows the
  // figures underneath, so "not reporting" printed above a live "Disk 84%"
  // contradicts itself on screen.
  if (report.state === "unknown") {
    return { id: "machine", state: "unknown", detail: "still measuring" };
  }
  const state: ChannelState = report.state === "working" ? "working" : "degraded";
  return { id: "machine", state, detail: machineDetail(report, state), tier: report.tier };
}

/** One channel changing state, kept in memory for the life of the page. */
export interface StatusEvent {
  id: ChannelId;
  from: ChannelState;
  to: ChannelState;
  /** epoch ms. */
  at: number;
}

export interface ChannelHistory {
  /** how many times this channel fell out of working since the page loaded. */
  faults: number;
  /** when the most recent fall was, or null if there has not been one. */
  lastFaultAt: number | null;
}

/**
 * What a channel's log says about it — the difference between a bad link and a
 * broken one, which "right now" cannot express.
 *
 * A FAULT IS A FALL, NOT A TRANSITION. One drop, the reconnect ladder climbing,
 * and recovery is a single fault. Counting every state change would report a
 * channel that recovered cleanly as three times worse than it was, and the
 * number people read here is the one they quote back.
 */
export function summarise(log: readonly StatusEvent[], id: ChannelId): ChannelHistory {
  let faults = 0;
  let lastFaultAt: number | null = null;
  for (const e of log) {
    if (e.id !== id) continue;
    // Reaching `unknown` is not a fault: a terminal that stopped reporting has
    // not failed, and saying so would make a reload look like an outage.
    if (e.to === "unknown") continue;
    // A fall FROM working, or a channel whose FIRST observation is already
    // dead — that one never "fell", and reporting zero for it would read as a
    // clean history.
    //
    // What this must NOT count is an ordinary first connect. Every channel
    // starts `unknown` and passes through `degraded` on its way up, so counting
    // unknown→degraded made a freshly opened terminal say "dropped once" about
    // a socket that had never dropped. (Caught by opening the real page.)
    const fell = e.from === "working" && e.to !== "working";
    const arrivedDead = e.from === "unknown" && e.to === "down";
    if (fell || arrivedDead) {
      faults += 1;
      lastFaultAt = e.at;
    }
  }
  return { faults, lastFaultAt };
}

/** The fallback phrase for a channel in a state, used where no live detail
 *  exists yet — a scoped-in row nothing has reported, or a check that has not
 *  run. */
export function channelPhrase(id: ChannelId, state: ChannelState): string {
  // The terminal and the machine are the two nobody asks: one reports itself,
  // the other rides the session poll. A row that has not heard from either has
  // not failed a check, so it must not say it has.
  if (state === "unknown") {
    return id === "terminal" || id === "machine" ? "not reporting" : "not checked yet";
  }
  switch (id) {
    case "terminal":
      return state === "working" ? "connected" : state === "degraded" ? "reconnecting" : "offline";
    case "transcript":
      return state === "working" ? "streaming" : state === "degraded" ? "reconnecting" : "offline";
    case "sessions":
      return state === "working" ? "up to date" : state === "degraded" ? "retrying" : "not refreshing";
    case "notifications":
      return state === "working" ? "on" : state === "degraded" ? "may not arrive" : "off";
    case "build":
      return state === "working" ? "up to date" : state === "degraded" ? "update ready" : "unknown";
    // The machine never reaches `down` (see machineChannel), so the last arm is
    // unreachable through it and says the only true thing left rather than
    // inventing a fault the box cannot have.
    case "machine":
      return state === "working" ? "Fine" : "busy";
  }
}
