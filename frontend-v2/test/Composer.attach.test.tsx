import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import { DRAFTS_KEY, loadDraft, saveDraft } from "../src/store/drafts";
import type { DraftAttachment } from "../src/store/drafts";

/**
 * The attachment tray
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decisions 1, 6, 9, 10).
 *
 * The composer is where this feature is actually used: attach, see it, remove it,
 * send it, and find it still there after a reload. The upload itself is somebody
 * else's job — `onAttach` is the seam — so these tests are about what the tray
 * shows and what Send puts on the wire.
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
      me="wizard"
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

const file = (name: string, type: string): File =>
  new File(["bytes"], name, { type });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("attaching", () => {
  it("uploads a picked file and shows it as a chip", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container } = mount({ onAttach });

    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", { value: [file("a.png", "image/png")] });
    fireEvent.change(input);

    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".tl-tray-item img")).not.toBeNull();
  });

  // The tray is the whole point of decision 1: the field stays prose.
  it("leaves the typed message untouched when a file is attached", async () => {
    const onAttach = vi.fn().mockResolvedValue([IMG]);
    const { container, field } = mount({ onAttach });
    fireEvent.input(field, { target: { value: "what's wrong here?" } });

    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", { value: [file("a.png", "image/png")] });
    fireEvent.change(input);

    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    expect(field.value).toBe("what's wrong here?");
    expect(field.value).not.toContain("/var/lib");
  });

  it("labels a document chip with the name the user chose", async () => {
    const onAttach = vi.fn().mockResolvedValue([DOC]);
    const { container, findByText } = mount({ onAttach });
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", { value: [file("report.pdf", "application/pdf")] });
    fireEvent.change(input);
    expect(await findByText("report.pdf")).toBeTruthy();
  });

  it("removes a chip when its × is pressed", async () => {
    saveDraft("qa", { text: "", attachments: [IMG], at: 1 });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    fireEvent.click(container.querySelector<HTMLElement>(".tl-tray-remove")!);
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).toBeNull());
  });
});

describe("sending", () => {
  it("puts the paths first, one per line, then the prose", async () => {
    saveDraft("qa", { text: "", attachments: [IMG, DOC], at: 1 });
    const { field, send, onSend, container } = mount();
    await waitFor(() => expect(container.querySelectorAll(".tl-tray-item")).toHaveLength(2));

    fireEvent.input(field, { target: { value: "what's wrong, vs the pdf?" } });
    send();

    expect(onSend).toHaveBeenCalledWith(
      `${IMG.path}\n${DOC.path}\nwhat's wrong, vs the pdf?`,
    );
  });

  it("sends attachments with no message at all", async () => {
    saveDraft("qa", { text: "", attachments: [IMG], at: 1 });
    const { send, onSend, container } = mount();
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    send();
    expect(onSend).toHaveBeenCalledWith(IMG.path);
  });

  it("sends nothing when both the field and the tray are empty", () => {
    const { send, onSend } = mount();
    send();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the tray once the send lands", async () => {
    saveDraft("qa", { text: "", attachments: [IMG], at: 1 });
    const { send, container } = mount();
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    send();
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).toBeNull());
    expect(loadDraft("qa")).toBeNull();
  });

  // A refusal must never destroy what was typed OR what was attached — the same
  // guarantee the text already had.
  it("puts the tray back when the session refuses the prompt", async () => {
    saveDraft("qa", { text: "", attachments: [IMG], at: 1 });
    const onSend = vi.fn().mockResolvedValue(false);
    const { send, field, container } = mount({ onSend });
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());

    fireEvent.input(field, { target: { value: "look" } });
    send();

    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    expect(field.value).toBe("look");
  });
});

describe("persistence", () => {
  it("restores the text and the tray a reload left behind", async () => {
    saveDraft("qa", { text: "half written", attachments: [IMG], at: 1 });
    const { field, container } = mount();
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
    expect(field.value).toBe("half written");
  });

  it("saves what is typed, so the next mount finds it", async () => {
    const { field } = mount();
    fireEvent.input(field, { target: { value: "typed but not sent" } });
    await waitFor(() => expect(loadDraft("qa")?.text).toBe("typed but not sent"));
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
        me="wizard"
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

  it("adds an attachment to the tray from outside", async () => {
    const { api, container } = mountWithRegister();
    api().add([IMG]);
    await waitFor(() => expect(container.querySelector(".tl-tray-item")).not.toBeNull());
  });

  it("inserts pasted text at the caret rather than replacing the message", async () => {
    const { api, field } = mountWithRegister();
    fireEvent.input(field, { target: { value: "before after" } });
    field.setSelectionRange(7, 7); // between "before " and "after"
    fireEvent.click(field);
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
    expect(onSend).toHaveBeenCalledWith("from the palette");
  });
});
