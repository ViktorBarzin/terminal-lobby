import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { AttachmentView, MessageSegments } from "../src/components/Attachment";

/**
 * How an attachment is drawn in the chat
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decisions 2, 4, 13).
 * An image is a constrained preview, a document is a labelled chip, and both open
 * the file preview on click. A path nothing can serve falls back to its text,
 * which is what the view did before this feature and is the graceful half of
 * decision 7.
 */

afterEach(cleanup);

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

  it("opens the preview when clicked, so the full image is one tap away", () => {
    const onOpen = vi.fn();
    const { container } = render(() => (
      <AttachmentView path={IMG} name="a1.png" kind="image" me="wizard" onOpen={onOpen} />
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith(IMG);
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
    const other = "/var/lib/clipboard-store/emo/qa/pasted-20260817-150232-a1.png";
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
      <MessageSegments text={`look at ${IMG} closely`} me="wizard" />
    ));
    expect(container.querySelector("img")).not.toBeNull();
    expect(getByText(/look at/)).toBeTruthy();
    expect(getByText(/closely/)).toBeTruthy();
    expect(container.textContent).not.toContain(IMG);
  });

  it("leaves a message with no attachment exactly as it was", () => {
    const { container } = render(() => (
      <MessageSegments text={"edit /home/wizard/code/x/App.tsx please"} me="wizard" />
    ));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("edit /home/wizard/code/x/App.tsx please");
  });

  it("renders both an image and a document from one message", () => {
    const { container, getByText } = render(() => (
      <MessageSegments text={`${IMG}\n${DOC}\nwhat's wrong?`} me="wizard" />
    ));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(getByText("report.pdf")).toBeTruthy();
  });

  // The whole point of replacing in place: whitespace in the message is
  // significant, so the text runs have to survive verbatim.
  it("preserves the message's own line breaks", () => {
    const { container } = render(() => (
      <MessageSegments text={"one\n\ntwo"} me="wizard" />
    ));
    expect(container.textContent).toBe("one\n\ntwo");
  });
});
