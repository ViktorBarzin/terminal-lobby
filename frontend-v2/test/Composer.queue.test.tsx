/**
 * The round button: Send, Stop, and the Send that queues (the T3 pass,
 * docs/plans/2026-09-27-text-view-t3-pass.md, item 7).
 *
 * One 32px disc at the end of the composer, in one of three states:
 *
 *  - Stop, while Claude works and the field is empty with nothing attached;
 *  - Send, named "Send, queues after this turn", once something is typed or
 *    attached mid-turn. The message queues in Claude and shows as a ghost;
 *  - Send, greyed, while the field is empty and nothing runs.
 *
 * REWRITTEN ON PURPOSE on 2026-09-27. The earlier file pinned "Send keeps its
 * name" and "never greys out", and both were the Quiet line's answer to one
 * measurement: the turn reading comes from the TRANSCRIPT, which lags the pane
 * by 3-112s, so a session whose real state was `done` showed Stop in 98 of 100
 * samples over 300s. Swapping Send for Stop on that reading alone left a
 * finished session with no way to send.
 *
 * The T3 pass makes Stop a state of the one button, so the lag had to be
 * answered another way, and the answer is these rules:
 *
 *  - Stop needs BOTH readings to agree: the transcript's live row, and the
 *    hook-stamped session state (ADR-0001) saying `running`. The hook state
 *    turns `done` when the session stops, including after an interrupt, which
 *    `Injector.Cancel` re-stamps itself.
 *  - Typing always turns the button back into Send, so a stale Stop can never
 *    stand between the reader and a send.
 *  - Stop takes ONE press per turn. `Injector.Cancel` (sessionio/tmux.go) sends
 *    C-c without looking at the pane, and a second C-c at an idle Claude
 *    prompt exits the CLI.
 *  - Enter on an empty field does nothing. The prototype stopped Claude on an
 *    empty Enter; that is not copied, for the same reason.
 *
 * What is kept from the earlier file: a mid-turn send goes through, and the
 * question warning on Send's title does not disable it.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
import { Composer, type ComposerSinks } from "../src/components/Composer";
import type { WorkingRow } from "../src/components/timeline.logic";
import type { ClaudeState } from "../src/types/lobby";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

/** A turn in flight: the transcript's live row. */
const WORKING: WorkingRow = {
  kind: "working",
  key: "w-t1",
  turnKey: "t1",
  tool: "Bash",
  toolLabel: "ls",
  steps: 2,
};
/** A turn parked on a question: open, and nothing running. */
const WAITING: WorkingRow = { ...WORKING, tool: undefined, toolLabel: undefined, waiting: true };

const SHOT = {
  path: "/var/lib/clipboard-store/wizard/s/shot-a1.png",
  name: "shot-a1.png",
  kind: "image" as const,
};

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) => {
  let sinks: ComposerSinks | undefined;
  const r = render(() => (
    <Composer
      pending={[]}
      onSend={sent}
      onStop={noop}
      onResolve={noop}
      register={(api) => (sinks = api)}
      {...props}
    />
  ));
  const button = () => r.container.querySelector<HTMLButtonElement>(".tl-send")!;
  const field = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.input(field, { target: { value: text } });
  return { ...r, button, field, type, sinks: () => sinks! };
};

/** Claude is working, by both readings. */
const RUNNING = { live: WORKING, claudeState: "running" as ClaudeState };

afterEach(() => {
  vi.useRealTimers();
});

describe("<Composer> round button: its three states", () => {
  it("is Stop while Claude works and the field is empty", () => {
    const { button } = mount(RUNNING);
    expect(button().dataset.kind).toBe("stop");
    expect(button().getAttribute("aria-label")).toBe("Stop Claude");
    expect(button().disabled).toBe(false);
  });

  it("turns into a Send that queues once something is typed mid-turn", () => {
    const { button, type } = mount(RUNNING);
    type("the next thing");
    expect(button().dataset.kind).toBe("send");
    expect(button().getAttribute("aria-label")).toBe("Send, queues after this turn");
    expect(button().disabled).toBe(false);
    // Whitespace is not a message.
    type("   ");
    expect(button().dataset.kind).toBe("stop");
  });

  it("turns into a Send that queues when only a picture is attached mid-turn", () => {
    const { button, sinks } = mount(RUNNING);
    sinks().add([SHOT]);
    expect(button().dataset.kind).toBe("send");
    expect(button().getAttribute("aria-label")).toBe("Send, queues after this turn");
  });

  it("is a greyed Send while the field is empty and nothing runs", () => {
    const { button } = mount({});
    expect(button().dataset.kind).toBe("send");
    expect(button().getAttribute("aria-label")).toBe("Send");
    expect(button().disabled).toBe(true);
  });

  it("is a plain Send once something is typed and nothing runs", () => {
    const { button, type, sinks } = mount({ claudeState: "done" });
    type("fix the deploy");
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Send");
    type("");
    sinks().add([SHOT]);
    expect(button().disabled).toBe(false);
  });

  it("keeps one round button while a message would queue", () => {
    const { container, type } = mount(RUNNING);
    type("and then this");
    const end = container.querySelector(".tl-pill-end")!;
    expect(end.querySelectorAll("button"), "no second button beside Send").toHaveLength(1);
  });
});

