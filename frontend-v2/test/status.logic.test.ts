import { describe, it, expect } from "vitest";
import {
  CHANNEL_LABEL,
  LOBBY_CHANNELS,
  SESSION_CHANNELS,
  badgeWord,
  buildChannel,
  channelPhrase,
  notificationsChannel,
  scope,
  sessionsChannel,
  summarise,
  terminalChannel,
  transcriptChannel,
  verdict,
  worst,
  type Channel,
  type ChannelId,
  type ChannelState,
} from "../src/diagnostics/status";

const ch = (id: ChannelId, state: ChannelState, detail = ""): Channel => ({ id, state, detail });

describe("worst-of", () => {
  it("is working when everything works", () => {
    expect(worst([ch("terminal", "working"), ch("build", "working")])).toBe("working");
  });

  it("lets one degraded channel colour the whole", () => {
    expect(worst([ch("terminal", "working"), ch("transcript", "degraded")])).toBe("degraded");
  });

  it("lets down beat degraded", () => {
    expect(worst([ch("transcript", "degraded"), ch("terminal", "down")])).toBe("down");
  });

  /**
   * The point of the fourth state. A terminal that has not reported yet — a
   * booting iframe, a cached older build with no such message, someone reading
   * term.html directly — must never paint the badge as if something failed.
   */
  it("never counts an unknown channel as a fault", () => {
    expect(worst([ch("terminal", "unknown"), ch("build", "working")])).toBe("working");
    expect(worst([ch("terminal", "unknown"), ch("transcript", "degraded")])).toBe("degraded");
  });

  it("is unknown only when nothing has reported", () => {
    expect(worst([ch("terminal", "unknown")])).toBe("unknown");
    expect(worst([])).toBe("unknown");
  });
});

describe("the badge's word", () => {
  it("stays silent while everything works, so the dot carries it alone", () => {
    expect(badgeWord([ch("terminal", "working"), ch("build", "working")])).toBeNull();
  });

  it("says Offline for anything down", () => {
    expect(badgeWord([ch("terminal", "down"), ch("build", "working")])).toBe("Offline");
  });

  it("says Reconnecting for a connection still trying", () => {
    expect(badgeWord([ch("transcript", "degraded")])).toBe("Reconnecting");
  });

  /**
   * A stale build is degraded, but "Reconnecting" would be a lie about it — the
   * link is fine and the page is old. It gets its own word, and only when it is
   * the sole complaint: a real connection problem outranks an update.
   */
  it("says Update ready when the build alone is behind", () => {
    expect(badgeWord([ch("build", "degraded"), ch("terminal", "working")])).toBe("Update ready");
  });

  it("prefers the connection problem when both are true", () => {
    expect(badgeWord([ch("build", "degraded"), ch("terminal", "degraded")])).toBe("Reconnecting");
  });

  it("is silent for an unknown-only set", () => {
    expect(badgeWord([ch("terminal", "unknown")])).toBeNull();
  });

  /**
   * The badge is now the ONLY connection indicator on a session screen — the
   * terminal's own pill defers to it — so it has to carry the attempt number
   * the pill used to show. Without it, "Reconnecting" sits there unchanging and
   * a reader cannot tell a ladder that is climbing from one that is stuck.
   */
  it("carries the retry attempt when the channel counts one", () => {
    expect(badgeWord([{ ...ch("terminal", "degraded"), count: 7 }])).toBe("Reconnecting 7");
  });

  it("says just Reconnecting on a first connect, which has no attempt to show", () => {
    expect(badgeWord([ch("terminal", "degraded")])).toBe("Reconnecting");
  });

  it("takes the count from the channel the word is about, not another", () => {
    expect(
      badgeWord([
        { ...ch("terminal", "degraded"), count: 4 },
        { ...ch("build", "degraded"), count: 99 },
      ]),
    ).toBe("Reconnecting 4");
  });

  it("does not count an Offline badge", () => {
    expect(badgeWord([{ ...ch("terminal", "down"), count: 9 }])).toBe("Offline");
  });
});

