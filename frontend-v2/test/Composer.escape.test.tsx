/**
 * Escape in the Text view's field does what it does in the Terminal: it stops
 * the turn Claude is running. It presses the same Stop as the round button, so
 * it takes one press per turn and hands back what that Stop hands back.
 *
 * At an idle prompt it does nothing. In the Terminal a second Esc there opens
 * Claude's rewind menu, which the Text view cannot draw, and the next message's
 * Enter would pick a rewind point from it (Viktor, 2026-10-07).
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";
import type { WorkingRow } from "../src/components/timeline.logic";
import type { ClaudeState } from "../src/types/lobby";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

const WORKING: WorkingRow = {
  kind: "working",
  key: "w-t1",
  turnKey: "t1",
  tool: "Bash",
  toolLabel: "ls",
  steps: 2,
};
const RUNNING = { live: WORKING, claudeState: "running" as ClaudeState };

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) => {
  const onStop = vi.fn();
  const r = render(() => (
    <Composer pending={[]} onSend={sent} onStop={onStop} onResolve={noop} {...props} />
  ));
  const field = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
  const esc = () => fireEvent.keyDown(field, { key: "Escape" });
  return { ...r, field, esc, onStop };
};

describe("<Composer> Escape", () => {
  it("stops the running turn", () => {
    const { esc, onStop } = mount(RUNNING);
    expect(esc()).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops it with words in the field, and leaves them there", () => {
    const { field, esc, onStop } = mount(RUNNING);
    fireEvent.input(field, { target: { value: "next, try the other file" } });
    esc();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("next, try the other file");
  });

  it("stops once for a double press", () => {
    const { esc, onStop } = mount(RUNNING);
    esc();
    esc();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  for (const [name, props] of [
    ["the session is idle", { claudeState: "done" as ClaudeState }],
    ["the stamp says running but no turn is open", { claudeState: "running" as ClaudeState }],
    ["this device is watching", { ...RUNNING, inertReason: "Someone else is driving" }],
  ] as const) {
    it(`does nothing when ${name}`, () => {
      const { esc, onStop } = mount(props);
      expect(esc()).toBe(true);
      expect(onStop).not.toHaveBeenCalled();
    });
  }

  it("leaves an Escape that commits an input method's text to it", () => {
    const { field, onStop } = mount(RUNNING);
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(onStop).not.toHaveBeenCalled();
  });
});
