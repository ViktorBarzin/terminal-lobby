/**
 * Connection status — the model behind the dot, the Right now panel and the
 * check (docs/adr/0016-connection-status-in-the-ui.md).
 *
 * A client keeps five **channels**, and until the ADR a person could see two of
 * them: the transcript stream had a badge in the session bar, and the terminal
 * socket painted a pill of its own. The session list, notifications and a stale
 * build reported nothing at all, which is why "it stopped working" had no
 * answer a user could reach on their own.
 *
 * The word "channel" belongs to this file, CONTEXT.md and the ADR. It is never
 * shown on screen: the rows are labelled Terminal, Transcript, Session list,
 * Notifications and Build, and five labelled rows do not need a category name
 * above them.
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

export type ChannelId = "terminal" | "transcript" | "sessions" | "notifications" | "build";

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
] as const;

/**
 * What the sidebar can honestly report. The list screen has no terminal and no
 * transcript, so a session's dead socket must not colour a badge sitting above
 * a list of sessions — it would name the wrong problem on the one screen that
 * cannot show the right one.
 */
export const LOBBY_CHANNELS: readonly ChannelId[] = ["sessions", "notifications", "build"] as const;

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  terminal: "Terminal",
  transcript: "Transcript",
  sessions: "Session list",
  notifications: "Notifications",
  build: "Build",
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
 * The word beside the badge's dot, or null to leave the dot on its own.
 *
 * Healthy is the state 99% of the time, and it does not earn text in a session
 * bar that is already tight on a phone. A problem does.
 */
export function badgeWord(channels: readonly Channel[]): string | null {
  const w = worst(channels);
  if (w === "working" || w === "unknown") return null;
  const bad = problems(channels);
  // A stale build is degraded, but "Reconnecting" would be a lie about it: the
  // link is fine and the page is old. It only gets to speak when it is the
  // whole complaint — a real connection problem outranks an update.
  if (bad.every((c) => c.id === "build")) return "Update ready";
  if (w === "down") return "Offline";
  // The count comes from the channel the word is ABOUT — the first degraded
  // connection in row order — not from whichever channel happens to carry one.
  const lead = bad.find((c) => c.state === "degraded" && c.id !== "build");
  return lead?.count ? `Reconnecting ${lead.count}` : "Reconnecting";
}

/**
 * The sentence at the top of the panel. Per-channel rather than assembled from
 * a label and a phrase, because English will not agree with a template here:
 * the terminal *is* not connected, notifications *are* off.
 */
const SENTENCE: Record<ChannelId, Partial<Record<ChannelState, string>>> = {
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
};

export function verdict(channels: readonly Channel[]): string {
  const bad = problems(channels);
  if (bad.length === 0) {
    return worst(channels) === "unknown" ? "Checking…" : "Everything is connected.";
  }
  const only = bad.length === 1 ? bad[0] : undefined;
  if (only) return SENTENCE[only.id][only.state] ?? `${CHANNEL_LABEL[only.id]} needs attention.`;
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
  if (state === "unknown") return id === "terminal" ? "not reporting" : "not checked yet";
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
  }
}