describe("the panel's verdict", () => {
  it("says so plainly when nothing is wrong", () => {
    expect(verdict([ch("terminal", "working"), ch("sessions", "working")])).toBe(
      "Everything is connected.",
    );
  });

  it("names the one thing that is wrong", () => {
    expect(verdict([ch("terminal", "down"), ch("sessions", "working")])).toBe(
      "The terminal is not connected.",
    );
    expect(verdict([ch("notifications", "down")])).toBe("Notifications are off.");
    expect(verdict([ch("build", "degraded")])).toBe("An update is ready.");
  });

  it("counts them when several are wrong", () => {
    expect(verdict([ch("terminal", "down"), ch("sessions", "degraded")])).toBe(
      "2 things need attention.",
    );
  });

  /** An unknown channel is not a thing needing attention, so it must not be counted. */
  it("does not count what has not reported", () => {
    expect(verdict([ch("terminal", "unknown"), ch("sessions", "working")])).toBe(
      "Everything is connected.",
    );
  });

  it("admits when it knows nothing at all", () => {
    expect(verdict([ch("terminal", "unknown")])).toBe("Checking…");
  });
});

describe("scoping to what is on screen", () => {
  /**
   * The badge appears in two places and must only ever report channels the
   * surface it sits on actually has. The sidebar has no terminal and no
   * transcript, so a session's dead socket must not paint the session list red.
   */
  it("drops the per-session channels outside a session", () => {
    const all: Channel[] = [
      ch("terminal", "down"),
      ch("transcript", "down"),
      ch("sessions", "working"),
      ch("notifications", "working"),
      ch("build", "working"),
    ];
    expect(scope(all, LOBBY_CHANNELS).map((c) => c.id)).toEqual([
      "sessions",
      "notifications",
      "build",
    ]);
    expect(worst(scope(all, LOBBY_CHANNELS))).toBe("working");
    expect(worst(scope(all, SESSION_CHANNELS))).toBe("down");
  });

  it("keeps the rows in their declared order, not the order they arrived", () => {
    const jumbled: Channel[] = [ch("build", "working"), ch("terminal", "working")];
    expect(scope(jumbled, SESSION_CHANNELS).map((c) => c.id)).toEqual([
      "terminal",
      "transcript",
      "sessions",
      "notifications",
      "build",
    ]);
  });

  it("fills a channel that has said nothing with unknown", () => {
    expect(scope([], LOBBY_CHANNELS).every((c) => c.state === "unknown")).toBe(true);
  });

  it("has a label for every channel", () => {
    for (const id of SESSION_CHANNELS) expect(CHANNEL_LABEL[id]).toBeTruthy();
  });
});

describe("the terminal channel", () => {
  it("is unknown until the terminal reports", () => {
    expect(terminalChannel(null).state).toBe("unknown");
    expect(terminalChannel(null).detail).toBe("not reporting");
  });

  it("is working with the socket open", () => {
    expect(terminalChannel({ state: "open", attempt: 0 }).state).toBe("working");
  });

  it("is degraded while the ladder is climbing, and counts the attempt", () => {
    const c = terminalChannel({ state: "connecting", attempt: 3 });
    expect(c.state).toBe("degraded");
    expect(c.detail).toBe("reconnecting, attempt 3");
    // The badge reads this, now that the terminal's own pill defers to it.
    expect(c.count).toBe(3);
  });

  it("carries no count on a first connect", () => {
    expect(terminalChannel({ state: "connecting", attempt: 1 }).count).toBeUndefined();
  });

  it("does not say attempt 1 for a first connect", () => {
    expect(terminalChannel({ state: "connecting", attempt: 1 }).detail).toBe("connecting");
  });

  it("is down when the browser knows it is offline", () => {
    expect(terminalChannel({ state: "offline", attempt: 2 }).state).toBe("down");
  });

  /**
   * Battery saver takes the socket down on purpose and reconnects on the next
   * visibility change. Painting that red would report a fault the app caused
   * deliberately, on a phone that is behaving correctly.
   */
  it("does not call a battery-saver suspend a fault", () => {
    const c = terminalChannel({ state: "suspended", attempt: 0 });
    expect(c.state).toBe("working");
    expect(c.detail).toBe("paused to save battery");
  });

  it("is down once the socket is closed with no ladder running", () => {
    expect(terminalChannel({ state: "closed", attempt: 0 }).state).toBe("down");
  });
});

