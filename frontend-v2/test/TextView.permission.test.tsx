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
import { createSignal, type ComponentProps } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";
import type { AnswerRequest } from "../src/lib/answer-api";

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
  extra: Partial<ComponentProps<typeof TextView>> = {},
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
      {...extra}
    />
  ));
  const card = () => r.container.querySelector<HTMLElement>(".tl-permcard");
  const composer = () => r.container.querySelector<HTMLElement>(".tl-composer")!;
  return { r, events, setEvents, card, composer, onKeys, onSend, notify };
}

describe("the permission card", () => {
  it("docks with the prompt's own rows, and the conversation does not echo it", async () => {
    const { r, card } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector(".tl-qcard-title")?.textContent).toBe(
      "Claude wants to run a command",
    );
    expect(card()!.textContent).toContain("printf 'hi\\n' > a.txt");
    expect(card()!.textContent).toContain("Do you want to proceed?");
    const rows = [...card()!.querySelectorAll(".tl-qcard-option")].map((b) => b.textContent);
    expect(rows).toEqual([
      "1Yes",
      "2Yes, and always allow access to /tmp/x from this project",
      "3No",
    ]);
    // The card says Claude is waiting; the group it interrupted reads settled,
    // as prototype 6-permission draws it, and no "Waiting for you" row echoes it.
    expect(r.container.querySelector(".tl-timeline .tl-group-box[data-live]")).toBeNull();
    expect(r.container.querySelector(".tl-timeline")!.textContent).not.toContain("Waiting for you");
    expect(r.container.querySelector('.tl-composer .tl-send[data-kind="stop"]')).toBeNull();
  });

  it("takes the composer's place, which stays mounted with its draft", async () => {
    const { r, card, composer, setEvents } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.input(field, { target: { value: "next, tidy the tests" } });
    expect(composer().hidden).toBe(false);

    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(composer().hidden).toBe(true);
    expect(r.container.querySelector("textarea")).toBe(field);
    expect(field.value).toBe("next, tidy the tests");

    setEvents([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
      ev({ id: 4, kind: "tool_result", toolId: "b1", body: "" }),
    ]);
    await waitFor(() => expect(card()).toBeNull());
    expect(composer().hidden).toBe(false);
    expect(field.value).toBe("next, tidy the tests");
  });

  it("offers the Terminal from its head", async () => {
    const onOpenTerminal = vi.fn();
    const { card } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onOpenTerminal },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    const link = card()!.querySelector<HTMLButtonElement>(".tl-qcard-head .tl-qcard-link");
    expect(link?.textContent).toBe("Open in Terminal");
    link!.click();
    expect(onOpenTerminal).toHaveBeenCalled();
  });

  it("holds the model button while the prompt is up", async () => {
    // A `/model` typed now would land in the prompt's menu. The prompt is on
    // the pane before the transcript records anything that waits.
    const { r, card } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      {
        harness: "claude",
        onSetModel: async () => ({ ok: true as const, state: { model: "", effort: "" } }),
      },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    const model = r.container.querySelector<HTMLButtonElement>(".tl-model-btn")!;
    expect(model.getAttribute("aria-disabled")).toBe("true");
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

  it("presses the row a digit names while the focus is in the Text view, once", async () => {
    const { card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(fireEvent.keyDown(card()!, { key: "2" })).toBe(false);
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["2"]));
    fireEvent.keyDown(card()!, { key: "1" });
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  /**
   * Found live on 2026-09-27 (desktop, manual mode): after Send the card
   * docked and hid the field the focus was in, so the focus fell to the page
   * and the row digits did nothing until the reader clicked a row. A field the
   * reader had just emptied by sending hands the card the focus.
   */
  it("takes the focus from an empty field when it docks, so a digit presses a row", async () => {
    const { r, card, setEvents, onKeys } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card()));
    expect(fireEvent.keyDown(document.activeElement!, { key: "3" })).toBe(false);
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["3"]));
  });

  it("leaves the focus alone when the field has words in it as the card docks", async () => {
    const { r, card, setEvents } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    fireEvent.input(field, { target: { value: "fix the " } });
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    await Promise.resolve();
    expect(document.activeElement).not.toBe(card());
  });

  it("lets a click on the conversation give the keys to the view", async () => {
    // Clicking the transcript left the focus on the page's body, where a digit
    // is not the view's to take. The scroller takes the focus of a click.
    const { r, card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const timeline = r.container.querySelector<HTMLElement>(".tl-timeline")!;
    expect(timeline.getAttribute("tabindex")).toBe("-1");
    timeline.focus();
    expect(fireEvent.keyDown(timeline, { key: "1" })).toBe(false);
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["1"]));
  });

  it("leaves a digit typed on the page alone", async () => {
    // The field hides when the card docks, so the rest of a sentence being
    // typed lands on the page. "fix the 2 tests" must not allow anything.
    const { card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(fireEvent.keyDown(document.body, { key: "2" })).toBe(true);
    expect(onKeys).not.toHaveBeenCalled();
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

  /**
   * The T3 pass (prototype 6-permission): the card's last row is "Type your
   * own answer". Measured on CLI 2.1.283 on 2026-09-27, Tab on the prompt's
   * No row opens a field, and Enter there declines the tool call with the
   * words, which Claude reads as "the user said: <words>" and carries on. The
   * server drives that row (sessionio permdrive.go), so the card hands it the
   * words in one request, and it is the one press this prompt gets.
   */
  it("declines with the reader's words once, and goes inert", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({ applied: true, done: true }));
    const { card, onKeys, r } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onAnswer },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    const own = card()!.querySelector<HTMLButtonElement>(".tl-qcard-own")!;
    expect(own.querySelector(".tl-qcard-label")?.textContent).toBe("Type your own answer");
    expect(own.querySelector(".tl-qcard-desc")?.textContent).toBe(
      "Says no, and tells Claude what to do instead",
    );
    // The CLI's own rows stay as they are, No included, with the own row last.
    const rows = [...card()!.querySelectorAll(".tl-qcard-option")];
    expect(rows.at(-1)).toBe(own);
    expect(rows.slice(0, -1).map((b) => b.textContent)).toEqual([
      "1Yes",
      "2Yes, and always allow access to /tmp/x from this project",
      "3No",
    ]);

    fireEvent.click(own);
    const field = await waitFor(() => {
      const f = card()!.querySelector<HTMLTextAreaElement>(".tl-qcard-owninput");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.input(field, { target: { value: "use ls\ninstead " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer).toHaveBeenCalledWith({ permission: { decline: "use ls instead" } });

    // Inert from here: no row, no second Enter, no digit.
    await waitFor(() => expect(field.disabled).toBe(true));
    for (const b of card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")) {
      expect(b.disabled).toBe(true);
    }
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!);
    fireEvent.keyDown(card()!, { key: "1" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onKeys).not.toHaveBeenCalled();
    // The composer's own field never took the words.
    expect(r.container.querySelector<HTMLTextAreaElement>(".tl-composer textarea")!.value).toBe("");
  });

  it("keeps the words and the card live when the decline did not land", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({
      applied: false,
      reason: "unverified" as const,
    }));
    const { card, notify } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onAnswer },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(card()!.querySelector<HTMLButtonElement>(".tl-qcard-own")!);
    const field = await waitFor(
      () => card()!.querySelector<HTMLTextAreaElement>(".tl-qcard-owninput")!,
    );
    fireEvent.input(field, { target: { value: "use ls instead" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "error"));
    await waitFor(() => expect(field.disabled).toBe(false));
    expect(field.value).toBe("use ls instead");
    expect(card()!.querySelector<HTMLButtonElement>(".tl-qcard-option")!.disabled).toBe(false);
  });

  it("offers no typed answer while this device watches, or when the prompt has no No row", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({ applied: true, done: true }));
    const watching = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onAnswer, inertReason: "Watching. Take control to answer." },
    );
    await waitFor(() => expect(watching.card()).not.toBeNull());
    expect(watching.card()!.querySelector<HTMLButtonElement>(".tl-qcard-own")!.disabled).toBe(true);
    watching.r.unmount();

    const noNo = JSON.parse(READING) as { options: { number: number; label: string }[] };
    noNo.options = noNo.options.slice(0, 2);
    const { card } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: JSON.stringify(noNo) })],
      undefined,
      undefined,
      { onAnswer },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector(".tl-qcard-own")).toBeNull();
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
