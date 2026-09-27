/**
 * The mode dial has to show the mode the session is ACTUALLY in.
 *
 * Reported by Viktor 2026-08-17: the chip said "bypass" and would not budge.
 * Measured on a live session that day: pressing it moved the CLI from
 * "⏵⏵ bypass permissions on" to "⏵⏵ auto mode on" within 40ms, and the
 * transcript still said bypassPermissions twenty minutes later — the CLI writes
 * its `permission-mode` record when a TURN happens, not when the mode changes.
 * So the transcript is a fine starting value and a hopeless live one.
 *
 * The pane is the live source. It is read when the view opens and again after
 * Shift+Tab, and a reading holds only until the transcript reports a mode of
 * its own.
 *
 * Since the Quiet line composer (2026-09-24) a click opens a list of modes
 * instead of stepping one, and a pick is one request: the server walks
 * Shift+Tab to the mode and replies with the mode it read (wire contract 1).
 * That reply is a pane reading like any other, and is shown the same way.
 * Since the T3 pass (2026-09-27) the list is the Mode section of the model
 * sheet, and the model button carries the mode in force as `data-mode`.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { SetModeResult } from "../src/lib/mode-api";
import { modeTitle, type ModeId } from "../src/logic/modes";
import type { PendingPermission } from "../src/components/timeline.logic";
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
  onSetMode?: (mode: ModeId) => Promise<SetModeResult>;
  notify?: (message: string, kind: "info" | "error" | "warning" | "success") => void;
  pending?: PendingPermission[];
}) {
  let reads = 0;
  const r = render(() => (
    <TextView
      events={opts.events ?? []}
      pending={opts.pending ?? []}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={opts.onKeys ?? (async () => true)}
      onSetMode={opts.onSetMode}
      notify={opts.notify}
      onPane={async () => {
        const p = opts.panes[Math.min(reads++, opts.panes.length - 1)]!;
        return { pane: p, state: "done" };
      }}
    />
  ));
  const dial = () => r.container.querySelector<HTMLButtonElement>(".tl-model-btn");
  return {
    ...r,
    dial,
    /** The mode the model button carries, by the sheet's name for it. */
    shown: () => {
      const m = dial()?.getAttribute("data-mode");
      return m ? modeTitle(m) : undefined;
    },
    field: () => r.container.querySelector<HTMLTextAreaElement>("textarea")!,
    pick: (name: string) => {
      fireEvent.click(dial()!);
      const row = Array.from(r.container.querySelectorAll<HTMLButtonElement>(".tl-ms-mode")).find(
        (b) => b.querySelector(".tl-ms-name")?.textContent === name,
      )!;
      fireEvent.click(row);
    },
    reads: () => reads,
  };
}

