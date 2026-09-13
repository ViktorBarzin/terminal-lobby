import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import { DRAFTS_KEY, loadDraft, saveDraft } from "../src/store/drafts";
import type { DraftAttachment } from "../src/store/drafts";

/**
 * Attachments, inside the message.
 *
 * A file is a token in the text — `[img]`, `[file: report.pdf]` — standing
 * where the paste, the drop or the picker put it, and swapped for its absolute
 * path at send time. It replaced a tray above the field whose paths all went to
 * the FRONT of the message (Viktor, 2026-09-13), so what these tests pin is
 * WHERE the path comes out, and that deleting the chip takes the file with it.
 *
 * The upload itself is somebody else's job — `onAttach` is the seam.
 */

const IMG: DraftAttachment = {
  path: "/var/lib/clipboard-store/wizard/qa/pasted-20260817-150232-a1.png",
  name: "pasted-20260817-150232-a1.png",
  kind: "image",
};
const DOC: DraftAttachment = {
  path: "/var/lib/clipboard-store/wizard/qa/file-20260817-150232-c17e6008-report.pdf",
  name: "file-20260817-150232-c17e6008-report.pdf",
  kind: "doc",
};

interface Harness {
  onSend: ReturnType<typeof vi.fn>;
  onAttach: ReturnType<typeof vi.fn>;
}

function mount(over: Partial<Harness> = {}) {
  const onSend = over.onSend ?? vi.fn().mockResolvedValue(true);
  const onAttach = over.onAttach ?? vi.fn().mockResolvedValue([]);
  const r = render(() => (
    <Composer
      working={false}
      pending={[]}
      session="qa"
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
      onAttach={onAttach}
    />
  ));
  const field = r.container.querySelector("textarea")!;
  const send = () => fireEvent.click(r.getByText("Send"));
  return { ...r, onSend, onAttach, field, send };
}

const file = (name: string, type: string): File => new File(["bytes"], name, { type });

/** Pick a file through the composer's own input, as a person would. */
const pick = (container: HTMLElement, f: File) => {
  const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  fireEvent.change(input);
};

/** Put the caret somewhere, the way clicking into the field does. */
const caretTo = (field: HTMLTextAreaElement, at: number) => {
  field.setSelectionRange(at, at);
  fireEvent.click(field);
};

const chips = (container: HTMLElement) => container.querySelectorAll(".tl-inline-chip");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("attaching", () => {
  it("writes a token into the message and draws a chip behind it", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });

    pick(container, file("a.png", "image/png"));

    await waitFor(() => expect(field.value).toBe("[img]"));
    expect(onAttach).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    expect(chips(container)[0]!.textContent).toBe("[img]");
  });

  it("lands the chip at the caret, not at the front", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });
    fireEvent.input(field, { target: { value: "what is wrong here?" } });
    caretTo(field, 16); // "what is wrong he|re?" — inside the last word
    field.setSelectionRange(13, 13); // "what is wrong| here?"
    fireEvent.click(field);

    pick(container, file("a.png", "image/png"));

    await waitFor(() => expect(field.value).toBe("what is wrong [img] here?"));
  });

  // An untouched textarea reports selectionStart 0, which is indistinguishable
  // from a caret parked at the front — so "at the caret" used to mean "at the
  // front" for a message nobody had clicked into, which is the bug this whole
  // change is about.
  it("appends when nothing has put a caret in the field", async () => {
    saveDraft("qa", { text: "look at this", attachments: [], at: 1 });
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });
    await waitFor(() => expect(field.value).toBe("look at this"));

    pick(container, file("a.png", "image/png"));

    await waitFor(() => expect(field.value).toBe("look at this [img]"));
  });

  it("names a document in its token", async () => {
    const onAttach = vi.fn().mockResolvedValue([DOC]);
    const { container, field } = mount({ onAttach });
    pick(container, file("report.pdf", "application/pdf"));
    await waitFor(() => expect(field.value).toBe("[file: report.pdf]"));
    await waitFor(() => expect(chips(container)[0]!.getAttribute("data-kind")).toBe("doc"));
  });

  it("numbers a second unnamed image so the two tokens differ", async () => {
    const second = { ...IMG, path: IMG.path.replace("a1", "a2") };
    const onAttach = vi.fn().mockResolvedValueOnce([IMG]).mockResolvedValueOnce([second]);
    const { container, field } = mount({ onAttach });

    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toBe("[img]"));
    pick(container, file("b.png", "image/png"));

    await waitFor(() => expect(field.value).toBe("[img] [img 2]"));
  });

  it("keeps a token from fusing with the word beside it", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });
    fireEvent.input(field, { target: { value: "see" } });
    caretTo(field, 3);
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toBe("see [img]"));
  });
});

