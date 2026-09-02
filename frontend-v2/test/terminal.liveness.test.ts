import { describe, it, expect } from "vitest";
import {
  LIVENESS_DEFAULTS,
  WS_PROBE_FRAME_BYTE,
  backpressureSignal,
  beginProbe,
  decide,
  echoWatchArmed,
  idleWatch,
  livenessSocketState,
  noteSendFailure,
  noteTyped,
  probeFrame,
  reachabilitySignal,
  reanchor,
  settleProbe,
  watchSocket,
  type LivenessInput,
  type Watch,
} from "../src/terminal/liveness";

const T0 = 1_000_000; // an arbitrary "now"; every test is relative to it
const { probeMs, echoGraceMs, strikes: STRIKE_LIMIT } = LIVENESS_DEFAULTS;

/** A healthy, visible, open socket that has just been probed. */
function ask(over: Partial<LivenessInput> = {}): LivenessInput {
  return {
    now: T0,
    lastInboundAt: T0,
    socketState: "open",
    visible: true,
    batterySuspended: false,
    watch: watchSocket(T0),
    ...over,
  };
}

const withStrikes = (watch: Watch, strikes: number): Watch => ({ ...watch, strikes });

/** A probe that found the socket healthy on both signals. */
const CLEAN = { reachability: "alive", backpressure: "alive" } as const;