describe("the transcript channel", () => {
  it("maps the stream's own statuses", () => {
    expect(transcriptChannel("open").state).toBe("working");
    expect(transcriptChannel("connecting").state).toBe("degraded");
    expect(transcriptChannel("reconnecting").state).toBe("degraded");
    expect(transcriptChannel("closed").state).toBe("down");
  });

  /**
   * session-events answers 404 for a tmux session no Claude ever ran in, and a
   * plain shell is a legitimate session. The stream has nothing to carry, which
   * is not the same as being broken — the existing badge went out of its way to
   * keep those apart and this must not undo it.
   */
  it("treats a session with no transcript as working", () => {
    const c = transcriptChannel("no-transcript");
    expect(c.state).toBe("working");
    expect(c.detail).toBe("no transcript yet");
  });

  it("is unknown before the view has opened a stream", () => {
    expect(transcriptChannel(null).state).toBe("unknown");
  });
});

describe("the session-list channel", () => {
  const ok = { failures: 0, lastOkMs: 2_000, downMs: null };

  it("is working on a healthy poll", () => {
    expect(sessionsChannel(ok).state).toBe("working");
  });

  /**
   * The one channel that is not a persistent connection. A poll on its backoff
   * ladder is still working, just slowly, which is exactly what degraded means.
   */
  it("is degraded while the backoff ladder is climbing", () => {
    expect(sessionsChannel({ failures: 2, lastOkMs: 12_000, downMs: 12_000 }).state).toBe(
      "degraded",
    );
  });

  it("is down once the ladder has been failing long enough to mean it", () => {
    const c = sessionsChannel({ failures: 6, lastOkMs: 90_000, downMs: 90_000 });
    expect(c.state).toBe("down");
    expect(c.detail).toContain("90");
  });

  it("is unknown before the first poll returns", () => {
    expect(sessionsChannel({ failures: 0, lastOkMs: null, downMs: null }).state).toBe("unknown");
  });
});

describe("the notifications channel", () => {
  it("is working when the device is subscribed and the server agrees", () => {
    expect(
      notificationsChannel({ permission: "granted", device: "yes", server: "holds" }).state,
    ).toBe("working");
  });

  /**
   * NOT SET UP IS NOT BROKEN, and this is the case that proved it: a browser
   * that had never subscribed made the whole badge read "Offline" while every
   * connection was healthy. Push off is the default state of a fresh browser
   * and a deliberate choice in one that refused it. Neither is this client
   * failing, and a badge that goes red for it is a badge people learn to
   * ignore. The row still says so, and still offers Turn on.
   */
  it("does not call a browser refusal a fault", () => {
    const c = notificationsChannel({ permission: "denied", device: "no", server: "unknown" });
    expect(c.state).toBe("unknown");
    expect(c.detail).toBe("blocked by the browser");
  });

  it("does not call a device that never subscribed a fault", () => {
    const c = notificationsChannel({ permission: "default", device: "no", server: "unknown" });
    expect(c.state).toBe("unknown");
    expect(c.detail).toBe("off for this device");
  });

  it("keeps push out of the badge entirely until it is actually in use", () => {
    const off = notificationsChannel({ permission: "default", device: "no", server: "unknown" });
    expect(worst([off, ch("terminal", "working")])).toBe("working");
    expect(badgeWord([off, ch("terminal", "working")])).toBeNull();
  });

  /**
   * The silent failure this row exists for: the browser still holds a
   * subscription, so everything local reads healthy, while the server dropped
   * the endpoint after a 410 and nothing has been delivered since.
   */
  it("is degraded when the server no longer holds this device", () => {
    const c = notificationsChannel({ permission: "granted", device: "yes", server: "missing" });
    expect(c.state).toBe("degraded");
    expect(c.detail).toBe("the server has no record of this device");
  });

  it("is unknown where the browser cannot do push at all", () => {
    expect(
      notificationsChannel({ permission: "default", device: "unsupported", server: "unknown" })
        .state,
    ).toBe("unknown");
  });
});