describe("removing", () => {
  it("drops the file when its token is edited out of the message", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field, send, onSend } = mount({ onAttach });
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(chips(container)).toHaveLength(1));

    fireEvent.input(field, { target: { value: "never mind" } });
    await waitFor(() => expect(chips(container)).toHaveLength(0));

    send();
    expect(onSend).toHaveBeenCalledWith("never mind", []);
  });

  it("takes the whole chip on one Backspace", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field, onSend, send } = mount({ onAttach });
    fireEvent.input(field, { target: { value: "look" } });
    caretTo(field, 4);
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toBe("look [img]"));

    field.setSelectionRange(10, 10);
    fireEvent.keyDown(field, { key: "Backspace" });

    await waitFor(() => expect(field.value).toBe("look"));
    expect(chips(container)).toHaveLength(0);
    send();
    expect(onSend).toHaveBeenCalledWith("look", []);
  });

  it("takes the whole chip on one Delete from in front of it", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toBe("[img]"));

    field.setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: "Delete" });

    await waitFor(() => expect(field.value).toBe(""));
    expect(chips(container)).toHaveLength(0);
  });

  it("leaves an ordinary Backspace alone", async () => {
    const { field } = mount();
    fireEvent.input(field, { target: { value: "look" } });
    field.setSelectionRange(4, 4);
    const e = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true, bubbles: true });
    field.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("sending", () => {
  it("puts each path where its token stood", async () => {
    const onAttach = vi.fn().mockResolvedValueOnce([IMG]).mockResolvedValueOnce([DOC]);
    const { container, field, send, onSend } = mount({ onAttach });

    fireEvent.input(field, { target: { value: "what's wrong here, vs the pdf?" } });
    caretTo(field, 18); // "what's wrong here,| vs the pdf?"
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toContain("[img]"));
    caretTo(field, field.value.length);
    pick(container, file("report.pdf", "application/pdf"));
    await waitFor(() => expect(field.value).toContain("[file: report.pdf]"));

    send();

    // The attachments ride along beside the composed message: the live composer
    // ignores them, having already swapped the paths in, and the new-session
    // composer is the one that needs the parts (PromptField.pendingAttachments).
    expect(onSend).toHaveBeenCalledWith(`what's wrong here, ${IMG.path} vs the pdf? ${DOC.path}`, [
      { ...IMG, token: "[img]" },
      { ...DOC, token: "[file: report.pdf]" },
    ]);
  });

  it("sends an attachment with no message at all", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, send, onSend } = mount({ onAttach });
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    send();
    expect(onSend).toHaveBeenCalledWith(IMG.path, [{ ...IMG, token: "[img]" }]);
  });

  it("sends nothing when the message is empty", () => {
    const { send, onSend } = mount();
    send();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the attachments once the send lands", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, send } = mount({ onAttach });
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    send();
    await waitFor(() => expect(chips(container)).toHaveLength(0));
    expect(loadDraft("qa")).toBeNull();
  });

  // A refusal must never destroy what was typed OR what was attached — the same
  // guarantee the text already had.
  it("puts the chips back when the session refuses the prompt", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field, send } = mount({ onSend, onAttach });
    fireEvent.input(field, { target: { value: "look" } });
    caretTo(field, 4);
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(field.value).toBe("look [img]"));

    send();

    await waitFor(() => expect(field.value).toBe("look [img]"));
    expect(chips(container)).toHaveLength(1);
  });
});

