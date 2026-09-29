/**
 * ↑ history, and what counts as leaving it.
 *
 * Deployed review round 5 (0.82.5, 2026-09-29): once ↑ had recalled an entry,
 * the field stayed in history-browsing mode however much the writer then
 * edited, so the next ↑ or ↓ swapped their words for another entry and nothing
 * brought them back. An edit makes the text the writer's own again: the arrows
 * go back to moving the caret. Recalling a `/model` entry opened the `/` menu,
 * which then took every further ↑, so older entries could not be reached.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
/** Whether the handler took the key (a caret move is the browser's default). */
const press = (el: HTMLTextAreaElement, key: string): boolean => fireEvent.keyDown(el, { key });

const mount = (history: string[]) =>
  render(() => <PromptField onSend={onSend} label="Message" history={history} />);

describe("<PromptField> ↑ history", () => {
  it("walks back and forth through untouched entries", () => {
    const { container } = mount(["alpha", "beta"]);
    const ta = field(container);
    press(ta, "ArrowUp");
    expect(ta.value).toBe("beta");
    press(ta, "ArrowUp");
    expect(ta.value).toBe("alpha");
    press(ta, "ArrowDown");
    expect(ta.value).toBe("beta");
    press(ta, "ArrowDown");
    expect(ta.value).toBe("");
  });

  it("leaves an edited recall alone on ↑ and ↓", () => {
    const { container } = mount(["alpha", "beta"]);
    const ta = field(container);
    press(ta, "ArrowUp");
    expect(ta.value).toBe("beta");
    type(ta, "beta\nand a new paragraph");
    // The keys are not taken, so the browser moves the caret.
    expect(press(ta, "ArrowUp")).toBe(true);
    expect(ta.value).toBe("beta\nand a new paragraph");
    expect(press(ta, "ArrowDown")).toBe(true);
    expect(ta.value).toBe("beta\nand a new paragraph");
  });

  it("leaves a message typed over a recall alone", () => {
    const { container } = mount(["alpha", "beta"]);
    const ta = field(container);
    press(ta, "ArrowUp");
    type(ta, "a whole new\ntwo-line message");
    expect(press(ta, "ArrowUp")).toBe(true);
    expect(press(ta, "ArrowDown")).toBe(true);
    expect(ta.value).toBe("a whole new\ntwo-line message");
  });

  it("starts walking again once the field is emptied", () => {
    const { container } = mount(["alpha", "beta"]);
    const ta = field(container);
    press(ta, "ArrowUp");
    type(ta, "");
    press(ta, "ArrowUp");
    expect(ta.value).toBe("beta");
  });

  it("walks past a recalled slash command instead of opening its menu", () => {
    const { container } = mount(["older words", "/compact"]);
    const ta = field(container);
    press(ta, "ArrowUp");
    expect(ta.value).toBe("/compact");
    expect(container.querySelector(".tl-complete")).toBeNull();
    press(ta, "ArrowUp");
    expect(ta.value).toBe("older words");
  });
});