describe("<TextView>: the model button carries the live mode", () => {
  it("shows what the PANE says, not what the transcript remembers", async () => {
    // The exact reported shape: the transcript's last record is stale bypass,
    // the session is really in auto.
    const v = mount({ events: [modeEvent("bypassPermissions")], panes: [pane(STATUS.auto)] });
    expect(v.shown()).toBe("Bypass");
    await waitFor(() => expect(v.shown()).toBe("Auto"));
  });

  it("puts a pick from the list through the walk, never through raw keys, and shows the reply", async () => {
    const onKeys = vi.fn(async () => true);
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: true, mode: "auto", presses: 1 },
      }),
    );
    const v = mount({
      events: [modeEvent("bypassPermissions")],
      panes: [pane(STATUS.bypass)],
      onKeys,
      onSetMode,
    });
    await waitFor(() => expect(v.shown()).toBe("Bypass"));
    v.pick("Auto");
    expect(onSetMode).toHaveBeenCalledWith("auto");
    expect(onKeys).not.toHaveBeenCalled();
    await waitFor(() => expect(v.shown()).toBe("Auto"));
  });

  it("sends nothing for a pick of the mode it is already in", async () => {
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: true, mode: "bypassPermissions", presses: 0 },
      }),
    );
    const v = mount({
      events: [modeEvent("bypassPermissions")],
      panes: [pane(STATUS.bypass)],
      onSetMode,
    });
    await waitFor(() => expect(v.shown()).toBe("Bypass"));
    v.pick("Bypass");
    expect(onSetMode).not.toHaveBeenCalled();
  });

  it("steps once on Shift+Tab in the field, and reads again when the pane had not repainted", async () => {
    // The status line repaints ~40ms after the keystroke, but a busy session can
    // be mid-render at the first read. One retry rather than a stale dial.
    const onKeys = vi.fn(async () => true);
    const v = mount({
      events: [modeEvent("bypassPermissions")],
      panes: [pane(STATUS.bypass), pane(STATUS.bypass), pane(STATUS.manual)],
      onKeys,
    });
    await waitFor(() => expect(v.shown()).toBe("Bypass"));
    fireEvent.keyDown(v.field(), { key: "Tab", shiftKey: true });
    expect(onKeys).toHaveBeenCalledWith(["BTab"]);
    await waitFor(() => expect(v.shown()).toBe("Manual"), { timeout: 3000 });
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
    await waitFor(() => expect(v.shown()).toBe("Auto"));
    setEvents([...events(), modeEvent("plan")]);
    v.unmount();
    // Re-mounting with the newer transcript is the same assertion without a
    // reactive-store harness: the newer record wins over the older reading.
    const again = mount({ events: events(), panes: [] });
    await waitFor(() => expect(again.shown()).toBe("Plan"));
  });

  it("shows no button at all when neither source knows", async () => {
    // Better an absent button than a confident wrong one: this is a claim about
    // what the session will do with the next tool call.
    const v = mount({ events: [], panes: [pane("  ready")] });
    await new Promise((r) => setTimeout(r, 900));
    expect(v.dial()).toBeNull();
  });
});

describe("<TextView>: a pick the server would not complete", () => {
  it("shows the mode the walk ended on, and says the mode is not offered", async () => {
    const notify = vi.fn();
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: false, reason: "unavailable", mode: "manual", presses: 5 },
      }),
    );
    const v = mount({
      events: [modeEvent("manual")],
      panes: [pane(STATUS.manual)],
      onSetMode,
      notify,
    });
    await waitFor(() => expect(v.shown()).toBe("Manual"));
    v.pick("Auto");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Auto is not offered in this session, so it stayed on Manual.",
        "warning",
      ),
    );
    expect(v.shown()).toBe("Manual");
    // And the list remembers, so the row says so the next time it opens.
    fireEvent.click(v.dial()!);
    const auto = Array.from(v.container.querySelectorAll<HTMLButtonElement>(".tl-ms-mode")).find(
      (b) => b.querySelector(".tl-ms-name")?.textContent === "Auto",
    )!;
    expect(auto.getAttribute("aria-disabled")).toBe("true");
  });

  it("says a walk through Bypass waits for the turn to end", async () => {
    const notify = vi.fn();
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: false, reason: "unsafe-path", mode: "plan", presses: 0 },
      }),
    );
    const v = mount({
      events: [modeEvent("plan")],
      panes: [pane("  ⏸ plan mode on")],
      onSetMode,
      notify,
    });
    await waitFor(() => expect(v.shown()).toBe("Plan"));
    v.pick("Auto");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Reaching Auto from Plan passes through Bypass while Claude is working. Stop Claude first, or pick it when the turn ends.",
        "warning",
      ),
    );
  });

  it("says so loudly when a walk stopped on a mode that asks nothing", async () => {
    const notify = vi.fn();
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: false, reason: "unsafe-path", mode: "bypassPermissions", presses: 1 },
      }),
    );
    const v = mount({
      events: [modeEvent("plan")],
      panes: [pane("  ⏸ plan mode on")],
      onSetMode,
      notify,
    });
    await waitFor(() => expect(v.shown()).toBe("Plan"));
    v.pick("Auto");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Stopped on Bypass on the way to Auto, because Claude is working. The session is on Bypass now.",
        "error",
      ),
    );
    expect(v.shown()).toBe("Bypass");
  });

  // The server's other refusals (session-events mode.go, sessionio
  // setmode.go) each get a sentence, not the bare word it sends.
  it.each([
    [
      "unverified",
      "Shift+Tab went in and the status line did not move, so nothing more was pressed. The session is on Manual.",
      "warning",
    ],
    [
      "unreadable",
      "The pane shows no permission mode to start from, so nothing was pressed.",
      "warning",
    ],
    ["refused", "tmux would not take the key, so the mode did not change.", "error"],
  ])("says what %s means", async (reason, text, tone) => {
    const notify = vi.fn();
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: true,
        reply: { applied: false, reason, mode: "manual", presses: 1 },
      }),
    );
    const v = mount({
      events: [modeEvent("manual")],
      panes: [pane(STATUS.manual)],
      onSetMode,
      notify,
    });
    await waitFor(() => expect(v.shown()).toBe("Manual"));
    v.pick("Plan");
    await waitFor(() => expect(notify).toHaveBeenCalledWith(text, tone));
  });

  it("passes on a request that never got an answer", async () => {
    const notify = vi.fn();
    const onSetMode = vi.fn(
      async (): Promise<SetModeResult> => ({
        ok: false,
        reason: "Couldn't reach the session to change the mode.",
      }),
    );
    const v = mount({
      events: [modeEvent("manual")],
      panes: [pane(STATUS.manual)],
      onSetMode,
      notify,
    });
    await waitFor(() => expect(v.shown()).toBe("Manual"));
    v.pick("Plan");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Couldn't reach the session to change the mode.",
        "error",
      ),
    );
  });
});

