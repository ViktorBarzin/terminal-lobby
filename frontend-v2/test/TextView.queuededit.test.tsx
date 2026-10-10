/**
 * The form for a queued message taken out to edit (QueuedGhost, Viktor
 * 2026-10-10) sends through the composer's own send path, so the server holds
 * the words if the turn still runs and Claude gets them now if it has ended.
 *
 * Save sends the new words, Close sends the old ones back to the end of the
 * queue, Discard sends nothing. The edit ends only once the send went in; a
 * refused send leaves the form up with what was typed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { OpenQueuedEdit } from "../src/store/drafts";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });
const RUNNING: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card" }),
  ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"a.ts"}' }),
];

function mount(onSend: (text: string) => Promise<boolean> = vi.fn(async () => true)) {
  const [edit, setEdit] = createSignal<OpenQueuedEdit | null>({
    text: "first",
    draft: "first",
    status: "ready",
  });
  const onEnd = vi.fn(() => setEdit(null));
  const onDraft = vi.fn();
  const r = render(() => (
    <TextView
      events={RUNNING}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
      queuedEdit={edit}
      onQueuedEditDraft={onDraft}
      onQueuedEditEnd={onEnd}
    />
  ));
  const field = () => r.container.querySelector<HTMLTextAreaElement>(".tl-ghost-edit textarea");
  const button = (name: string) =>
    Array.from(r.container.querySelectorAll<HTMLButtonElement>(".tl-ghost-edit button")).find(
      (b) => b.textContent === name,
    )!;
  return { ...r, onSend, onEnd, onDraft, field, button, setEdit };
}

describe("a queued message's edit form in the Text view", () => {
  it("sends the new words on Save and ends the edit", async () => {
    const { field, button, onSend, onEnd, onDraft } = mount();
    fireEvent.input(field()!, { target: { value: "first, but better" } });
    expect(onDraft).toHaveBeenLastCalledWith("first, but better");
    fireEvent.click(button("Save"));
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("first, but better");
    expect(field()).toBeNull();
  });

  it("sends the old words back on Close", async () => {
    const { field, button, onSend, onEnd } = mount();
    fireEvent.input(field()!, { target: { value: "half typed" } });
    fireEvent.click(button("Close"));
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("first");
  });

  it("sends nothing on Discard", () => {
    const { button, onSend, onEnd } = mount();
    fireEvent.click(button("Discard"));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends the draft as a new message once Claude already had the old one", async () => {
    const { button, setEdit, onSend, onEnd } = mount();
    setEdit({ text: "first", draft: "first, better", status: "refused" });
    fireEvent.click(button("Send as a new message"));
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("first, better");
  });

  it("keeps the form and the edit when the send is refused", async () => {
    const onSend = vi.fn(async () => false);
    const { field, button, onEnd } = mount(onSend);
    fireEvent.input(field()!, { target: { value: "changed" } });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("changed"));
    expect(onEnd).not.toHaveBeenCalled();
    expect(field()?.value).toBe("changed");
  });
});
