/**
 * The two surfaces that read the status model: the badge, which appears twice
 * with different scopes, and the Right now panel.
 *
 * The decisions worth pinning here are the ones a future edit would quietly
 * undo — the scope rule that keeps a session's dead socket out of the sidebar's
 * badge, the silence while everything works, and the panel refusing to offer a
 * repair it cannot perform.
 */
import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { StatusDot } from "../src/components/StatusDot";
import { RightNow } from "../src/components/settings/RightNow";
import {
  LOBBY_CHANNELS,
  SESSION_CHANNELS,
  worst,
  type Channel,
  type ChannelId,
  type ChannelState,
} from "../src/diagnostics/status";
import type { ConnectionControl } from "../src/diagnostics/status-store";
import type { CheckOutcome } from "../src/diagnostics/check";

const ch = (id: ChannelId, state: ChannelState, detail = "detail"): Channel => ({
  id,
  state,
  detail,
});

const ALL_FINE: Channel[] = SESSION_CHANNELS.map((id) => ch(id, "working"));

function control(over: Partial<ConnectionControl> = {}): ConnectionControl {
  const channels = over.channels ?? (() => ALL_FINE);
  return {
    channels,
    log: () => [],
    lastCheck: () => ({}),
    checkedAt: () => null,
    checking: () => false,
    bootedAt: Date.now() - 120_000,
    worstNow: () => worst(channels()),
    runCheck: async () => {},
    repairLabel: () => null,
    repair: () => {},
    ...over,
  };
}

describe("the badge", () => {
  it("shows a dot and no word while everything works", () => {
    const { container } = render(() => (
      <StatusDot channels={() => ALL_FINE} only={SESSION_CHANNELS} onOpen={() => {}} />
    ));
    expect(container.querySelector(".tl-status-dot")?.getAttribute("data-status")).toBe("working");
    expect(container.querySelector(".tl-status-dot-word")).toBeNull();
    cleanup();
  });

  it("grows a word when something is wrong", () => {
    const bad = [...ALL_FINE.filter((c) => c.id !== "terminal"), ch("terminal", "down")];
    const { container } = render(() => (
      <StatusDot channels={() => bad} only={SESSION_CHANNELS} onOpen={() => {}} />
    ));
    expect(container.querySelector(".tl-status-dot-word")?.textContent).toBe("Offline");
    cleanup();
  });

  /**
   * The rule that lets one component sit in two places. A sidebar badge must
   * never go red for a socket belonging to a session that is not on screen — it
   * would name the wrong problem on the one surface that cannot show the right
   * one.
   */
  it("ignores channels the surface cannot honestly report", () => {
    const bad = [...ALL_FINE.filter((c) => c.id !== "terminal"), ch("terminal", "down")];
    const { container } = render(() => (
      <StatusDot channels={() => bad} only={LOBBY_CHANNELS} onOpen={() => {}} />
    ));
    expect(container.querySelector(".tl-status-dot")?.getAttribute("data-status")).toBe("working");
    expect(container.querySelector(".tl-status-dot-word")).toBeNull();
    cleanup();
  });

  it("repaints when a channel changes under it", () => {
    const [channels, setChannels] = createSignal<Channel[]>(ALL_FINE);
    const { container } = render(() => (
      <StatusDot channels={channels} only={SESSION_CHANNELS} onOpen={() => {}} />
    ));
    setChannels([...ALL_FINE.filter((c) => c.id !== "transcript"), ch("transcript", "degraded")]);
    expect(container.querySelector(".tl-status-dot")?.getAttribute("data-status")).toBe("degraded");
    expect(container.querySelector(".tl-status-dot-word")?.textContent).toBe("Reconnecting");
    cleanup();
  });

  it("opens the panel when tapped, and says so to a screen reader", () => {
    const onOpen = vi.fn();
    const { container } = render(() => (
      <StatusDot channels={() => ALL_FINE} only={SESSION_CHANNELS} onOpen={onOpen} />
    ));
    const btn = container.querySelector<HTMLButtonElement>(".tl-status-dot")!;
    expect(btn.getAttribute("aria-label")).toBe("Everything is connected.");
    btn.click();
    expect(onOpen).toHaveBeenCalledOnce();
    cleanup();
  });

  /**
   * The badge is the ONLY connection indicator on a session screen now: the
   * terminal's pill defers to it and the sidebar's stands down. So the attempt
   * count has to survive here, or a climbing ladder and a stuck one look the
   * same.
   */
  it("shows the retry attempt, which the terminal's pill used to carry", () => {
    const retrying: Channel[] = [
      { id: "terminal", state: "degraded", detail: "reconnecting, attempt 7", count: 7 },
      ...ALL_FINE.filter((c) => c.id !== "terminal"),
    ];
    const { container } = render(() => (
      <StatusDot channels={() => retrying} only={SESSION_CHANNELS} onOpen={() => {}} />
    ));
    expect(container.querySelector(".tl-status-dot-word")?.textContent).toBe("Reconnecting 7");
    cleanup();
  });

  it("is inert rather than a dead button when there is nowhere to go", () => {
    const { container } = render(() => (
      <StatusDot channels={() => ALL_FINE} only={SESSION_CHANNELS} />
    ));
    expect(container.querySelector<HTMLButtonElement>(".tl-status-dot")!.disabled).toBe(true);
    cleanup();
  });
});

