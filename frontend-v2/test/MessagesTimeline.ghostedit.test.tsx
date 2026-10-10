/**
 * A queued message can be edited (Viktor, 2026-10-10: "let's allow editing the
 * queued message. press and hold should open an edit form").
 *
 * As Up does in Claude Code, editing takes the message OUT of the queue first,
 * so Claude cannot take it mid-edit. Press and hold on a phone, or the pencil
 * with a mouse, asks for that (onEditQueuedStart); the ghost dims and leaves on
 * the queue's own event. The form is drawn from the store's edit, at the end of
 * the queue, whether or not the ghost is still there. Save sends the new words,
 * Close puts the old ones back, Discard drops it, and a stray tap outside never
 * throws an edit away.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { GHOST_HOLD_MS, type QueuedEditActions } from "../src/components/QueuedGhost";
import type { OpenQueuedEdit } from "../src/store/drafts";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });
const RUNNING: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card" }),
  ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"a.ts"}' }),
];

const touch = (el: Element, type: string, x = 300, y = 100) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );

function mount(
  opts: {
    start?: (text: string) => Promise<boolean>;
    edit?: OpenQueuedEdit | null;
    queued?: string[];
    sending?: Set<number>;
    actions?: Partial<QueuedEditActions>;
  } = {},
) {
  const start = opts.start ?? vi.fn(async () => true);
  const [edit, setEdit] = createSignal<OpenQueuedEdit | null>(opts.edit ?? null);
  const [queued, setQueued] = createSignal(opts.queued ?? ["first", "second"]);
  const actions: QueuedEditActions = {
    onInput: vi.fn(),
    onSave: vi.fn(async () => true),
    onClose: vi.fn(async () => true),
    onDiscard: vi.fn(),
    ...opts.actions,
  };
  const r = render(() => (
    <MessagesTimeline
      events={RUNNING}
      queued={queued()}
      queuedSending={opts.sending}
      onCancelQueued={vi.fn(async () => true)}
      onEditQueuedStart={start}
      queuedEdit={edit()}
      queuedEditActions={actions}
    />
  ));
  const ghosts = () => Array.from(r.container.querySelectorAll<HTMLElement>(".tl-row-ghost"));
  const bubble = (i: number) => ghosts()[i]!.querySelector<HTMLElement>(".tl-bubble-ghost")!;
  const form = () => r.container.querySelector<HTMLElement>(".tl-ghost-edit");
  const field = () => r.container.querySelector<HTMLTextAreaElement>(".tl-ghost-edit textarea");
  const button = (name: string) =>
    Array.from(r.container.querySelectorAll<HTMLButtonElement>(".tl-ghost-edit button")).find(
      (b) => b.textContent === name,
    );
  const hold = (i: number) => {
    touch(bubble(i), "pointerdown");
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    touch(bubble(i), "pointerup");
  };
  const type = (text: string) => fireEvent.input(field()!, { target: { value: text } });
  return {
    ...r,
    start,
    actions,
    setEdit,
    setQueued,
    ghosts,
    bubble,
    form,
    field,
    button,
    hold,
    type,
  };
}

const EDIT: OpenQueuedEdit = { text: "first", draft: "first", status: "ready" };

afterEach(() => {
  vi.useRealTimers();
});

describe("taking a queued message out to edit it", () => {
  it("asks to take the held message out of the queue after a press and hold", () => {
    vi.useFakeTimers();
    const { hold, start, form } = mount();
    hold(1);
    expect(start).toHaveBeenCalledWith("second");
    // The form comes from the store's edit, not from the ghost.
    expect(form()).toBeNull();
  });

  // iOS raises the keyboard only for a focus inside a gesture handler. The
  // hold fires from a timer, so the pointerup that ends it focuses the box
  // the store opened at once.
  it("focuses the form in the pointerup that ends the hold", () => {
    vi.useFakeTimers();
    let open!: (edit: OpenQueuedEdit) => void;
    const start = vi.fn(async (text: string) => {
      open({ text, draft: text, status: "taking" });
      return true;
    });
    const r = mount({ start });
    open = r.setEdit;
    touch(r.bubble(0), "pointerdown");
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    expect(r.field()).not.toBeNull();
    const focus = vi.spyOn(r.field()!, "focus");
    touch(r.bubble(0), "pointerup");
    expect(focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(r.field());
  });

  // Measured on Android Chrome (2026-10-10): the server let go of the message
  // while the finger was still down, so the ghost left from under it, and its
  // own pointerup handler went with it. The lift is listened for on the
  // document instead.
  it("focuses the form when the finger lifts after the ghost has gone", () => {
    vi.useFakeTimers();
    let open!: (edit: OpenQueuedEdit) => void;
    let drop!: (q: string[]) => void;
    const start = vi.fn(async (text: string) => {
      open({ text, draft: text, status: "ready" });
      drop([]);
      return true;
    });
    const r = mount({ start });
    open = r.setEdit;
    drop = r.setQueued;
    touch(r.bubble(0), "pointerdown");
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    expect(r.ghosts().filter((g) => !g.hasAttribute("data-editing"))).toHaveLength(0);
    const focus = vi.spyOn(r.field()!, "focus");
    document.dispatchEvent(new Event("touchend", { bubbles: true }));
    expect(focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(r.field());
  });

  // The form opens under the finger, so until it lifts the browser's own
  // long-press menu is kept off the whole page, not only off the ghost.
  it("keeps the browser's long-press menu away until the finger lifts", () => {
    vi.useFakeTimers();
    const r = mount();
    touch(r.bubble(0), "pointerdown");
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    const during = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    const after = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("does not ask on a hold that moved, or on a short tap", () => {
    vi.useFakeTimers();
    const { bubble, start } = mount();
    touch(bubble(0), "pointerdown");
    touch(bubble(0), "pointermove", 300, 120);
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    touch(bubble(0), "pointerdown");
    vi.advanceTimersByTime(GHOST_HOLD_MS - 100);
    touch(bubble(0), "pointerup");
    vi.advanceTimersByTime(200);
    expect(start).not.toHaveBeenCalled();
  });

  it("dims the ghost while it is taken out, and brings it back when that fails", async () => {
    let settle!: (ok: boolean) => void;
    const start = vi.fn(() => new Promise<boolean>((r) => (settle = r)));
    const { ghosts } = mount({ start });
    fireEvent.click(ghosts()[0]!.querySelector(".tl-ghost-pencil")!);
    expect(start).toHaveBeenCalledWith("first");
    expect(ghosts()[0]!.hasAttribute("data-cancelling")).toBe(true);
    settle(false);
    await waitFor(() => expect(ghosts()[0]!.hasAttribute("data-cancelling")).toBe(false));
  });

  it("has a pencil for a mouse", () => {
    const { ghosts, start } = mount();
    const pencil = ghosts()[1]!.querySelector<HTMLButtonElement>(".tl-ghost-pencil")!;
    expect(pencil.getAttribute("aria-label")).toBe("Edit queued message");
    fireEvent.click(pencil);
    expect(start).toHaveBeenCalledWith("second");
  });

  it("offers no edit on a ghost still being sent, or with no way to edit", () => {
    vi.useFakeTimers();
    const { ghosts, hold, start } = mount({ sending: new Set([1]) });
    expect(ghosts()[0]!.querySelector(".tl-ghost-pencil")).not.toBeNull();
    expect(ghosts()[1]!.querySelector(".tl-ghost-pencil")).toBeNull();
    hold(1);
    expect(start).not.toHaveBeenCalled();

    const plain = render(() => <MessagesTimeline events={RUNNING} queued={["first"]} />);
    expect(plain.container.querySelector(".tl-ghost-pencil")).toBeNull();
  });
});

// One message is edited at a time: while a form is open, the other ghosts
// offer no pencil and a hold on them does nothing, rather than asking the
// server and being refused. They can still be discarded.
describe("while a form is open", () => {
  it("offers no edit on the other ghosts, and keeps their discard", () => {
    vi.useFakeTimers();
    const { ghosts, hold, start } = mount({ edit: EDIT, queued: ["second"] });
    expect(ghosts()[0]!.querySelector(".tl-ghost-pencil")).toBeNull();
    expect(ghosts()[0]!.querySelector(".tl-ghost-x")).not.toBeNull();
    hold(0);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("the edit form", () => {
  it("is drawn from the store's edit at the end of the queue, after the ghost has gone", () => {
    const { form, field, setEdit, setQueued, container } = mount();
    expect(form()).toBeNull();
    setEdit({ text: "first", draft: "first, half typed", status: "ready" });
    setQueued(["second"]);
    expect(field()?.value).toBe("first, half typed");
    expect(document.activeElement).toBe(field());
    const rows = Array.from(container.querySelectorAll(".tl-row-ghost"));
    expect(rows.at(-1)!.contains(field())).toBe(true);
  });

  it("is drawn with no queue left at all", () => {
    const { field } = mount({ edit: EDIT, queued: [] });
    expect(field()?.value).toBe("first");
  });

  it("keeps Save disabled while the text is unchanged or empty, and reports each change", () => {
    const { button, type, actions } = mount({ edit: EDIT });
    expect(button("Save")?.disabled).toBe(true);
    type("  first \n");
    expect(button("Save")?.disabled).toBe(true);
    type("   ");
    expect(button("Save")?.disabled).toBe(true);
    type("first, but better");
    expect(button("Save")?.disabled).toBe(false);
    expect(actions.onInput).toHaveBeenLastCalledWith("first, but better");
  });

  it("saves the new words, trimmed", () => {
    const { button, type, actions } = mount({ edit: EDIT });
    type("first, but better  ");
    fireEvent.click(button("Save")!);
    expect(actions.onSave).toHaveBeenCalledWith("first, but better");
  });

  it("dims while it saves and asks once, then comes back when the send failed", async () => {
    let settle!: (ok: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((r) => (settle = r)));
    const { button, type, ghosts, field } = mount({ edit: EDIT, actions: { onSave } });
    type("changed");
    fireEvent.click(button("Save")!);
    const row = ghosts().at(-1)!;
    expect(row.hasAttribute("data-cancelling")).toBe(true);
    fireEvent.click(button("Save")!);
    expect(onSave).toHaveBeenCalledTimes(1);
    settle(false);
    await waitFor(() => expect(row.hasAttribute("data-cancelling")).toBe(false));
    expect(field()?.value).toBe("changed");
  });

  it("saves on Cmd or Ctrl+Enter, and plain Enter is a new line", () => {
    const { type, field, actions } = mount({ edit: EDIT });
    fireEvent.keyDown(field()!, { key: "Enter", metaKey: true });
    expect(actions.onSave).not.toHaveBeenCalled();
    type("changed");
    fireEvent.keyDown(field()!, { key: "Enter" });
    expect(actions.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(field()!, { key: "Enter", ctrlKey: true });
    expect(actions.onSave).toHaveBeenCalledWith("changed");
  });

  it("puts it back on Close and on Escape", async () => {
    const { button, field, type, actions, ghosts } = mount({ edit: EDIT });
    type("changed");
    fireEvent.click(button("Close")!);
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ghosts().at(-1)!.hasAttribute("data-cancelling")).toBe(false));
    fireEvent.keyDown(field()!, { key: "Escape" });
    expect(actions.onClose).toHaveBeenCalledTimes(2);
    expect(actions.onSave).not.toHaveBeenCalled();
  });

  it("discards it with nothing sent", () => {
    const { button, actions } = mount({ edit: EDIT });
    fireEvent.click(button("Discard")!);
    expect(actions.onDiscard).toHaveBeenCalledTimes(1);
    expect(actions.onSave).not.toHaveBeenCalled();
    expect(actions.onClose).not.toHaveBeenCalled();
  });

  it("puts it back on a tap outside only while the text is unchanged", () => {
    const { type, actions } = mount({ edit: EDIT });
    touch(document.body, "pointerdown");
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    type("changed");
    touch(document.body, "pointerdown");
    expect(actions.onClose).toHaveBeenCalledTimes(1);
  });

  it("takes typing but sends nothing while the server is still letting go of it", () => {
    const { button, type, field, actions, form } = mount({
      edit: { text: "first", draft: "first", status: "taking" },
    });
    expect(button("Save")?.disabled).toBe(true);
    expect(button("Close")?.disabled).toBe(true);
    expect(button("Discard")?.disabled).toBe(true);
    type("changed");
    expect(button("Save")?.disabled).toBe(true);
    fireEvent.keyDown(field()!, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(field()!, { key: "Escape" });
    type("first");
    touch(document.body, "pointerdown");
    expect(actions.onSave).not.toHaveBeenCalled();
    expect(actions.onClose).not.toHaveBeenCalled();
    expect(form()).not.toBeNull();
  });

  it.each<["refused" | "failed", string]>([
    ["refused", "Claude already has that message"],
    ["failed", "Couldn't take it out of the queue"],
  ])("offers only Send as a new message and Discard once %s", (status, said) => {
    const { button, form, field, actions, container } = mount({
      edit: { text: "first", draft: "first, better ", status },
    });
    expect(form()?.textContent).toContain(said);
    const names = Array.from(container.querySelectorAll(".tl-ghost-edit button")).map(
      (b) => b.textContent,
    );
    expect(names).toEqual(["Discard", "Send as a new message"]);
    fireEvent.keyDown(field()!, { key: "Escape" });
    touch(document.body, "pointerdown");
    expect(actions.onClose).not.toHaveBeenCalled();
    fireEvent.click(button("Send as a new message")!);
    expect(actions.onSave).toHaveBeenCalledWith("first, better");
  });

  it("will not send an emptied draft as a new message", () => {
    const { button, type } = mount({
      edit: { text: "first", draft: "first, better", status: "refused" },
    });
    type("  ");
    expect(button("Send as a new message")?.disabled).toBe(true);
  });

  it("starts no swipe from inside the form", () => {
    const { field, ghosts } = mount({ edit: EDIT });
    touch(field()!, "pointerdown", 300);
    touch(field()!, "pointermove", 285);
    touch(field()!, "pointermove", 200);
    touch(field()!, "pointerup", 200);
    expect(ghosts().at(-1)!.style.transform).toBe("");
  });
});
