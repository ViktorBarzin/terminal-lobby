import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { AttachmentView, MessageSegments, Picture } from "../src/components/Attachment";
import { segmentMessage, segmentPrompt } from "../src/lib/attachments";
import { closePicture, picture } from "../src/store/picture";
import { track } from "../src/telemetry/track";

vi.mock("../src/telemetry/track", () => ({ track: vi.fn() }));

/**
 * How an attachment is drawn in the chat
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decisions 2, 4, 13,
 * revised 2026-09-24). An image is a constrained preview that opens the shared
 * lightbox, and a document is a labelled chip that opens the file preview. A
 * path nothing can serve falls back to its text, which is what the view did
 * before this feature and is the graceful half of decision 7.
 */

afterEach(() => {
  closePicture();
  cleanup();
  vi.mocked(track).mockClear();
});

const IMG = "/var/lib/clipboard-store/wizard/qa/pasted-20260817-150232-a1.png";
const DOC = "/var/lib/clipboard-store/wizard/qa/file-20260817-150232-c17e6008-report.pdf";

describe("AttachmentView — image", () => {
  it("renders a lazily-loaded preview pointing at the clipboard image route", () => {
    const { container } = render(() => (
      <AttachmentView path={IMG} name="pasted-20260817-150232-a1.png" kind="image" me="wizard" />
    ));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/clipboard/img/qa/pasted-20260817-150232-a1.png");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  // Decision 4, revised 2026-09-24: a picture opens the lightbox every other
  // picture in the view opens, not the file preview. The preview is for reading
  // a file; a picture is for looking at, and the lightbox is one tap to close.
  it("opens the lightbox when clicked, so the full image is one tap away", () => {
    const onOpen = vi.fn();
    const { container } = render(() => (
      <AttachmentView path={IMG} name="a1.png" kind="image" me="wizard" onOpen={onOpen} />
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(picture()?.src).toBe("/clipboard/img/qa/pasted-20260817-150232-a1.png");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("draws a picture outside the store through the picture route", () => {
    const { container } = render(() => (
      <AttachmentView path="/tmp/shot.png" name="shot.png" kind="image" me="wizard" />
    ));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/files/image?path=%2Ftmp%2Fshot.png",
    );
  });

  // Chromium cannot decode HEIF, which clipboard-upload deliberately accepts, so
  // a stored image that will not render is a real state rather than a bug.
  it("falls back to the path when the image cannot be decoded", async () => {
    const { container, findByText } = render(() => (
      <AttachmentView path={IMG} name="a1.png" kind="image" me="wizard" />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText(IMG)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("AttachmentView — document", () => {
  it("labels the chip with the name the user chose, not the stored name", () => {
    const { getByText } = render(() => (
      <AttachmentView
        path={DOC}
        name="file-20260817-150232-c17e6008-report.pdf"
        kind="doc"
        me="wizard"
      />
    ));
    expect(getByText("report.pdf")).toBeTruthy();
  });

  it("opens the preview when clicked", () => {
    const onOpen = vi.fn();
    const { container } = render(() => (
      <AttachmentView path={DOC} name="report.pdf" kind="doc" me="wizard" onOpen={onOpen} />
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith(DOC);
  });
});

describe("AttachmentView — nothing to serve", () => {
  // Decision 12: a guest on a shared session sees the path, because the clipboard
  // routes only ever resolve inside the caller's own store.
  it("shows the path for another user's store file", () => {
    const other = "/var/lib/clipboard-store/bob/qa/pasted-20260817-150232-a1.png";
    const { getByText, container } = render(() => (
      <AttachmentView path={other} name="a1.png" kind="image" me="wizard" />
    ));
    expect(getByText(other)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("MessageSegments", () => {
  it("replaces a path in place and keeps the prose around it", () => {
    const { container, getByText } = render(() => (
      <MessageSegments segments={segmentMessage(`look at ${IMG} closely`)} me="wizard" />
    ));
    expect(container.querySelector("img")).not.toBeNull();
    expect(getByText(/look at/)).toBeTruthy();
    expect(getByText(/closely/)).toBeTruthy();
    expect(container.textContent).not.toContain(IMG);
  });

  it("leaves a message with no attachment exactly as it was", () => {
    const { container } = render(() => (
      <MessageSegments
        segments={segmentMessage("edit /home/wizard/code/x/App.tsx please")}
        me="wizard"
      />
    ));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("edit /home/wizard/code/x/App.tsx please");
  });

  it("renders both an image and a document from one message", () => {
    const { container, getByText } = render(() => (
      <MessageSegments segments={segmentMessage(`${IMG}\n${DOC}\nwhat's wrong?`)} me="wizard" />
    ));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(getByText("report.pdf")).toBeTruthy();
  });

  // The whole point of replacing in place: whitespace in the message is
  // significant, so the text runs have to survive verbatim.
  it("preserves the message's own line breaks", () => {
    const { container } = render(() => (
      <MessageSegments segments={segmentMessage("one\n\ntwo")} me="wizard" />
    ));
    expect(container.textContent).toBe("one\n\ntwo");
  });

  // A picture pasted into the terminal lives only in the transcript, as an
  // image block beside the `[Image #1]` Claude Code writes where it went.
  const RECORD = "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169";
  const PASTE = { n: 0, mediaType: "image/png", bytes: 73251, paste: 1 };

  it("draws a terminal paste where its placeholder stood", () => {
    const segs = segmentPrompt("[Image #1]\n\nwhat is wrong?", [PASTE]);
    const { container } = render(() => (
      <MessageSegments segments={segs} me="wizard" session="s" record={RECORD} />
    ));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`/result/s/user/${RECORD}/image/0`);
    expect(img?.getAttribute("alt")).toBe("Pasted image 1");
    expect(container.textContent).not.toContain("[Image #1]");
    expect(container.textContent).toContain("what is wrong?");
  });

  it("opens a terminal paste in the lightbox as a block", () => {
    const segs = segmentPrompt("[Image #1]", [PASTE]);
    const { container } = render(() => (
      <MessageSegments segments={segs} me="wizard" session="s" record={RECORD} />
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(picture()?.src).toBe(`/result/s/user/${RECORD}/image/0`);
    expect(vi.mocked(track)).toHaveBeenCalledWith("text.picture_opened", {
      "tl.kind": "block",
      "tl.source": "bubble",
    });
  });

  // A picture is drawn as a block, which ends its line by itself, so the
  // newline that ended the placeholder's line in the text would add a blank
  // line the message never had. It belongs to the placeholder: it goes while
  // the picture shows and comes back with the text when the picture cannot.
  it("does not add a blank line under a picture drawn as a block", () => {
    const segs = segmentPrompt("[Image #1]\n\nwhat is wrong?", [PASTE]);
    const { container } = render(() => (
      <MessageSegments segments={segs} me="wizard" session="s" record={RECORD} />
    ));
    expect(container.textContent).toBe("\nwhat is wrong?");
    fireEvent.error(container.querySelector("img")!);
    expect(container.textContent).toBe("[Image #1]\n\nwhat is wrong?");
  });

  // Claude Code puts a picture's placeholder at the front of the prompt, and
  // the space after it began the bubble's words (deployed review round 5).
  it("does not start the words after a picture with a stray space", () => {
    const segs = segmentPrompt("[Image #1] Name this colour.", [PASTE]);
    const { container } = render(() => (
      <MessageSegments segments={segs} me="wizard" session="s" record={RECORD} />
    ));
    expect(container.textContent).toBe("Name this colour.");
    fireEvent.error(container.querySelector("img")!);
    expect(container.textContent).toBe("[Image #1] Name this colour.");
  });

  it("gives a stored picture's line break back when it falls back to its path", () => {
    const { container } = render(() => (
      <MessageSegments segments={segmentMessage(`look\n${IMG}\nnext`)} me="wizard" />
    ));
    expect(container.textContent).toBe("look\nnext");
    fireEvent.error(container.querySelector("img")!);
    expect(container.textContent).toBe(`look\n${IMG}\nnext`);
  });

  it("keeps the placeholder text when it has no session or record to read from", () => {
    const segs = segmentPrompt("[Image #1] hi", [PASTE]);
    const { container } = render(() => <MessageSegments segments={segs} me="wizard" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("[Image #1] hi");
  });

  it("falls back to the placeholder text when the picture cannot be read", async () => {
    const segs = segmentPrompt("[Image #1] hi", [PASTE]);
    const { container, findByText } = render(() => (
      <MessageSegments segments={segs} me="wizard" session="s" record={RECORD} />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText("[Image #1]")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("Picture", () => {
  const SRC = "/files/image?path=%2Ftmp%2Fa.png";

  it("is a button around a lazily loaded image, named for what it opens", () => {
    const { container } = render(() => (
      <Picture src={SRC} alt="a.png" size="full" source="prose" kind="file" />
    ));
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.classList.contains("tl-attach-image")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Open a.png");
    const img = btn.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(SRC);
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("is a thumbnail at the tool-row size", () => {
    const { container } = render(() => (
      <Picture src={SRC} alt="a.png" size="thumb" source="tool" kind="file" />
    ));
    expect(container.querySelector("button")!.classList.contains("tl-tool-thumb")).toBe(true);
  });

  it("opens the lightbox on the same picture, and reports where from", () => {
    const { container } = render(() => (
      <Picture src={SRC} alt="a.png" size="thumb" source="tool" kind="file" />
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(picture()).toEqual({ src: SRC, alt: "a.png" });
    expect(vi.mocked(track)).toHaveBeenCalledWith("text.picture_opened", {
      "tl.kind": "file",
      "tl.source": "tool",
    });
  });

  // The press must not take the focus from the composer on its way: opening
  // the picture is what puts the keyboard away, and it has to see the field
  // that had it in order to give it back.
  it("keeps the focus where it was when pressed", () => {
    const { container } = render(() => (
      <Picture src={SRC} alt="a.png" size="full" source="prose" kind="file" />
    ));
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    container.querySelector("button")!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("draws nothing once the image fails, unless given a fallback", () => {
    const { container } = render(() => (
      <Picture src={SRC} alt="a.png" size="full" source="prose" kind="file" />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("draws the fallback once the image fails", async () => {
    const { container, findByText } = render(() => (
      <Picture
        src={SRC}
        alt="a.png"
        size="full"
        source="prose"
        kind="file"
        fallback={<span class="tl-attach-path">/tmp/a.png</span>}
      />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText("/tmp/a.png")).toBeTruthy();
  });
});