describe("the build channel", () => {
  it("is working on the current build", () => {
    expect(buildChannel({ updateReady: false }).state).toBe("working");
  });

  it("is degraded, never down, when an update is waiting", () => {
    const c = buildChannel({ updateReady: true });
    expect(c.state).toBe("degraded");
    expect(c.detail).toBe("update ready");
  });
});

describe("what happened since this page loaded", () => {
  const at = (ms: number, id: ChannelId, from: ChannelState, to: ChannelState) => ({
    id,
    from,
    to,
    at: ms,
  });

  it("counts nothing on a channel that never faltered", () => {
    const s = summarise([], "terminal");
    expect(s.faults).toBe(0);
    expect(s.lastFaultAt).toBeNull();
  });

  /** One drop, the ladder climbing, then recovery is ONE fault. Counting every
   *  transition would report a flapping channel as far worse than it was. */
  it("counts each fall out of working, not each transition", () => {
    const log = [
      at(1_000, "terminal", "working", "degraded"),
      at(2_000, "terminal", "degraded", "down"),
      at(9_000, "terminal", "down", "working"),
    ];
    expect(summarise(log, "terminal").faults).toBe(1);
  });

  it("counts a second fall separately", () => {
    const log = [
      at(1_000, "terminal", "working", "down"),
      at(4_000, "terminal", "down", "working"),
      at(8_000, "terminal", "working", "degraded"),
    ];
    const s = summarise(log, "terminal");
    expect(s.faults).toBe(2);
    expect(s.lastFaultAt).toBe(8_000);
  });

  it("ignores other channels' history", () => {
    const log = [
      at(1_000, "transcript", "working", "down"),
      at(2_000, "terminal", "working", "down"),
    ];
    expect(summarise(log, "terminal").faults).toBe(1);
  });

  /** Arriving already broken is a fault too: a channel whose first observation
   *  is down never "fell", and reporting zero would read as a clean history. */
  it("counts a channel that was never seen working", () => {
    expect(summarise([at(1_000, "sessions", "unknown", "down")], "sessions").faults).toBe(1);
  });

  /**
   * But an ordinary first connect is not a drop. Every channel starts `unknown`
   * and climbs through `degraded` on its way up, and counting that made a
   * freshly opened terminal report "dropped once" about a socket that had never
   * dropped — visible on the real page the first time a session was opened.
   */
  it("does not count the climb from unknown up to working", () => {
    const firstConnect = [
      at(1_000, "terminal", "unknown", "degraded"),
      at(2_000, "terminal", "degraded", "working"),
    ];
    expect(summarise(firstConnect, "terminal").faults).toBe(0);
  });

  it("does not count reaching unknown as a fault", () => {
    expect(summarise([at(1_000, "terminal", "working", "unknown")], "terminal").faults).toBe(0);
  });
});

describe("row phrasing", () => {
  it("gives every state of every channel a phrase", () => {
    const states: ChannelState[] = ["working", "degraded", "down", "unknown"];
    for (const id of SESSION_CHANNELS) {
      for (const state of states) expect(channelPhrase(id, state)).toBeTruthy();
    }
  });
});
