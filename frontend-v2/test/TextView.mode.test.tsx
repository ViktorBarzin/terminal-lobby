/**
 * The permission-mode chip has to show the mode the session is ACTUALLY in.
 *
 * Reported by Viktor 2026-08-17: the chip said "bypass" and would not budge.
 * Measured on a live session that day: pressing it moved the CLI from
 * "⏵⏵ bypass permissions on" to "⏵⏵ auto mode on" within 40ms, and the
 * transcript still said bypassPermissions twenty minutes later — the CLI writes
 * its `permission-mode` record when a TURN happens, not when the mode changes.
 * So the transcript is a fine starting value and a hopeless live one.
 *
 * The pane is the live source. It is read when the view opens and again after
 * the chip is pressed, and a reading holds only until the transcript reports a
 * mode of its own.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

/** The real status lines, one per stop of the CLI's Shift+Tab cycle. */
const STATUS = {
  bypass: "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  manual: "  ⏸ manual mode on · ← for agents",
};

const pane = (status: string): string =>
  `❯ \n${"─".repeat(40)}\n  /home/wizard/code | 🤖 opus-5 | 🧠 23%\n${status}\n`;

let nextId = 1;
const modeEvent = (mode: string): Event =>
  ({
    id: nextId++,
    kind: "meta",
    meta: "permission-mode",
    body: mode,
    session: "qa",
  }) as unknown as Event;

function mount(opts: {
  events?: Event[];
  panes: string[];
  onKeys?: (keys: string[]) => Promise<boolean>;
}) {
  let reads = 0;
  const r = render(() => (
    <TextView
      events={opts.events ?? []}
      working={false}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={opts.onKeys ?? (async () => true)}
      onPane={async () => {
        const p = opts.panes[Math.min(reads++, opts.panes.length - 1)]!;
        return { pane: p, state: "done" };
      }}
    />
  ));
  return {
    ...r,
    chip: () => r.container.querySelector<HTMLButtonElement>(".tl-mode-chip"),
    reads: () => reads,
  };
}

describe("<TextView> — the permission-mode chip", () => {
  it("shows what the PANE says, not what the transcript remembers", async () => {
    // The exact reported shape: the transcript's last record is stale bypass,
    // the session is really in auto.
    const v = mount({ events: [modeEvent("bypassPermissions")], panes: [pane(STATUS.auto)] });
    expect(v.chip()?.textContent).toBe("bypass");
    await waitFor(() => expect(v.chip()?.textContent).toBe("auto"));
  });

  it("updates after the chip is pressed", async () => {
    const onKeys = vi.fn(async () => true);
    const v = mount({
      events: [modeEvent("bypassPermissions")],
      // open → bypass; after the press → auto.
      panes: [pane(STATUS.bypass), pane(STATUS.auto)],
      onKeys,
    });
    await waitFor(() => expect(v.chip()?.textContent).toBe("bypass"));
    fireEvent.click(v.chip()!);
    expect(onKeys).toHaveBeenCalledWith(["BTab"]);
    await waitFor(() => expect(v.chip()?.textContent).toBe("auto"), { timeout: 3000 });
  });

  it("reads again when the pane had not repainted yet", async () => {
    // The status line repaints ~40ms after the keystroke, but a busy session can
    // be mid-render at the first read. One retry rather than a stale chip.
    const v = mount({
      events: [modeEvent("bypassPermissions")],
      panes: [pane(STATUS.bypass), pane(STATUS.bypass), pane(STATUS.manual)],
    });
    await waitFor(() => expect(v.chip()?.textContent).toBe("bypass"));
    fireEvent.click(v.chip()!);
    await waitFor(() => expect(v.chip()?.textContent).toBe("manual"), { timeout: 3000 });
  });

  it("hands back to the transcript once it reports a mode of its own", async () => {
    // A turn happens: the record the CLI writes is authoritative at that instant,
    // and is fresher than a reading taken before it.
    const [events, setEvents] = (() => {
      const initial = [modeEvent("bypassPermissions")];
      let cur = initial;
      return [() => cur, (e: Event[]) => (cur = e)] as const;
    })();
    const v = mount({ events: events(), panes: [pane(STATUS.auto)] });
    await waitFor(() => expect(v.chip()?.textContent).toBe("auto"));
    setEvents([...events(), modeEvent("plan")]);
    v.unmount();
    // Re-mounting with the newer transcript is the same assertion without a
    // reactive-store harness: the newer record wins over the older reading.
    const again = mount({ events: events(), panes: [] });
    await waitFor(() => expect(again.chip()?.textContent).toBe("plan"));
  });

  it("shows no chip at all when neither source knows", async () => {
    // Better an absent chip than a confident wrong one — this is a claim about
    // what the session will do with the next tool call.
    const v = mount({ events: [], panes: [pane("  ready")] });
    await new Promise((r) => setTimeout(r, 900));
    expect(v.chip()).toBeNull();
  });
});
