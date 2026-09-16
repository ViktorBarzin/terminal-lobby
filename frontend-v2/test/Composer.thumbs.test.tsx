import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import type { DraftAttachment } from "../src/store/drafts";

/**
 * An attached image is drawn as the image, inside the message.
 *
 * The chip used to be the token's own text on a coloured pill — `[img]` — which
 * says a picture is attached without saying WHICH picture, and on the
 * new-session screen that is the only thing about the paste the writer can see
 * at all (Viktor, 2026-09-16: "i see just [img], let's replace that with a
 * proper thumbnail of the image instead").
 *
 * The mechanism these tests pin: the picture is painted over the token's own
 * characters, in the mirror layer, so the token has to be WIDE enough to hide
 * behind it (`attachToken`'s pad) and the field has to say when a picture is in
 * it (`data-thumbs`) so the line can grow to a height a picture fits in.
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

function mount(attach: DraftAttachment[]) {
  const onAttach = vi.fn().mockResolvedValue(attach);
  const r = render(() => (
    <Composer
      working={false}
      pending={[]}
      session="qa"
      onSend={vi.fn().mockResolvedValue(true)}
      onStop={() => {}}
      onResolve={() => {}}
      onAttach={onAttach}
    />
  ));
  const input = r.container.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", {
    value: [new File(["bytes"], "a.png", { type: "image/png" })],
    configurable: true,
  });
  fireEvent.change(input);
  return r;
}

const thumbs = (c: HTMLElement) => c.querySelectorAll<HTMLImageElement>(".tl-inline-thumb");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("the image in the chip", () => {
  it("draws the picture itself, read back from the store", async () => {
    const { container } = mount([IMG]);
    await waitFor(() => expect(thumbs(container)).toHaveLength(1));
    // The one resolver in lib/attachments decides which backend serves it, so
    // this pins the route rather than a hand-built URL.
    expect(thumbs(container)[0]!.getAttribute("src")).toBe(
      "/clipboard/img/qa/pasted-20260817-150232-a1.png",
    );
  });

  it("prefers a preview the composer already holds, for a file not uploaded yet", async () => {
    // The new-session composer holds Files in memory — there is no session to
    // upload into until Enter — so its "path" names nothing a server can serve.
    const { container } = mount([{ ...IMG, preview: "blob:held-1" }]);
    await waitFor(() => expect(thumbs(container)).toHaveLength(1));
    expect(thumbs(container)[0]!.getAttribute("src")).toBe("blob:held-1");
  });

  it("leaves a document as the pill it was", async () => {
    const { container } = mount([DOC]);
    await waitFor(() => expect(container.querySelectorAll(".tl-inline-chip")).toHaveLength(1));
    expect(thumbs(container)).toHaveLength(0);
  });

  it("falls back to the token's text when the picture cannot be read", async () => {
    const { container } = mount([IMG]);
    await waitFor(() => expect(thumbs(container)).toHaveLength(1));
    fireEvent.error(thumbs(container)[0]!);
    await waitFor(() => expect(thumbs(container)).toHaveLength(0));
    // The chip is still there, still saying what it stands for.
    expect(container.querySelector(".tl-inline-chip")!.textContent).toBe("[img]");
  });
});

describe("room for the picture", () => {
  it("marks the field while an image is in the message, and unmarks it after", async () => {
    const { container } = mount([IMG]);
    const field = () => container.querySelector(".tl-field")!;
    await waitFor(() => expect(field().getAttribute("data-thumbs")).toBe("on"));

    const ta = container.querySelector("textarea")!;
    fireEvent.input(ta, { target: { value: "never mind" } });
    await waitFor(() => expect(field().getAttribute("data-thumbs")).toBe(null));
  });

  it("does not grow the line for a document", async () => {
    const { container } = mount([DOC]);
    await waitFor(() => expect(container.querySelectorAll(".tl-inline-chip")).toHaveLength(1));
    expect(container.querySelector(".tl-field")!.getAttribute("data-thumbs")).toBe(null);
  });
});

/**
 * The thumbnail opens the picture.
 *
 * 80x44 is enough to recognise a screenshot and nowhere near enough to read
 * one, so the chip is a way IN to the image rather than a view of it (Viktor,
 * 2026-09-16: "let's make it clickable, so when the user clicks it, they can
 * see the entire image in full screen"). It opens the same `.tl-lightbox`
 * overlay the gallery uses, on the same URL the chip is already drawn from,
 * which is what lets a held file, uploaded nowhere yet, open at all.
 */
describe("opening the picture", () => {
  const open = async (c: HTMLElement) => {
    await waitFor(() => expect(c.querySelector(".tl-inline-zoom")).not.toBeNull());
    fireEvent.click(c.querySelector(".tl-inline-zoom")!);
    await waitFor(() => expect(c.querySelector(".tl-lightbox")).not.toBeNull());
  };

  it("shows the whole image, from the URL the chip was drawn from", async () => {
    const { container } = mount([{ ...IMG, preview: "blob:held-1" }]);
    await open(container);
    const full = container.querySelector<HTMLImageElement>(".tl-lightbox img")!;
    expect(full.getAttribute("src")).toBe("blob:held-1");
  });

  it("closes on Escape", async () => {
    const { container } = mount([IMG]);
    await open(container);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".tl-lightbox")).toBeNull());
  });

  it("closes when the overlay is pressed", async () => {
    const { container } = mount([IMG]);
    await open(container);
    fireEvent.click(container.querySelector(".tl-lightbox")!);
    await waitFor(() => expect(container.querySelector(".tl-lightbox")).toBeNull());
  });

  it("leaves the caret where it was", async () => {
    // The button sits ON TOP of the field, so a press that ran its default
    // would move the caret into the token it covers and take the focus with
    // it. Opening a picture is not an edit.
    const { container } = mount([IMG]);
    await waitFor(() => expect(container.querySelector(".tl-inline-zoom")).not.toBeNull());
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    container.querySelector(".tl-inline-zoom")!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("puts the keyboard away while the picture is up, and gives it back after", async () => {
    // On a phone the field's keyboard covers half the screen, which is half of
    // the picture the press asked to see. Measured on the emulator on
    // 2026-09-16: the tap opened the image behind a keyboard that was still up.
    const { container } = mount([IMG]);
    const ta = container.querySelector("textarea")!;
    ta.focus();
    expect(document.activeElement).toBe(ta);

    await open(container);
    expect(document.activeElement).not.toBe(ta);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(ta));
  });

  it("leaves the focus alone when it was not the field's", async () => {
    // Opening a picture from a field nobody was typing in must not raise a
    // keyboard on the way out of it.
    const { container } = mount([IMG]);
    const ta = container.querySelector("textarea")!;
    // After the attach, not before: writing a token into the message puts the
    // caret back in the field, so a blur before that lands is undone.
    await waitFor(() => expect(container.querySelector(".tl-inline-zoom")).not.toBeNull());
    ta.blur();

    await open(container);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".tl-lightbox")).toBeNull());
    expect(document.activeElement).not.toBe(ta);
  });

  it("gives a document chip nothing to open", async () => {
    const { container } = mount([DOC]);
    await waitFor(() => expect(container.querySelectorAll(".tl-inline-chip")).toHaveLength(1));
    expect(container.querySelector(".tl-inline-zoom")).toBeNull();
  });
});