/**
 * Never into an open dialog.
 *
 * Shift+Tab inside the plan approval dialog approves the plan with whatever
 * was typed into its feedback row (measured on CLI 2.1.281, memory #13896).
 * What it does in a question or a permission dialog was not measured, so the
 * model button is held and Shift+Tab withheld for every dialog.
 */
describe("<TextView>: the mode is held while a dialog is up", () => {
  const plan: Event[] = [
    { id: 90, kind: "user", body: "plan it", session: "qa" } as Event,
    {
      id: 91,
      kind: "tool_use",
      tool: "ExitPlanMode",
      toolId: "p1",
      body: JSON.stringify({ plan: "1. do it" }),
      session: "qa",
    } as Event,
  ];
  const question: Event[] = [
    { id: 80, kind: "user", body: "ask me", session: "qa" } as Event,
    {
      id: 81,
      kind: "tool_use",
      tool: "AskUserQuestion",
      toolId: "q1",
      body: JSON.stringify({
        questions: [
          { question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A" }] },
        ],
      }),
      session: "qa",
    } as Event,
  ];
  const permission: PendingPermission[] = [{ reqId: "r1", tool: "Bash", input: "ls" }];

  it.each([
    ["the plan dialog", plan, [] as PendingPermission[]],
    ["a question", question, [] as PendingPermission[]],
    ["a permission", [] as Event[], permission],
  ])(
    "holds the model button and ignores Shift+Tab while %s is up",
    async (_what, events, pending) => {
      const onKeys = vi.fn(async () => true);
      const onSetMode = vi.fn(
        async (): Promise<SetModeResult> => ({
          ok: true,
          reply: { applied: true, mode: "plan", presses: 1 },
        }),
      );
      const v = mount({
        events: [modeEvent("manual"), ...events],
        panes: [pane(STATUS.manual)],
        onKeys,
        onSetMode,
        pending,
      });
      await waitFor(() => expect(v.shown()).toBe("Manual"));
      expect(v.dial()!.getAttribute("aria-disabled")).toBe("true");
      expect(v.dial()!.getAttribute("title")).toMatch(/Answer Claude first/);
      fireEvent.click(v.dial()!);
      expect(v.container.querySelector(".tl-ms-pop")).toBeNull();
      fireEvent.keyDown(v.field(), { key: "Tab", shiftKey: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(onKeys).not.toHaveBeenCalled();
      expect(onSetMode).not.toHaveBeenCalled();
    },
  );
});