describe("when to probe", () => {
  it("probes an open socket once the cadence comes due", () => {
    expect(decide(ask({ now: T0 + probeMs })).action).toBe("probe");
  });

  it("waits until the cadence comes due, and says how long", () => {
    const d = decide(ask({ now: T0 + 10_000 }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(probeMs - 10_000);
  });

  /**
   * A socket still CONNECTING has its own handshake deadline and a closed one
   * has the reconnect ladder. Probing either puts a second voice in charge of a
   * connection that already has one.
   */
  it("never probes a socket that is still connecting", () => {
    const d = decide(ask({ socketState: "connecting", now: T0 + 10 * probeMs }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(Infinity);
  });

  it("never probes a closed socket", () => {
    expect(decide(ask({ socketState: "closed", now: T0 + 10 * probeMs })).action).toBe("wait");
  });

  /**
   * A hidden tab's timers and fetches are throttled hard enough to manufacture
   * false strikes, so the watchdog stands down entirely rather than convicting
   * a healthy socket on the browser's own battery saving.
   */
  it("never probes a hidden tab, whose throttling would manufacture strikes", () => {
    const d = decide(ask({ visible: false, now: T0 + 10 * probeMs }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(Infinity);
  });

  it("never probes while the battery saver is holding the socket down", () => {
    expect(decide(ask({ batterySuspended: true, now: T0 + 10 * probeMs })).action).toBe("wait");
  });

  it("does not start a second probe while one is still settling", () => {
    const watch = beginProbe(watchSocket(T0), T0);
    expect(decide(ask({ watch, now: T0 + 10 * probeMs })).action).toBe("wait");
  });

  it("does not probe a socket nobody armed the watchdog for", () => {
    const d = decide(ask({ watch: idleWatch(), now: T0 + 10 * probeMs }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(Infinity);
  });
});

describe("silence, which is not evidence", () => {
  /**
   * THE rule that keeps this watchdog usable. An idle terminal is legitimately
   * silent for hours, so "no inbound data for N seconds" can never on its own
   * convict a socket — however long the silence, the answer is a probe, never a
   * verdict.
   */
  it("never declares an idle terminal dead, however long it has been silent", () => {
    const anHour = 3_600_000;
    const quiet = ask({ now: T0 + anHour, lastInboundAt: T0 - anHour });
    expect(decide(quiet).action).toBe("probe");
    const probed = settleProbe(beginProbe(quiet.watch, T0 + anHour), CLEAN);
    expect(decide({ ...quiet, watch: probed }).action).toBe("wait");
  });

  it("does not treat a socket that has never said anything as dead", () => {
    const d = decide(ask({ lastInboundAt: null, now: T0 + 5_000 }));
    expect(d.action).toBe("wait");
  });
});

describe("the echo watch, which brings a probe forward", () => {
  const typed = (at: number, watch = watchSocket(T0)) => noteTyped(watch, at, T0);

  /**
   * A keystroke that goes out and produces nothing is the cheapest evidence a
   * socket is black-holed. Without this the watchdog reaches the same verdict up
   * to three 25s intervals later, and every key typed into that gap is lost with
   * the connection still reading healthy.
   */
  it("probes early when a keystroke goes out and nothing comes back", () => {
    const watch = typed(T0 + 1_000);
    const d = decide(ask({ watch, now: T0 + 1_000 + echoGraceMs, lastInboundAt: T0 }));
    expect(d.action).toBe("probe");
    expect(d.reason).toContain("keystroke");
  });

  it("leaves the pty its grace before probing", () => {
    const watch = typed(T0 + 1_000);
    const d = decide(ask({ watch, now: T0 + 1_000 + echoGraceMs - 1, lastInboundAt: T0 }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(1);
  });

  it("stands down once the pty answers the keystroke", () => {
    const watch = typed(T0 + 1_000);
    const answered = T0 + 1_100;
    const d = decide(ask({ watch, now: T0 + 1_000 + echoGraceMs, lastInboundAt: answered }));
    expect(d.action).toBe("wait");
  });

  /**
   * One watch per burst. If every keystroke re-armed it, someone typing steadily
   * into a black-holed socket would push the deadline forward for as long as
   * they kept typing — the exact person the early probe is for.
   */
  it("keeps the first keystroke's deadline while a burst keeps typing", () => {
    let watch = typed(T0 + 1_000);
    watch = noteTyped(watch, T0 + 1_200, T0);
    watch = noteTyped(watch, T0 + 1_400, T0);
    expect(watch.typedAt).toBe(T0 + 1_000);
    expect(decide(ask({ watch, now: T0 + 1_000 + echoGraceMs, lastInboundAt: T0 })).action).toBe(
      "probe",
    );
  });

  it("re-arms on the first keystroke after an answer", () => {
    let watch = typed(T0 + 1_000);
    watch = noteTyped(watch, T0 + 3_000, T0 + 2_000); // the pty answered at 2_000
    expect(watch.typedAt).toBe(T0 + 3_000);
    expect(echoWatchArmed(watch, T0 + 2_000)).toBe(true);
  });

  it("counts a frame arriving in the same millisecond as the answer", () => {
    const watch = typed(T0 + 1_000);
    expect(echoWatchArmed(watch, T0 + 1_000)).toBe(false);
  });

  it("never arms itself for a terminal nobody is typing into", () => {
    expect(echoWatchArmed(watchSocket(T0), null)).toBe(false);
  });

  it("forgets a keystroke the replaced socket was waiting on", () => {
    const stale = typed(T0 + 1_000);
    expect(watchSocket(T0 + 5_000).typedAt).toBeNull();
    expect(stale.typedAt).not.toBeNull(); // the old watch is untouched, not mutated
  });

  it("reports the sooner of the echo deadline and the cadence", () => {
    const watch = typed(T0 + 1_000);
    const d = decide(ask({ watch, now: T0 + 1_000, lastInboundAt: T0 }));
    expect(d.dueInMs).toBe(echoGraceMs);
  });

  /**
   * A sudo password, `read -s`, a gpg passphrase: the keystrokes go out and the
   * pty answers NOTHING, ever, on a socket that is perfectly healthy. term.html
   * survives that because its echo watch is a one-shot — the timeout nulls
   * itself BEFORE it probes — so the burst buys exactly one early probe and the
   * 25s cadence takes over again. A watch that never stands down instead answers
   * "probe now" every time it is asked: a probe spin on a working connection,
   * paid for out of the battery budget the cadence exists to protect.
   */
  it("buys one early probe per burst, then hands the terminal back to the cadence", () => {
    let watch = noteTyped(watchSocket(T0), T0, null);
    let now = T0 + echoGraceMs;
    const probedAt: number[] = [];
    // Six turns of the component's own loop: ask, act, sleep for as long as the
    // answer said, ask again.
    for (let turn = 0; turn < 6; turn++) {
      const d = decide(ask({ watch, now, lastInboundAt: null }));
      if (d.action === "probe") {
        probedAt.push(now - T0);
        watch = settleProbe(beginProbe(watch, now), CLEAN);
        now += 1;
      } else {
        expect(d.action).toBe("wait");
        now += d.dueInMs;
      }
    }
    expect(probedAt).toEqual([echoGraceMs, echoGraceMs + probeMs, echoGraceMs + 2 * probeMs]);
  });

  it("stands the watch down as soon as the probe it asked for goes out", () => {
    const fired = beginProbe(noteTyped(watchSocket(T0), T0, null), T0 + echoGraceMs);
    expect(fired.typedAt).toBeNull();
    expect(echoWatchArmed(fired, null)).toBe(false);
  });

  /**
   * term.html re-arms on the next keystroke, not on the next answer: after the
   * one-shot has fired, `echoWatchTimer` is null, so the following key starts a
   * fresh watch. Someone still typing their password into a black-holed socket
   * keeps getting early probes, one per grace period.
   */
  it("re-arms on the next keystroke after the probe, with the pty still silent", () => {
    let watch = noteTyped(watchSocket(T0), T0, null);
    watch = settleProbe(beginProbe(watch, T0 + echoGraceMs), CLEAN);
    watch = noteTyped(watch, T0 + 2_000, null);
    expect(watch.typedAt).toBe(T0 + 2_000);
    const d = decide(ask({ watch, now: T0 + 2_000 + echoGraceMs, lastInboundAt: null }));
    expect(d.action).toBe("probe");
    expect(d.reason).toContain("keystroke");
  });

  /**
   * The cadence probe is a different timer and never touched `echoWatchTimer`.
   * A probe that merely happened to land inside the grace period must not eat
   * the keystroke's early reading — that would quietly delete the echo watch for
   * anyone typing within 25s of a probe, which is most typing.
   */
  it("leaves the watch armed when a cadence probe happens to run inside the grace", () => {
    let watch = noteTyped(watchSocket(T0), T0 + 1_000, T0);
    watch = settleProbe(beginProbe(watch, T0 + 1_100), CLEAN);
    expect(watch.typedAt).toBe(T0 + 1_000);
    const d = decide(ask({ watch, now: T0 + 1_000 + echoGraceMs, lastInboundAt: T0 }));
    expect(d.action).toBe("probe");
    expect(d.reason).toContain("keystroke");
  });
});

describe("coming back to the tab", () => {
  /**
   * The second half of term.html's visibilitychange rule: `armLivenessProbe()`
   * re-anchors the cadence and `runLivenessProbe()` takes a reading on the spot,
   * because coming back is the moment a socket most often turns out to have died
   * unannounced while we were away. Re-anchoring alone hides a socket that died
   * in someone's pocket for a further 25s after they look at it.
   */
  it("takes a reading the moment the tab comes back, not a full interval later", () => {
    const d = decide(ask({ watch: reanchor(watchSocket(T0), T0 + 10_000), now: T0 + 10_000 }));
    expect(d.action).toBe("probe");
    expect(d.dueInMs).toBe(0);
    expect(d.reason).toContain("tab came back");
  });

  it("goes back to the cadence once that reading has been taken", () => {
    let watch = reanchor(watchSocket(T0), T0 + 10_000);
    watch = settleProbe(beginProbe(watch, T0 + 10_000), CLEAN);
    const d = decide(ask({ watch, now: T0 + 10_001 }));
    expect(d.action).toBe("wait");
    expect(d.dueInMs).toBe(probeMs - 1);
  });

  it("re-anchors the cadence to the moment of return", () => {
    const watch = reanchor(withStrikes(watchSocket(T0), 1), T0 + 10_000);
    expect(watch.anchorAt).toBe(T0 + 10_000);
    expect(decide(ask({ watch: beginProbe(watch, T0 + 10_000), now: T0 + 10_000 })).action).toBe(
      "wait",
    );
  });

  /**
   * A reading owed is still a reading, not a licence: the gates that stop a
   * probe going out at all — a socket the ladder owns, a hidden tab, a socket
   * the battery saver is holding down — all still win.
   */
  it("still obeys every gate that stops a probe going out", () => {
    const watch = reanchor(watchSocket(T0), T0 + 10_000);
    const now = T0 + 10_000;
    expect(decide(ask({ watch, now, visible: false })).action).toBe("wait");
    expect(decide(ask({ watch, now, batterySuspended: true })).action).toBe("wait");
    expect(decide(ask({ watch, now, socketState: "connecting" })).action).toBe("wait");
    expect(decide(ask({ watch: withStrikes(watch, STRIKE_LIMIT), now })).action).toBe(
      "declare-dead",
    );
  });

  /**
   * A settling probe CONSUMES the tab's request, as term.html does by returning
   * early from runLivenessProbe() on `livenessBusy` (term.html:10075) — the
   * request there is one call, not a mode that survives.
   *
   * An earlier revision kept the request, on the reasoning that the probe's
   * verdict would be discarded as not-still-visible and the return would be left
   * with no reading. That misread term.html, which samples document.hidden only
   * at settle (10102): for exactly this sequence it is visible at settle and
   * counts the probe. Keeping it fired a second probe the instant the first
   * landed — reachable by alt-tabbing away and back during the 2-6s a probe
   * takes, on every 25s cadence.
   */
  it("lets a settling probe consume the tab's request instead of probing twice", () => {
    let watch = beginProbe(watchSocket(T0), T0);
    watch = reanchor(watch, T0 + 5_000);
    expect(decide(ask({ watch, now: T0 + 5_000 })).action).toBe("wait");
    watch = settleProbe(watch, { ...CLEAN, stillVisible: false });
    expect(watch.readingDue).toBe(false);
    expect(decide(ask({ watch, now: T0 + 5_001 })).action).toBe("wait");
  });

  /**
   * The echo watch is a ONE-SHOT in term.html: its timer fires on its own
   * deadline whether or not a probe is running, and the probe it then asks for
   * is swallowed by the same busy guard. So a burst whose deadline elapses
   * mid-probe loses its early reading rather than banking it for the moment the
   * probe lands — which was one extra probe per burst, on any keystroke that
   * never echoes (a sudo password, read -s, a gpg passphrase).
   */
  it("spends an echo deadline that elapsed while a probe was in flight", () => {
    let watch = noteTyped(watchSocket(T0), T0);
    watch = beginProbe(watch, T0 + 100); // deadline has NOT passed yet
    expect(watch.typedAt).not.toBeNull();
    // ...it passes while the probe is settling, and settling spends it.
    watch = settleProbe(watch, CLEAN, LIVENESS_DEFAULTS, T0 + 4_000);
    expect(watch.typedAt).toBeNull();
    expect(decide(ask({ watch, now: T0 + 4_001 })).action).toBe("wait");
  });
});

describe("the strike ledger", () => {
  it("counts one strike per failed probe", () => {
    const after = settleProbe(watchSocket(T0), {
      reachability: "stalled",
      backpressure: "alive",
    });
    expect(after.strikes).toBe(1);
  });

  /**
   * Two signals, one probe. Counting a path that fails both as two strikes would
   * drop the socket a third sooner than the three-strike budget promises.
   */
  it("counts one strike even when both signals fail at once", () => {
    const after = settleProbe(watchSocket(T0), {
      reachability: "stalled",
      backpressure: "stalled",
    });
    expect(after.strikes).toBe(1);
  });

  it("strikes a jammed send buffer even though the origin answered", () => {
    const after = settleProbe(watchSocket(T0), {
      reachability: "alive",
      backpressure: "stalled",
    });
    expect(after.strikes).toBe(1);
  });

  it("clears the record when a probe passes both signals", () => {
    const after = settleProbe(withStrikes(watchSocket(T0), 2), {
      reachability: "alive",
      backpressure: "alive",
    });
    expect(after.strikes).toBe(0);
  });

  it("counts a send that threw as a strike of its own", () => {
    expect(noteSendFailure(withStrikes(watchSocket(T0), 1)).strikes).toBe(2);
  });

  /**
   * Re-anchoring happens every time the tab is shown. If it also cleared the
   * record, a phone glanced at every few seconds on a dead network would never
   * reach a verdict — a browser soak caught exactly that, four forced probes all
   * logging "strike 1/3".
   */
  it("keeps the strike record when the cadence is re-anchored", () => {
    const watch = reanchor(withStrikes(watchSocket(T0), 2), T0 + 40_000);
    expect(watch.strikes).toBe(2);
    expect(watch.anchorAt).toBe(T0 + 40_000);
  });

  it("gives a fresh socket a clean record", () => {
    expect(watchSocket(T0 + 1).strikes).toBe(0);
    expect(idleWatch().strikes).toBe(0);
  });

  /**
   * The probe was judging a socket that has since been replaced, so its reading
   * says nothing about the one now in place — in either direction.
   */
  it("ignores a verdict from a socket that was replaced mid-probe", () => {
    const busy = beginProbe(withStrikes(watchSocket(T0), 1), T0);
    const struck = settleProbe(busy, {
      reachability: "stalled",
      backpressure: "stalled",
      superseded: true,
    });
    expect(struck.strikes).toBe(1);
    const cleared = settleProbe(busy, {
      reachability: "alive",
      backpressure: "alive",
      superseded: true,
    });
    expect(cleared.strikes).toBe(1);
  });

  /**
   * A tab that hid mid-probe had its fetch and its timers throttled, so the
   * reading is evidence of nothing. It must neither strike the socket nor
   * absolve one already carrying strikes.
   */
  it("takes no verdict either way from a probe the tab hid during", () => {
    const busy = beginProbe(withStrikes(watchSocket(T0), 1), T0);
    expect(
      settleProbe(busy, { reachability: "stalled", backpressure: "stalled", stillVisible: false })
        .strikes,
    ).toBe(1);
    expect(
      settleProbe(busy, { reachability: "alive", backpressure: "alive", stillVisible: false })
        .strikes,
    ).toBe(1);
  });

  /**
   * Every settle path clears the in-flight flag, discarded readings included —
   * a probe whose verdict is thrown away would otherwise wedge the watchdog into
   * never probing again, which is worse than the failure it was watching for.
   */
  it("frees the watchdog for its next probe however a probe ends", () => {
    const busy = beginProbe(watchSocket(T0), T0);
    const outcomes = [
      { reachability: "alive", backpressure: "alive" },
      { reachability: "stalled", backpressure: "alive" },
      { reachability: "stalled", backpressure: "stalled", superseded: true },
      { reachability: "alive", backpressure: "alive", stillVisible: false },
    ] as const;
    for (const outcome of outcomes) {
      expect(settleProbe(busy, outcome).probeInFlight).toBe(false);
    }
    expect(noteSendFailure(busy).probeInFlight).toBe(false);
  });
});

describe("declaring the socket dead", () => {
  it("declares it dead once the strike budget is spent", () => {
    const d = decide(ask({ watch: withStrikes(watchSocket(T0), STRIKE_LIMIT) }));
    expect(d.action).toBe("declare-dead");
  });

  it("holds off while a strike remains", () => {
    const d = decide(ask({ watch: withStrikes(watchSocket(T0), STRIKE_LIMIT - 1) }));
    expect(d.action).not.toBe("declare-dead");
  });

  /**
   * The strikes were earned while the tab was visible. Hiding it a moment later
   * must not launder a socket that already failed every probe it was given —
   * the phone in a pocket is precisely where this failure happens.
   */
  it("keeps the verdict when the tab hides right after the last strike", () => {
    const dead = withStrikes(watchSocket(T0), STRIKE_LIMIT);
    expect(decide(ask({ watch: dead, visible: false })).action).toBe("declare-dead");
    expect(decide(ask({ watch: dead, batterySuspended: true })).action).toBe("declare-dead");
  });

  it("says nothing about a socket the ladder already owns", () => {
    const dead = withStrikes(watchSocket(T0), STRIKE_LIMIT);
    expect(decide(ask({ watch: dead, socketState: "closed" })).action).toBe("wait");
  });

  it("takes three failed probes, not two", () => {
    let watch = watchSocket(T0);
    const fail = { reachability: "stalled", backpressure: "alive" } as const;
    const verdicts: string[] = [];
    for (let i = 0; i < STRIKE_LIMIT; i++) {
      watch = settleProbe(beginProbe(watch, T0), fail);
      verdicts.push(decide(ask({ watch })).action);
    }
    expect(verdicts).toEqual(["wait", "wait", "declare-dead"]);
  });

  /**
   * A socket that recovers on the third probe has to be forgiven completely, or
   * a link that hiccups once an hour would be dropped after three unrelated
   * hiccups spread over an afternoon.
   */
  it("forgives a socket that recovers before the third strike", () => {
    let watch = settleProbe(watchSocket(T0), { reachability: "stalled", backpressure: "alive" });
    watch = settleProbe(watch, { reachability: "stalled", backpressure: "alive" });
    watch = settleProbe(watch, { reachability: "alive", backpressure: "alive" });
    watch = settleProbe(watch, { reachability: "stalled", backpressure: "alive" });
    expect(watch.strikes).toBe(1);
    expect(decide(ask({ watch })).action).toBe("wait");
  });
});

describe("the two signals", () => {
  /**
   * Judged on transport, not on status. A server having a bad minute answers
   * with a 500 over a perfectly live path, and reconnecting would throw away a
   * working socket for a problem a reconnect cannot fix.
   */
  it("reads any HTTP answer as alive, a 500 included", () => {
    expect(reachabilitySignal({ responded: true, status: 500 })).toBe("alive");
    expect(reachabilitySignal({ responded: true, status: 200 })).toBe("alive");
    expect(reachabilitySignal({ responded: true, status: 401 })).toBe("alive");
  });

  it("reads a fetch that never answered as stalled", () => {
    expect(reachabilitySignal({ responded: false })).toBe("stalled");
  });

  /**
   * `before` is read BEFORE the byte is queued, so a buffer back at its old
   * level is a buffer that drained. Comparing with `<` instead of `<=` would
   * strike every healthy socket on every probe.
   */
  it("reads a send buffer back at its old level as drained", () => {
    expect(backpressureSignal(0, 0)).toBe("alive");
    expect(backpressureSignal(4096, 4096)).toBe("alive");
    expect(backpressureSignal(4096, 12)).toBe("alive");
  });

  it("reads a send buffer that only grew as stalled", () => {
    expect(backpressureSignal(4096, 4097)).toBe("stalled");
  });

  it("sends a zero-length ttyd INPUT frame, which reaches the pty as no bytes at all", () => {
    const frame = new Uint8Array(probeFrame());
    expect(frame.length).toBe(1); // the type byte and nothing else
    expect(frame[0]).toBe(WS_PROBE_FRAME_BYTE);
    expect(String.fromCharCode(WS_PROBE_FRAME_BYTE)).toBe("0"); // ttyd's INPUT type
  });

  it("hands out a fresh buffer each time, so no two probes share one", () => {
    expect(probeFrame()).not.toBe(probeFrame());
  });
});

describe("what the connection panel is told", () => {
  /**
   * The gap between the watchdog's verdict and `readyState` IS the failure this
   * module exists to catch: the socket still reports OPEN, and the panel has to
   * side with the watchdog or it goes on showing a frozen terminal as connected.
   */
  it("reports closed the moment the watchdog declares death, though the socket says open", () => {
    const d = decide(ask({ watch: withStrikes(watchSocket(T0), STRIKE_LIMIT) }));
    expect(livenessSocketState("open", d)).toBe("closed");
  });

  /**
   * Strikes one and two are suspicion, not a verdict — a probe may yet clear
   * them. Painting them would have the panel cry wolf at every crowded-wifi
   * hiccup.
   */
  it("reports a socket carrying strikes as still open", () => {
    const d = decide(ask({ watch: withStrikes(watchSocket(T0), STRIKE_LIMIT - 1) }));
    expect(livenessSocketState("open", d)).toBe("open");
  });

  it("passes a socket the watchdog is not judging through untouched", () => {
    const d = decide(ask({ socketState: "connecting" }));
    expect(livenessSocketState("connecting", d)).toBe("connecting");
    expect(livenessSocketState("closed", decide(ask({ socketState: "closed" })))).toBe("closed");
  });
});

describe("the watch is data, not a mutable object", () => {
  it("leaves the watch it was handed alone", () => {
    const before = watchSocket(T0);
    const snapshot = { ...before };
    beginProbe(before, T0 + 1);
    reanchor(before, T0 + 2);
    noteTyped(before, T0 + 3, null);
    settleProbe(before, { reachability: "stalled", backpressure: "stalled" });
    noteSendFailure(before);
    expect(before).toEqual(snapshot);
  });
});