describe("the Right now panel", () => {
  it("leads with the verdict, not the table", () => {
    const { container } = render(() => <RightNow conn={control()} />);
    expect(container.querySelector(".tl-rightnow-verdict")?.textContent).toBe(
      "Everything is connected.",
    );
    cleanup();
  });

  it("draws every channel, including the ones that have said nothing", () => {
    const { container } = render(() => <RightNow conn={control({ channels: () => [] })} />);
    const rows = container.querySelectorAll(".tl-rightnow-row");
    expect(rows).toHaveLength(SESSION_CHANNELS.length);
    expect([...rows].every((r) => r.getAttribute("data-status") === "unknown")).toBe(true);
    cleanup();
  });

  it("offers a repair only where one exists", () => {
    const bad = [...ALL_FINE.filter((c) => c.id !== "terminal"), ch("terminal", "down")];
    const { container } = render(() => (
      <RightNow
        conn={control({
          channels: () => bad,
          repairLabel: (id) => (id === "terminal" ? "Reconnect" : null),
        })}
      />
    ));
    const fixes = container.querySelectorAll(".tl-rightnow-fix");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].textContent).toBe("Reconnect");
    cleanup();
  });

  it("runs the check on tap, and says it is running", async () => {
    const runCheck = vi.fn(async () => {});
    const [checking, setChecking] = createSignal(false);
    const { container, getByText } = render(() => (
      <RightNow conn={control({ runCheck, checking })} />
    ));
    getByText("Run check").click();
    expect(runCheck).toHaveBeenCalledOnce();
    setChecking(true);
    const btn = container.querySelector<HTMLButtonElement>(".tl-set-actions .tl-set-btn")!;
    expect(btn.textContent).toBe("Checking…");
    expect(btn.disabled).toBe(true);
    cleanup();
  });

  it("shows what the last check measured, per row", () => {
    const last: Partial<Record<ChannelId, CheckOutcome>> = {
      sessions: { id: "sessions", state: "working", detail: "up to date", ms: 43 },
    };
    const { container } = render(() => <RightNow conn={control({ lastCheck: () => last })} />);
    const shown = [...container.querySelectorAll(".tl-rightnow-ms")].map((e) => e.textContent);
    expect(shown).toEqual(["43 ms"]);
    cleanup();
  });

  it("says what dropped since the page loaded", () => {
    const { container } = render(() => (
      <RightNow
        conn={control({
          log: () => [
            { id: "terminal", from: "working", to: "down", at: 1_000 },
            { id: "terminal", from: "down", to: "working", at: 2_000 },
            { id: "terminal", from: "working", to: "degraded", at: 3_000 },
          ],
        })}
      />
    ));
    expect(container.querySelector(".tl-rightnow-history")?.textContent).toContain(
      "dropped 2 times",
    );
    cleanup();
  });

  /** The panel is a readout with buttons, and the buttons are the only thing
   *  that changes anything. Opening it must never reconnect a channel. */
  it("changes nothing by being opened", () => {
    const repair = vi.fn();
    const runCheck = vi.fn(async () => {});
    render(() => <RightNow conn={control({ repair, runCheck })} />);
    expect(repair).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
    cleanup();
  });
});
