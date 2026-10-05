/**
 * ↑ with prompts queued behind the turn takes them back to edit, as Claude
 * Code's own input box does ("Press up to edit queued messages"), instead of
 * recalling the last prompt sent. The caller takes them back and puts them in
 * the field; when nothing came back (the turn ended and sent them a moment
 * ago), the same ↑ recalls history as it always did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PromptField } from "../src/components/PromptField";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const onSend = async (): Promise<boolean> => true;
const field = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
};
/** False when the handler took the key. */
const press = (el: HTMLTextAreaElement, key: string): boolean => fireEvent.keyDown(el, { key });

const mount = (onEditQueued?: () => Promise<boolean>) =>
  render(() => (
    <PromptField onSend={onSend} label="Message" history={["alpha", "beta"]} onEditQueued={onEditQueued} />
  ));

describe("<PromptField> ↑ with a queue", () => {
  it("asks for the queue instead of recalling history", async () => {
    const edit = vi.fn(async () => true);
    const { container } = mount(edit);
    const ta = field(container);
    expect(press(ta, "ArrowUp")).toBe(false);
    await Promise.resolve();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe("");
  });

  it("recalls history when nothing came back", async () => {
    const { container } = mount(async () => false);
    const ta = field(container);
    press(ta, "ArrowUp");
    await vi.waitFor(() => expect(ta.value).toBe("beta"));
    press(ta, "ArrowUp");
    expect(ta.value).toBe("alpha");
  });

  it("leaves the field alone when nothing came back but the writer has typed since", async () => {
    let answer!: (ok: boolean) => void;
    const { container } = mount(() => new Promise<boolean>((r) => (answer = r)));
    const ta = field(container);
    press(ta, "ArrowUp");
    type(ta, "new words");
    answer(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe("new words");
  });

  it("is a caret move in a field that holds text", () => {
    const edit = vi.fn(async () => true);
    const { container } = mount(edit);
    const ta = field(container);
    type(ta, "draft");
    expect(press(ta, "ArrowUp")).toBe(true);
    expect(edit).not.toHaveBeenCalled();
  });

  it("asks once while a request is out", () => {
    const edit = vi.fn(() => new Promise<boolean>(() => {}));
    const { container } = mount(edit);
    const ta = field(container);
    press(ta, "ArrowUp");
    expect(press(ta, "ArrowUp")).toBe(false);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("walks history as before with no queue", () => {
    const { container } = mount(undefined);
    const ta = field(container);
    press(ta, "ArrowUp");
    expect(ta.value).toBe("beta");
  });
});