describe("persistence", () => {
  it("restores the text and its chips", async () => {
    saveDraft("qa", {
      text: "half written [img]",
      attachments: [{ ...IMG, token: "[img]" }],
      at: 1,
    });
    const { field, container, send, onSend } = mount();
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    expect(field.value).toBe("half written [img]");
    send();
    expect(onSend).toHaveBeenCalledWith(`half written ${IMG.path}`, [{ ...IMG, token: "[img]" }]);
  });

  // Written before attachments were anchored: the record has no token, so the
  // restore gives it one rather than dropping the file.
  it("anchors an attachment a pre-token draft left loose", async () => {
    saveDraft("qa", { text: "half written", attachments: [IMG], at: 1 });
    const { field, container } = mount();
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    expect(field.value).toBe("half written [img]");
  });

  it("saves the token with the text, so the next mount pairs them", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container } = mount({ onAttach });
    pick(container, file("a.png", "image/png"));
    await waitFor(() => expect(loadDraft("qa")?.attachments[0]?.token).toBe("[img]"));
    expect(loadDraft("qa")?.text).toBe("[img]");
  });

  it("keeps a corrupt store from breaking the composer", () => {
    localStorage.setItem(DRAFTS_KEY, "{not json");
    const { field } = mount();
    expect(field.value).toBe("");
  });
});

// --- the outside-in sinks (the Paste button, the ⌘V chord, the palette) -----
// Those all go through pasteIntoTerminal, which lands in the SESSION view, not
// in the composer. In text mode they have to reach the message being written
// rather than the pty, so the composer hands its two sinks out on mount.
describe("register", () => {
  const mountWithRegister = () => {
    let api: { add: (i: DraftAttachment[]) => void; insertText: (t: string) => void } | undefined;
    const onSend = vi.fn().mockResolvedValue(true);
    const r = render(() => (
      <Composer
        working={false}
        pending={[]}
        session="qa"
        onSend={onSend}
        onStop={() => {}}
        onResolve={() => {}}
        onAttach={vi.fn().mockResolvedValue([])}
        register={(a) => (api = a)}
      />
    ));
    return { ...r, api: () => api!, onSend, field: r.container.querySelector("textarea")! };
  };

  it("hands out both sinks on mount", () => {
    const { api } = mountWithRegister();
    expect(typeof api().add).toBe("function");
    expect(typeof api().insertText).toBe("function");
  });

  it("drops an attachment into the message from outside", async () => {
    const { api, container, field } = mountWithRegister();
    fireEvent.input(field, { target: { value: "have a look" } });
    caretTo(field, 11);
    api().add([IMG]);
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    expect(field.value).toBe("have a look [img]");
  });

  it("inserts pasted text at the caret rather than replacing the message", async () => {
    const { api, field } = mountWithRegister();
    fireEvent.input(field, { target: { value: "before after" } });
    caretTo(field, 7); // between "before " and "after"
    api().insertText("MIDDLE ");
    await waitFor(() => expect(field.value).toBe("before MIDDLE after"));
  });

  it("appends when the field has never been focused", async () => {
    const { api, field } = mountWithRegister();
    api().insertText("pasted");
    await waitFor(() => expect(field.value).toBe("pasted"));
  });

  it("sends what was inserted from outside", async () => {
    const { api, onSend, getByText } = mountWithRegister();
    api().insertText("from the palette");
    await waitFor(() => {});
    fireEvent.click(getByText("Send"));
    expect(onSend).toHaveBeenCalledWith("from the palette", []);
  });
});
