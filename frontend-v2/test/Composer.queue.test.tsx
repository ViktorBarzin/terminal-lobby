/**
 * You can always send. Sending mid-turn queues, which is what Claude Code does
 * with typed input anyway.
 *
 * Reported 2026-08-29: "typing a new prompt should allow enqueuing; today we
 * can only send stop."
 *
 * Nothing about the send path was gated — the server's turn gate was removed on
 * 2026-08-15 (bridge design decision 9, pinned by session-events'
 * gate_test.go), the textarea is never disabled, and Enter fires the same
 * request busy or idle. What was left behind was the BUTTON: a
 * `<Show when={working}>` that swapped Send out for Stop, which is the browser
 * half of that removed gate. On a phone, with no Enter key to fall back on,
 * that left no way to queue at all.
 *
 * And it was worse than "no queueing while busy", because `working` is derived
 * from the TRANSCRIPT, which lags the pane by 3-112s. Measured live across 15
 * sessions: a session whose real state was `done` showed Stop in 98 of 100
 * samples over 300s — 147s, then 145s more after a full reload — and 17-22% of
 * sessions disagreed with their state at any moment. So a FINISHED session
 * could sit there offering only Stop, with no way to send at all. Rendering
 * Send unconditionally is what fixes that, and it is the reason these tests
 * assert on Send's PRESENCE rather than on the swap.
 *
 * The label stays "Send" rather than becoming "Queue" for the same reason:
 * `working` cannot be trusted to say which one is about to happen, and the
 * queued chip already reports the truth from Claude's own records.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
  render(() => (
    <Composer
      working={false}
      pending={[]}
      onSend={sent}
      onStop={noop}
      onResolve={noop}
      {...props}
    />
  ));

describe("<Composer> — sending while the session is working", () => {
  it("offers Send as well as Stop while working", () => {
    // Before: Send was REPLACED by Stop, so a phone had no way to queue.
    const { container } = mount({ working: true });
    expect(container.querySelector(".tl-send"), "Send").not.toBeNull();
    expect(container.querySelector(".tl-stop"), "Stop").not.toBeNull();
  });

  it("offers Send alone when the session is idle", () => {
    const { container } = mount({ working: false });
    expect(container.querySelector(".tl-send")).not.toBeNull();
    expect(container.querySelector(".tl-stop"), "nothing to stop").toBeNull();
  });

  it("keeps the label 'Send' while working, never 'Queue'", () => {
    // `working` lags the real pane state by up to 112s, so a button promising
    // to QUEUE would sometimes be lying. The queued chip says what actually
    // happened, from Claude's own queue-operation records.
    const { container } = mount({ working: true });
    expect(container.querySelector(".tl-send")!.textContent!.trim()).toBe("Send");
  });

  it("sends when Send is pressed mid-turn", async () => {
    const onSend = vi.fn(sent);
    const { container, getByLabelText } = mount({ working: true, onSend });
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "  the next thing  " } });
    fireEvent.click(container.querySelector(".tl-send")!);
    expect(onSend).toHaveBeenCalledWith("the next thing");
  });

  it("still stops when Stop is pressed", async () => {
    const onStop = vi.fn();
    const { container } = mount({ working: true, onStop });
    fireEvent.click(container.querySelector(".tl-stop")!);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("says what sending will cost while Claude is asking a question", () => {
    // A prompt arriving mid-dialog takes the dialog DOWN and Claude re-asks —
    // measured in a real session on 2026-08-16, and markSuperseded() exists to
    // clean up the orphaned question it leaves. ADR-0010 says whoever answers
    // first wins, so this warns rather than refusing: the reader is allowed to
    // talk over a question, they should just know that is what they are doing.
    const { container } = mount({ working: true, asking: true });
    expect(container.querySelector(".tl-send")!.getAttribute("title")).toMatch(
      /question/i,
    );
  });

  it("carries no such warning when nothing is being asked", () => {
    const { container } = mount({ working: true });
    const title = container.querySelector(".tl-send")!.getAttribute("title") ?? "";
    expect(title).not.toMatch(/question/i);
  });

  it("sends anyway when asked to — the warning does not disable the button", () => {
    const onSend = vi.fn(sent);
    const { container, getByLabelText } = mount({ working: true, asking: true, onSend });
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "never mind the question" } });
    fireEvent.click(container.querySelector(".tl-send")!);
    expect(container.querySelector(".tl-send")!.hasAttribute("disabled")).toBe(false);
    expect(onSend).toHaveBeenCalledWith("never mind the question");
  });
});
