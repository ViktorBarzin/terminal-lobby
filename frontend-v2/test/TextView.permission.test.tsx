/**
 * The tool permission prompt, answered from the Text view.
 *
 * Measured 2026-09-27: in manual mode Claude drew "Do you want to proceed?"
 * for a Bash command, the status line read "Working … Stop" for over two
 * minutes, and the only way to answer was the Terminal. The server now reports
 * the prompt off the pane, and the view docks a card with the prompt's own
 * rows. A row's number is the key that picks it (measured: "1" ran the command
 * with no Enter), so a tap presses that digit.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "qa", ...e });

const READING = JSON.stringify({
  kind: "permission",
  title: "Bash command",
  detail: ["printf 'hi\\n' > a.txt"],
  prompt: "Do you want to proceed?",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "Yes, and always allow access to /tmp/x from this project" },
    { number: 3, label: "No" },
  ],
});

const base: Event[] = [
  ev({ id: 1, kind: "user", body: "write the file", at: 1000 }),
  ev({
    id: 2,
    kind: "tool_use",
    tool: "Bash",
    toolId: "b1",
    body: '{"command":"printf hi > a.txt"}',
    at: 2000,
  }),
];

function mount(
  initial: Event[],
  onKeys = vi.fn(async (_k: string[]) => true),
  onSend = vi.fn(async () => true),
) {
  const [events, setEvents] = createSignal<Event[]>(initial);
  const notify = vi.fn();
  const r = render(() => (
    <TextView
      events={events()}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={onKeys}
      onPane={async () => ({ pane: "", state: "running" })}
      notify={notify}
    />
  ));
  const card = () => r.container.querySelector<HTMLElement>(".tl-permcard");
  return { r, setEvents, card, onKeys, onSend, notify };
}

describe("the permission card", () => {
  it("docks with the prompt's own rows, and the line says Claude is waiting", async () => {
    const { r, card } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.textContent).toContain("Bash command");
    expect(card()!.textContent).toContain("printf 'hi\\n' > a.txt");
    expect(card()!.textContent).toContain("Do you want to proceed?");
    const rows = [...card()!.querySelectorAll(".tl-qcard-option")].map((b) => b.textContent);
    expect(rows).toEqual([
      "1Yes",
      "2Yes, and always allow access to /tmp/x from this project",
      "3No",
    ]);
    const line = r.container.querySelector(".tl-statusline")?.textContent ?? "";
    expect(line).toContain("Waiting");
    expect(
      r.container.querySelector(
        ".tl-statusline button[aria-label*='Stop'], .tl-statusline .tl-stop",
      ),
    ).toBeNull();
  });

  it("presses the row's number, once", async () => {
    const { card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const no = card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[2]!;
    fireEvent.click(no);
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["3"]));
    fireEvent.click(card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!);
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  it("goes when the prompt does", async () => {
    const { card, setEvents } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    setEvents([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
      ev({ id: 4, kind: "tool_result", toolId: "b1", body: "" }),
    ]);
    await waitFor(() => expect(card()).toBeNull());
  });

  /**
   * The spec keeps "1 or 2 on an empty field answers a pending permission".
   * Found in review on 2026-09-27: the digit went into the field, because the
   * shortcut only knew the hook-fed list, which nothing fills in production.
   * The card's rows carry the CLI's own numbers as keycaps, so a digit presses
   * the row it names: 2 here is "always allow", not the old list's "deny".
   */
  it("presses the row a digit names on an empty field", async () => {
    const { r, card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    const typed = fireEvent.keyDown(field, { key: "2" });
    expect(typed).toBe(false); // the digit is not typed
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["2"]));
    // The card is inert once a row went in, from the keyboard as from a tap.
    fireEvent.keyDown(field, { key: "1" });
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  it("leaves a digit to be typed when the field has text or the card has no such row", async () => {
    const { r, card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(fireEvent.keyDown(field, { key: "7" })).toBe(true);
    fireEvent.input(field, { target: { value: "row " } });
    expect(fireEvent.keyDown(field, { key: "1" })).toBe(true);
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("keeps the composer's text out of the prompt's menu", async () => {
    const { r, card, onSend, notify } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.input(field, { target: { value: "actually, don't" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
  });
});