describe("<Composer> round button: Stop needs both readings", () => {
  // The transcript's live row lags the pane; the hook state is what the
  // session itself stamped. A stale row alone must not offer Stop.
  for (const state of ["done", "awaiting", "suspended", undefined] as const) {
    it(`offers no Stop while the hook state is ${state ?? "unknown"}, even with the transcript working`, () => {
      const { button } = mount({ live: WORKING, claudeState: state });
      expect(button().dataset.kind).toBe("send");
      expect(button().disabled, "nothing to send and nothing to stop").toBe(true);
    });
  }

  it("offers no Stop while the hook state is running but no turn is open", () => {
    // Background agents keep the stamp at running after the turn ends.
    const { button } = mount({ claudeState: "running" });
    expect(button().dataset.kind).toBe("send");
    expect(button().disabled).toBe(true);
  });

  it("offers no Stop while Claude is only waiting for the reader", () => {
    const { button } = mount({ live: WAITING, claudeState: "running" });
    expect(button().dataset.kind).toBe("send");
  });

  it("does not call the send a queue when only the transcript says working", () => {
    const { button, type } = mount({ live: WORKING, claudeState: "done" });
    type("next");
    expect(button().getAttribute("aria-label")).toBe("Send");
  });
});

describe("<Composer> round button: one Stop per turn", () => {
  it("calls onStop once for a double tap, and says it is stopping", () => {
    const onStop = vi.fn();
    const { button } = mount({ ...RUNNING, onStop });
    fireEvent.click(button());
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(button().dataset.kind).toBe("stop");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Stopping…");
  });

  it("takes a Stop again once the turn has settled and a new one runs", () => {
    const onStop = vi.fn();
    const [state, setState] = createSignal<ClaudeState>("running");
    const [live, setLive] = createSignal<WorkingRow | undefined>(WORKING);
    const r = render(() => (
      <Composer
        pending={[]}
        onSend={sent}
        onStop={onStop}
        onResolve={noop}
        live={live()}
        claudeState={state()}
      />
    ));
    const button = () => r.container.querySelector<HTMLButtonElement>(".tl-send")!;
    fireEvent.click(button());
    // The interrupt lands: the session re-stamps done, the row goes.
    setState("done");
    setLive(undefined);
    expect(button().dataset.kind).toBe("send");
    // The next turn.
    setState("running");
    setLive({ ...WORKING, key: "w-t2", turnKey: "t2" });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  // Found live on 2026-09-27: after an interrupt the transcript closed the turn
  // and showed it running again while the session list still read `running`,
  // and a second tap sent a second C-c. The hook state is what says the turn
  // has settled, because Cancel re-stamps it `done`.
  it("holds Stopping while the transcript flickers and the hook state still says running", () => {
    const onStop = vi.fn();
    const [state, setState] = createSignal<ClaudeState>("running");
    const [live, setLive] = createSignal<WorkingRow | undefined>(WORKING);
    const r = render(() => (
      <Composer
        pending={[]}
        onSend={sent}
        onStop={onStop}
        onResolve={noop}
        live={live()}
        claudeState={state()}
      />
    ));
    const button = () => r.container.querySelector<HTMLButtonElement>(".tl-send")!;
    fireEvent.click(button());
    setLive(undefined);
    setLive({ ...WORKING, key: "w-t1b" });
    expect(button().dataset.kind).toBe("stop");
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);
    setState("done");
    setState("running");
    expect(button().disabled).toBe(false);
  });

  it("gives Stop back after a bounded wait if the turn never settles", () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const { button } = mount({ ...RUNNING, onStop });
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(button().disabled, "still settling").toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Stop Claude");
  });

  it("still sends while stopping, once something is typed", () => {
    const onSend = vi.fn(sent);
    const { button, type } = mount({ ...RUNNING, onSend });
    fireEvent.click(button());
    type("then do this instead");
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(onSend).toHaveBeenCalledWith("then do this instead", []);
  });

  it("never stops on Enter in an empty field", () => {
    const onStop = vi.fn();
    const onSend = vi.fn(sent);
    const { field } = mount({ ...RUNNING, onStop, onSend });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("<Composer> round button: watching", () => {
  const WATCH = "Watching alice — take control to type in their session";

  it("neither stops nor sends from a watching device", () => {
    const onStop = vi.fn();
    const onSend = vi.fn(sent);
    const { button, type } = mount({ ...RUNNING, inertReason: WATCH, onStop, onSend });
    expect(button().dataset.kind).toBe("send");
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    type("typed while watching");
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(onStop).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("<Composer> round button: sending mid-turn", () => {
  it("sends when pressed mid-turn, which queues in Claude", () => {
    const onSend = vi.fn(sent);
    const { button, type } = mount({ ...RUNNING, onSend });
    type("  the next thing  ");
    fireEvent.click(button());
    expect(onSend).toHaveBeenCalledWith("the next thing", []);
  });
});
