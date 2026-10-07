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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";
import type { AnswerRequest } from "../src/lib/answer-api";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "qa", ...e });

/** The card's row digits arm a moment after it docks (TextView
 *  CARD_KEYS_ARM_MS); a digit pressed before that is typing. */
const armed = (root: HTMLElement) =>
  waitFor(() => expect(root.querySelector('[data-card-keys="armed"]')).not.toBeNull(), {
    timeout: 2000,
  });

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

  it("shows an Edit's change in its well, not the unchanged lines above it", async () => {
    // Found live on 2026-09-27: the well showed "calc.py", "def add" and
    // "return a + b", and the added function sat below its fold.
    const edit = JSON.stringify({
      kind: "permission",
      title: "Edit file",
      detail: ["calc.py", "1 def add(a, b):", "2     return a + b", "3 +"],
      prompt: "Do you want to make this edit to calc.py?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    });
    const { card } = mount([
      ev({ id: 1, kind: "user", body: "add subtract", at: 1000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Edit",
        toolId: "e1",
        body: JSON.stringify({
          file_path: "/tmp/proj/calc.py",
          old_string: "    return a + b",
          new_string: "    return a + b\n\n\ndef subtract(a, b):\n    return a - b",
        }),
        at: 2000,
      }),
      ev({ id: 3, kind: "meta", meta: "asking", body: edit }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const well = card()!.querySelector(".tl-permcard-detail")!;
    const lines = [...well.querySelectorAll(".tl-permcard-line")].map((l) => [
      l.getAttribute("data-sign"),
      l.textContent,
    ]);
    expect(well.querySelector(".tl-permcard-file")?.textContent).toBe("calc.py");
    expect(lines).toEqual([
      [" ", "      return a + b"],
      ["+", "+ def subtract(a, b):"],
      ["+", "+     return a - b"],
    ]);
    expect(well.textContent).not.toContain("def add");
    expect(card()!.textContent).toContain("Do you want to make this edit to calc.py?");
  });

  it("marks the pane's changed lines while the call is not in the transcript yet", async () => {
    // Seen live on 2026-09-27: with two calls in one message the prompt was up
    // before the transcript had either, so the well had only the pane's lines.
    const edit = JSON.stringify({
      kind: "permission",
      title: "Edit file",
      detail: [
        "calc.py",
        "1  def add(a, b):",
        "2      return a + b",
        "3 +",
        "4 +def mul(a, b):",
        "5 -# end",
      ],
      prompt: "Do you want to make this edit to calc.py?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    });
    const { card } = mount([
      ev({ id: 1, kind: "user", body: "add mul", at: 1000 }),
      ev({ id: 3, kind: "meta", meta: "asking", body: edit }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    const signs = [...card()!.querySelectorAll(".tl-permcard-detail .tl-permcard-line")].map((l) =>
      l.getAttribute("data-sign"),
    );
    expect(signs).toEqual([null, null, null, "+", "+", "-"]);
    expect(card()!.querySelector(".tl-permcard-detail")!.textContent).toContain(
      "4 +def mul(a, b):",
    );
  });

  it("shows a Bash call's command in its well and its description under it", async () => {
    const bash = JSON.stringify({
      kind: "permission",
      title: "Bash command",
      detail: [
        "│ npm run build --workspace frontend-v2",
        "Build the frontend",
        "This command requires approval",
      ],
      prompt: "Do you want to proceed?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    });
    const { card } = mount([
      ev({ id: 1, kind: "user", body: "build it", at: 1000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Bash",
        toolId: "b1",
        body: JSON.stringify({
          command: "npm run build --workspace frontend-v2",
          description: "Build the frontend",
        }),
        at: 2000,
      }),
      ev({ id: 3, kind: "meta", meta: "asking", body: bash }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector(".tl-permcard-detail")?.textContent).toBe(
      "npm run build --workspace frontend-v2",
    );
    expect(card()!.querySelector(".tl-permcard-prompt")?.textContent).toBe("Build the frontend");
  });

  it("tells the header Claude is waiting the moment the card docks", async () => {
    const onLiveState = vi.fn();
    const { setEvents, card } = mount(base, undefined, undefined, { onLiveState });
    await waitFor(() => expect(onLiveState).toHaveBeenLastCalledWith("running"));
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(onLiveState).toHaveBeenLastCalledWith("awaiting");
    setEvents([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
      ev({ id: 4, kind: "tool_result", toolId: "b1", body: "", at: 3000 }),
      ev({ id: 5, kind: "text", body: "Done.", at: 3100 }),
      ev({ id: 6, kind: "turn_end", at: 3200 }),
    ]);
    await waitFor(() => expect(onLiveState).toHaveBeenLastCalledWith("done"));
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

  // Deployed review round 1 (2026-09-28): a suspended session's model button
  // read the permission mode, "✳ Auto". The session list now names a
  // suspended session's tool (Claude), so the button names the model, and it
  // holds while no Claude is running to drive the picker.
  it("names the model on a suspended session and holds the button until it wakes", async () => {
    const { r } = mount(
      [
        ...base,
        ev({ id: 3, kind: "tool_result", toolId: "b1", body: "ok", at: 3000 }),
        ev({
          id: 4,
          kind: "meta",
          meta: "model",
          model: { model: "claude-opus-5-5", effort: "high" },
          at: 3500,
        }),
        ev({ id: 5, kind: "text", body: "done", at: 4000 }),
        ev({ id: 6, kind: "turn_end", at: 4000 }),
      ],
      undefined,
      undefined,
      {
        harness: "claude",
        suspended: () => true,
        onSetModel: async () => ({ ok: true as const, state: { model: "", effort: "" } }),
      },
    );
    const model = r.container.querySelector<HTMLButtonElement>(".tl-model-btn")!;
    expect(model.querySelector(".tl-model-name")?.textContent).toBe("Opus 5.5");
    expect(model.getAttribute("aria-disabled")).toBe("true");
    expect(model.getAttribute("title")).toBe(
      "The session is asleep. Send a message to wake it, then change the model",
    );
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

  // Answered, the card goes and the field is back: the focus goes with it,
  // so the next message can be typed at once (deployed review rounds 3 to 5,
  // 2026-09-28: it fell to the page).
  it("gives the field the focus back when the card goes", async () => {
    const { r, card, setEvents } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    card()!.querySelector<HTMLButtonElement>(".tl-qcard-option")!.focus();
    setEvents([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
      ev({ id: 4, kind: "tool_result", toolId: "b1", body: "" }),
    ]);
    await waitFor(() => expect(card()).toBeNull());
    const field = r.container.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;
    await waitFor(() => expect(document.activeElement).toBe(field));
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
    await armed(r.container);
    const typed = fireEvent.keyDown(field, { key: "2" });
    expect(typed).toBe(false); // the digit is not typed
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["2"]));
    // The card is inert once a row went in, from the keyboard as from a tap.
    fireEvent.keyDown(field, { key: "1" });
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  it("presses the row a digit names while the focus is in the Text view, once", async () => {
    const { r, card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    await armed(r.container);
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
    await armed(r.container);
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

  /**
   * Deployed review round 1 (2026-09-28): typing "please fix the 2 tests and
   * then 1 more thing" at 200 ms a key, the card docked at the ninth
   * character, the field hid, the focus fell to the page, and the other 130
   * characters went nowhere with no notice. The field now keeps the focus,
   * out of sight behind the card, so the words land in the message, and no
   * digit among them presses a row.
   */
  it("keeps the words typed after the card docks in the message, out of sight", async () => {
    const { r, card, setEvents, composer, onKeys, notify } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    fireEvent.input(field, { target: { value: "please fix" } });
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    await Promise.resolve();
    expect(document.activeElement).toBe(field);
    expect(composer().hidden).toBe(false);
    expect(composer().dataset.offstage).toBe("");
    expect(notify).toHaveBeenCalledWith(
      "Claude needs an answer. What you type stays in your message for after.",
      "info",
    );
    expect(fireEvent.keyDown(field, { key: "2" })).toBe(true);
    fireEvent.input(field, { target: { value: "please fix the 2 tests" } });
    expect(onKeys).not.toHaveBeenCalled();
    expect(field.value).toBe("please fix the 2 tests");
  });

  it("hides the field once the focus leaves it while the card is up", async () => {
    const { r, card, setEvents, composer } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    fireEvent.input(field, { target: { value: "please fix" } });
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    card()!.focus();
    await waitFor(() => expect(composer().hidden).toBe(true));
    expect(composer().dataset.offstage).toBeUndefined();
    expect(field.value).toBe("please fix");
  });

  it("sends nothing from the hidden field while the card is up", async () => {
    const { r, card, setEvents, onSend, onKeys } = mount(base);
    const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    fireEvent.input(field, { target: { value: "please fix" } });
    setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.keyDown(field, { key: "Enter" });
    // Kept, ending on a new line so the next words typed out of sight start
    // their own (Composer.queue.test.tsx, "a send refused behind a card").
    await waitFor(() => expect(field.value).toBe("please fix\n"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onKeys).not.toHaveBeenCalled();
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
    await armed(r.container);
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
    await armed(r.container);
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

  /**
   * Found in deployed review round 2 (2026-09-28): a typed decline that failed
   * left the prompt's No field open with the cursor in it, and the card's
   * "1 Yes" sent the bare digit, which the field took ("No, 1") instead of
   * approving. Where the view can answer, a row goes through the answer route
   * with its number and label, and the server walks the cursor off the field
   * before the digit (sessionio permdrive.go permPick).
   */
  it("picks a row through the answer route, with the label the reader saw", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({ applied: true, done: true }));
    const { card, onKeys } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onAnswer },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!);
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({ permission: { option: 1, label: "Yes" } }),
    );
    fireEvent.click(card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[1]!);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("says a row did not land, and leaves the card live", async () => {
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
    const yes = card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!;
    fireEvent.click(yes);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Couldn't answer Claude's prompt. Answer it in the Terminal.",
        "error",
      ),
    );
    await waitFor(() => expect(yes.disabled).toBe(false));
  });

  /**
   * Found in deployed review round 2 (2026-09-28): the card is keyed on the
   * reading, and the pane redrawing the same prompt's rows (the driver's Tab
   * opening the No field, a resize from 47 to 80 columns turning
   * "different…" into "differently") sent a new reading. The card remounted,
   * and the words the reader was typing were gone. The words and whether the
   * field is open belong to the prompt, not to one reading of it.
   */
  it("keeps the words typed for a prompt when the pane redraws its rows", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({ applied: true, done: true }));
    const asking = (id: number, no: string, detail = "printf 'hi\\n' > a.txt") =>
      ev({
        id,
        kind: "meta",
        meta: "asking",
        body: JSON.stringify({
          ...JSON.parse(READING),
          detail: [detail],
          options: [
            { number: 1, label: "Yes" },
            { number: 2, label: "Yes, and always allow access to /tmp/x from this project" },
            { number: 3, label: no },
          ],
        }),
      });
    const { card, setEvents } = mount([...base, asking(3, "No")], undefined, undefined, {
      onAnswer,
    });
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(card()!.querySelector<HTMLButtonElement>(".tl-qcard-own")!);
    const field = await waitFor(
      () => card()!.querySelector<HTMLTextAreaElement>(".tl-qcard-owninput")!,
    );
    fireEvent.input(field, { target: { value: "Write bye instead" } });

    setEvents([...base, asking(3, "No"), asking(4, "No, and tell Claude what to do different…")]);
    await waitFor(() => expect(card()!.textContent).toContain("different…"));
    const again = card()!.querySelector<HTMLTextAreaElement>(".tl-qcard-owninput");
    expect(again?.value).toBe("Write bye instead");

    // The next prompt is another one, and starts empty.
    setEvents([...base, asking(5, "No", "rm b.txt")]);
    await waitFor(() => expect(card()!.textContent).toContain("rm b.txt"));
    expect(card()!.querySelector(".tl-qcard-owninput")).toBeNull();
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

/**
 * Escape on the card turns the tool down, which is what Esc means on Claude's
 * own permission prompt. It presses the No row rather than sending Escape: the
 * prompt on the pane is the mod's menu, where Esc only dismisses it and Claude
 * decides without asking (measured 2026-10-07 in auto mode: the command ran).
 * Once per card, since a second Esc reaching an idle prompt is half of the
 * double press that opens Claude's rewind menu.
 */
describe("Escape on a permission card", () => {
  const docked = async () => {
    const v = mount([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    return v;
  };

  it("presses the No row, once", async () => {
    const { r, card, onKeys } = await docked();
    await armed(r.container);
    expect(fireEvent.keyDown(card()!, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(onKeys).toHaveBeenCalledWith(["3"]));
    fireEvent.keyDown(card()!, { key: "Escape" });
    expect(onKeys).toHaveBeenCalledTimes(1);
    expect(onKeys).not.toHaveBeenCalledWith(["Escape"]);
  });

  it("presses it through the answer route, with the label the reader saw", async () => {
    const onAnswer = vi.fn(async (_r: AnswerRequest) => ({ applied: true, done: true }));
    const { r, card, onKeys } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      undefined,
      undefined,
      { onAnswer },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    await armed(r.container);
    fireEvent.keyDown(card()!, { key: "Escape" });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ permission: { option: 3, label: "No" } });
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("presses nothing on a prompt with no No row", async () => {
    const noNo = JSON.parse(READING) as { options: { number: number; label: string }[] };
    noNo.options = noNo.options.slice(0, 2);
    const { r, card, onKeys } = mount([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: JSON.stringify(noNo) }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    await armed(r.container);
    fireEvent.keyDown(card()!, { key: "Escape" });
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("sends nothing before the card's keys arm", async () => {
    const { r, card, onKeys } = await docked();
    expect(r.container.querySelector('[data-card-keys="armed"]')).toBeNull();
    fireEvent.keyDown(card()!, { key: "Escape" });
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("sends nothing from a watching device", async () => {
    const onKeys = vi.fn(async (_k: string[]) => true);
    const { r, card } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      onKeys,
      undefined,
      { inertReason: "Watching. Take control to answer." },
    );
    await waitFor(() => expect(card()).not.toBeNull());
    await armed(r.container);
    fireEvent.keyDown(card()!, { key: "Escape" });
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("takes another Escape when the No did not land", async () => {
    const onKeys = vi.fn(async (_k: string[]) => false);
    const { r, card } = mount(
      [...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })],
      onKeys,
    );
    await waitFor(() => expect(card()).not.toBeNull());
    await armed(r.container);
    fireEvent.keyDown(card()!, { key: "Escape" });
    await waitFor(() => expect(onKeys).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    fireEvent.keyDown(card()!, { key: "Escape" });
    await waitFor(() => expect(onKeys).toHaveBeenCalledTimes(2));
  });
});

// Deployed review round 3 (2026-09-28): a prompt taller than the pane reads
// with no title and no detail. The card showed "Claude wants to use a tool"
// and nothing to approve; it now names the waiting call's command.
describe("a permission prompt taller than the pane", () => {
  it("shows the waiting command and says it is one", async () => {
    const tall = JSON.stringify({
      kind: "permission",
      title: "",
      detail: [],
      prompt: "Do you want to proceed?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    });
    const { card } = mount([
      ev({ id: 1, kind: "user", body: "write the file", at: 1000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Bash",
        toolId: "b1",
        body: JSON.stringify({
          command: "cat > long.txt <<'EOF'\nline 1\nline 2\nEOF",
          description: "Write numbered lines to long.txt",
        }),
        at: 2000,
      }),
      ev({ id: 3, kind: "meta", meta: "asking", body: tall }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector(".tl-qcard-title")?.textContent).toBe(
      "Claude wants to run a command",
    );
    expect(card()!.querySelector(".tl-permcard-detail")?.textContent).toBe(
      "cat > long.txt <<'EOF'\nline 1\nline 2\nEOF",
    );
    expect(card()!.textContent).toContain("Write numbered lines to long.txt");
  });

  // Deployed review round 4 (2026-09-28): a tall Write showed only its
  // question, "Do you want to create big.txt?", and nothing going in.
  it("names a waiting Write and shows the lines it puts in the file", async () => {
    const tall = JSON.stringify({
      kind: "permission",
      title: "",
      detail: [],
      prompt: "Do you want to create big.txt?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    });
    const { card } = mount([
      ev({ id: 1, kind: "user", body: "write the file", at: 1000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Write",
        toolId: "w1",
        body: JSON.stringify({
          file_path: "/tmp/proj/big.txt",
          content: "1 red\n2 green\n3 blue\n",
        }),
        at: 2000,
      }),
      ev({ id: 3, kind: "meta", meta: "asking", body: tall }),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.querySelector(".tl-qcard-tag")?.textContent).toBe("Create file");
    expect(card()!.querySelector(".tl-permcard-file")?.textContent).toBe("big.txt");
    const lines = [...card()!.querySelectorAll(".tl-permcard-line")].map((l) => l.textContent);
    expect(lines).toEqual(["1 red", "2 green", "3 blue"]);
    expect(card()!.textContent).toContain("Do you want to create big.txt?");
  });
});

/**
 * Deployed review round 3 (2026-09-28): with the field empty, the card took
 * the focus the moment it docked and a bare digit pressed its row at once.
 * "4 more words", typed 30ms after the card appeared, pressed No and lost
 * " more words"; a leading "2" would have granted a lasting permission. And
 * letters typed on the focused card went nowhere, with no notice.
 *
 * The row digits now arm a moment after the card docks, and what is typed on
 * the card before that, or any letter after it, goes into the message behind
 * the card, as words typed while a card docks already did.
 */
describe("keys typed as a permission card docks", () => {
  const docked = async (v: ReturnType<typeof mount>) => {
    const field = v.r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    v.setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(v.card()));
    return field;
  };

  it("types a digit pressed the moment the card docks into the message", async () => {
    const v = mount(base);
    const field = await docked(v);
    expect(v.r.container.querySelector('[data-card-keys="armed"]')).toBeNull();
    expect(fireEvent.keyDown(v.card()!, { key: "4" })).toBe(false);
    expect(v.onKeys).not.toHaveBeenCalled();
    expect(field.value).toBe("4");
    expect(document.activeElement).toBe(field);
    expect(v.composer().dataset.offstage).toBe("");
    expect(v.notify).toHaveBeenCalledWith(
      "Claude needs an answer. What you type stays in your message for after.",
      "info",
    );
  });

  it("types letters pressed on the focused card into the message", async () => {
    const v = mount(base);
    const field = await docked(v);
    await waitFor(
      () => expect(v.r.container.querySelector('[data-card-keys="armed"]')).not.toBeNull(),
      {
        timeout: 2000,
      },
    );
    expect(fireEvent.keyDown(v.card()!, { key: "h" })).toBe(false);
    expect(field.value).toBe("h");
    expect(document.activeElement).toBe(field);
    expect(v.onKeys).not.toHaveBeenCalled();
  });

  it("presses the row once the card has been up a moment", async () => {
    const v = mount(base);
    await docked(v);
    await waitFor(
      () => expect(v.r.container.querySelector('[data-card-keys="armed"]')).not.toBeNull(),
      {
        timeout: 2000,
      },
    );
    expect(fireEvent.keyDown(v.card()!, { key: "3" })).toBe(false);
    await waitFor(() => expect(v.onKeys).toHaveBeenCalledWith(["3"]));
  });
});

/**
 * Deployed review round 3 of the T3 pass (2026-09-29, Android emulator, real
 * Chrome): a card docked while the phone's keyboard was up for a draft. The
 * hidden field kept the focus, so the keyboard stayed up and hid the card's
 * No row and "Type your own answer", and every key went into a field nobody
 * could see. On a phone the field now lets go of the focus as a card docks,
 * which puts the keyboard away; the draft stays in it for after. The card's
 * rows then sit where the keys were, so a tap meant for a key does not press
 * one until the card has been still for a moment.
 */
describe("a card that docks over the phone's keyboard", () => {
  const original = window.matchMedia;
  const originalVV = Object.getOwnPropertyDescriptor(window, "visualViewport");
  beforeEach(() => {
    window.matchMedia = ((q: string) =>
      ({
        media: q,
        matches: q.includes("pointer: coarse"),
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
    if (originalVV) Object.defineProperty(window, "visualViewport", originalVV);
    else Reflect.deleteProperty(window, "visualViewport");
  });

  const dock = async (v: ReturnType<typeof mount>, draft: string) => {
    const field = v.r.container.querySelector<HTMLTextAreaElement>("textarea")!;
    field.focus();
    fireEvent.input(field, { target: { value: draft } });
    v.setEvents([...base, ev({ id: 3, kind: "meta", meta: "asking", body: READING })]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    return field;
  };

  it("lets go of the field's focus, keeps the draft, and says so", async () => {
    const v = mount(base);
    const field = await dock(v, "my draft");
    await waitFor(() => expect(document.activeElement).not.toBe(field));
    expect(v.composer().hidden).toBe(true);
    expect(field.value).toBe("my draft");
    expect(v.notify).toHaveBeenCalledWith(
      "Claude needs an answer. Your message is kept for after.",
      "info",
    );
    expect(v.notify).not.toHaveBeenCalledWith(
      "Claude needs an answer. What you type stays in your message for after.",
      "info",
    );
    v.setEvents([
      ...base,
      ev({ id: 3, kind: "meta", meta: "asking", body: READING }),
      ev({ id: 4, kind: "tool_result", toolId: "b1", body: "" }),
    ]);
    await waitFor(() => expect(v.card()).toBeNull());
    expect(field.value).toBe("my draft");
  });

  it("presses no row for a tap the moment it docks, and does once it has been up", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    const row = () => v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!;
    fireEvent.click(row());
    await Promise.resolve();
    expect(v.onKeys).not.toHaveBeenCalled();
    await armed(v.r.container);
    fireEvent.click(row());
    await waitFor(() => expect(v.onKeys).toHaveBeenCalledWith(["1"]));
  });

  // Deployed review round 4 (2026-09-29, Android emulator): a reader kept
  // tapping the keyboard's "e" about every 0.4 s after the card docked. The
  // first two taps were swallowed, and the third, 647 ms after the keyboard
  // went, landed on "Yes" where the top letter row had been and ran the tool.
  // A tap too soon is still typing, so it starts the wait again, and once the
  // card has put the keyboard away the wait is a full second.
  it("keeps a run of taps meant for the keyboard from pressing a row", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    const row = () => v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!;
    for (let i = 0; i < 6; i++) {
      await new Promise((done) => setTimeout(done, 400));
      fireEvent.click(row());
    }
    await Promise.resolve();
    expect(v.onKeys).not.toHaveBeenCalled();
    expect(v.r.container.querySelector('[data-card-keys="armed"]')).toBeNull();
    // The taps stop: the reader has looked up, and the next tap is meant.
    await armed(v.r.container);
    fireEvent.click(row());
    await waitFor(() => expect(v.onKeys).toHaveBeenCalledWith(["1"]));
  });

  // Same replay: a key the keyboard sent as it slid away landed on the card,
  // which put it in the draft and focused the field, and that raised the
  // keyboard again over the card's lower rows. On a phone the key still goes
  // into the draft, and the focus stays off the field.
  it("puts a key the going keyboard sent into the draft without raising it again", async () => {
    const v = mount(base);
    const field = await dock(v, "my draft");
    await waitFor(() => expect(document.activeElement).toBe(v.card()));
    fireEvent.keyDown(v.card()!, { key: "e" });
    expect(field.value).toBe("my drafte");
    expect(document.activeElement).not.toBe(field);
  });

  // Deployed review round 6 (2026-09-30, Android emulator, real Chrome): a
  // swallowed tap still focused the row, since Android Chrome focuses a button
  // as the finger goes down. Once the card armed, one Space pressed that row,
  // and once it granted "Yes, and don't ask again", writing an allow rule into
  // the project's settings. A row a guarded tap focused hands the focus to the
  // card, and a key that would press a row before it arms presses nothing.
  it("leaves no row with the focus after a tap it swallowed", async () => {
    const v = mount(base);
    const field = await dock(v, "my draft");
    const row = () => v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[1]!;
    fireEvent.pointerDown(row());
    row().focus();
    fireEvent.click(row());
    expect(v.onKeys).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(row());
    expect(document.activeElement).toBe(v.card());
    await armed(v.r.container);
    // The Space that pressed "Yes, and don't ask again" lands on the card.
    fireEvent.keyDown(document.activeElement!, { key: " " });
    fireEvent.keyUp(document.activeElement!, { key: " " });
    expect(v.onKeys).not.toHaveBeenCalled();
    expect(field.value.startsWith("my draft")).toBe(true);
  });

  it("hands the focus to the card when a row takes it before the card arms", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    const row = v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[1]!;
    // A touch that focused the row and never became a click.
    row.focus();
    expect(document.activeElement).toBe(v.card());
  });

  it("presses no row for Space or Enter before the card arms", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    const row = v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[1]!;
    expect(fireEvent.keyDown(row, { key: " " })).toBe(false);
    expect(fireEvent.keyUp(row, { key: " " })).toBe(false);
    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(v.onKeys).not.toHaveBeenCalled();
  });

  it("swallows a tap that went down before the card armed and lifted after", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    const row = () => v.card()!.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")[0]!;
    fireEvent.pointerDown(row());
    await armed(v.r.container);
    fireEvent.click(row());
    await Promise.resolve();
    expect(v.onKeys).not.toHaveBeenCalled();
    await armed(v.r.container);
    fireEvent.pointerDown(row());
    fireEvent.click(row());
    await waitFor(() => expect(v.onKeys).toHaveBeenCalledWith(["1"]));
  });

  // Deployed review round 6 (2026-09-30, iPhone emulation and the Android
  // emulator): words typed on to a card that docked mid-sentence came back as
  // "keeptypingwhilethecardarrives", every space dropped, while the toast
  // said what you type stays for after.
  it("keeps the spaces of words typed on to the card", async () => {
    const v = mount(base);
    const field = await dock(v, "follow up draft text that I");
    await waitFor(() => expect(document.activeElement).toBe(v.card()));
    for (const key of " keep typing while it arrives") {
      fireEvent.keyDown(document.activeElement!, { key });
    }
    expect(field.value).toBe("follow up draft text that I keep typing while it arrives");
    expect(v.onKeys).not.toHaveBeenCalled();
  });

  it("waits a full second after taking the keyboard away before a tap presses", async () => {
    const v = mount(base);
    await dock(v, "my draft");
    await new Promise((done) => setTimeout(done, 800));
    expect(v.r.container.querySelector('[data-card-keys="armed"]')).toBeNull();
    await armed(v.r.container);
  });

  it("waits for the keyboard to finish going before a tap presses a row", async () => {
    const vv = Object.assign(new EventTarget(), { height: 471 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const v = mount(base);
    await dock(v, "my draft");
    const docked = Date.now();
    // The keyboard is still sliding away 400 ms in.
    await new Promise((done) => setTimeout(done, 400));
    vv.height = 783;
    vv.dispatchEvent(new Event("resize"));
    await new Promise((done) => setTimeout(done, 300));
    expect(Date.now() - docked).toBeGreaterThan(600);
    expect(v.r.container.querySelector('[data-card-keys="armed"]')).toBeNull();
    await armed(v.r.container);
  });
});
