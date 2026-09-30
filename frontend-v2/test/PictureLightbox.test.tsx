import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PictureLightbox } from "../src/components/PictureLightbox";
import { Picture } from "../src/components/Attachment";
import { closePicture, openPicture, picture } from "../src/store/picture";
import { track } from "../src/telemetry/track";

vi.mock("../src/telemetry/track", () => ({ track: vi.fn() }));

/**
 * One lightbox for every picture in the Text view (2026-09-24): a picture in a
 * bubble, in Claude's prose or on a tool row opens the same `.tl-lightbox` the
 * gallery and the composer use. The rules it keeps are the composer's
 * (PromptField, 2026-09-16): opening puts a phone's keyboard away, because it
 * covers half the picture the press asked to see, and closing gives the field
 * back only when somebody was typing in it.
 */

afterEach(() => {
  closePicture();
  cleanup();
  document.body.innerHTML = "";
  vi.mocked(track).mockClear();
});

const PIC = { src: "/files/image?path=%2Ftmp%2Fa.png", alt: "a.png" };

describe("<PictureLightbox>", () => {
  it("draws nothing until a picture is opened", () => {
    const { container } = render(() => <PictureLightbox />);
    expect(container.querySelector(".tl-lightbox")).toBeNull();
  });

  it("shows the opened picture full size", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC, "prose", "file");
    const img = container.querySelector(".tl-lightbox img");
    expect(img?.getAttribute("src")).toBe(PIC.src);
    expect(img?.getAttribute("alt")).toBe("a.png");
  });

  // Android's Back left the lightbox up and moved the browser's history
  // instead (deployed reviews, 2026-09-28).
  it("closes on the phone's Back", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC, "bubble", "file");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(container.querySelector(".tl-lightbox")).toBeNull();
    expect(picture()).toBeNull();
  });

  it("closes on a press anywhere on it", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC, "tool", "block");
    fireEvent.click(container.querySelector(".tl-lightbox")!);
    expect(container.querySelector(".tl-lightbox")).toBeNull();
    expect(picture()).toBeNull();
  });

  it("closes on Escape, and the key goes no further", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC, "bubble", "file");
    // Registered after the lightbox's own listener, the way the composer's and
    // the terminal's handlers sit under it.
    const later = vi.fn();
    document.addEventListener("keydown", later);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", later);
    expect(container.querySelector(".tl-lightbox")).toBeNull();
    expect(later).not.toHaveBeenCalled();
  });

  it("leaves Escape alone while nothing is open", () => {
    render(() => <PictureLightbox />);
    const later = vi.fn();
    document.addEventListener("keydown", later);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("puts the keyboard away on open and gives the field back on close", () => {
    render(() => <PictureLightbox />);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    openPicture(PIC, "prose", "file");
    expect(document.activeElement).not.toBe(field);

    closePicture();
    expect(document.activeElement).toBe(field);
  });

  // A field nobody was typing in must not raise a keyboard over the screen the
  // person was reading when they closed the picture.
  it("focuses nothing on close when no field had the focus", () => {
    render(() => <PictureLightbox />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    openPicture(PIC, "prose", "file");
    closePicture();
    expect(document.activeElement).not.toBe(field);
  });

  it("says which kind of picture was opened, and from where, with no path", () => {
    render(() => <PictureLightbox />);
    openPicture(PIC, "tool", "block");
    expect(vi.mocked(track)).toHaveBeenCalledWith("text.picture_opened", {
      "tl.kind": "block",
      "tl.source": "tool",
    });
    const attrs = JSON.stringify(vi.mocked(track).mock.calls);
    expect(attrs).not.toContain("/tmp");
    expect(attrs).not.toContain("a.png");
  });
});

/**
 * Stepping through the conversation's pictures (Viktor, 2026-09-30): an arrow
 * on each side and the ← and → keys. The set is the pictures of the timeline the
 * press came from, in the order they are drawn, so the drill-in's timeline and
 * the session's never mix. It stops at either end rather than wrapping.
 */
describe("<PictureLightbox> stepping", () => {
  const set = [
    { src: "/p/1.png", alt: "one" },
    { src: "/p/2.png", alt: "two" },
    { src: "/p/3.png", alt: "three" },
  ];
  const shown = (root: HTMLElement): string | null =>
    root.querySelector(".tl-lightbox img")?.getAttribute("alt") ?? null;

  it("steps with the arrows, and a press on an arrow does not close it", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(set[1]!, "bubble", "file", { items: set, index: 1 });
    expect(container.querySelector(".tl-lightbox-chip")?.textContent).toBe("2/3");
    fireEvent.click(container.querySelector(".tl-lightbox-next")!);
    expect(shown(container)).toBe("three");
    expect(container.querySelector(".tl-lightbox-next")).toBeNull();
    fireEvent.click(container.querySelector(".tl-lightbox-prev")!);
    fireEvent.click(container.querySelector(".tl-lightbox-prev")!);
    expect(shown(container)).toBe("one");
    expect(container.querySelector(".tl-lightbox-prev")).toBeNull();
    expect(picture()).not.toBeNull();
  });

  it("steps with the arrow keys, which go no further while it is open", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(set[0]!, "prose", "file", { items: set, index: 0 });
    const later = vi.fn();
    document.addEventListener("keydown", later);
    fireEvent.keyDown(document.body, { key: "ArrowLeft" }); // the first: stays
    expect(shown(container)).toBe("one");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(shown(container)).toBe("three");
    document.removeEventListener("keydown", later);
    expect(later).not.toHaveBeenCalled();
  });

  // Alt+← is the browser's Back on Linux and Windows, Cmd+← on a Mac.
  it("leaves an arrow with a modifier to the browser", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(set[0]!, "prose", "file", { items: set, index: 0 });
    fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", metaKey: true });
    expect(shown(container)).toBe("one");
  });

  it("leaves the arrow keys alone while nothing is open", () => {
    render(() => <PictureLightbox />);
    const later = vi.fn();
    document.addEventListener("keydown", later);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    document.removeEventListener("keydown", later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("draws no arrows and no count for a picture on its own", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC, "bubble", "file");
    expect(container.querySelector(".tl-lightbox-prev, .tl-lightbox-next")).toBeNull();
    expect(container.querySelector(".tl-lightbox-chip")).toBeNull();
  });

  it("opens a picture in the conversation among the others in its timeline", () => {
    const { container } = render(() => (
      <>
        <div class="tl-timeline">
          <Picture src="/p/1.png" alt="one" size="full" source="bubble" kind="file" />
          <Picture src="/p/2.png" alt="two" size="thumb" source="tool" kind="block" />
          <Picture src="/p/3.png" alt="three" size="full" source="prose" kind="file" />
        </div>
        <div class="tl-timeline">
          <Picture src="/q/1.png" alt="elsewhere" size="full" source="bubble" kind="file" />
        </div>
        <PictureLightbox />
      </>
    ));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".tl-timeline button");
    fireEvent.click(buttons[1]!);
    expect(shown(container)).toBe("two");
    expect(container.querySelector(".tl-lightbox-chip")?.textContent).toBe("2/3");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(shown(container)).toBe("three");
    fireEvent.keyDown(document.body, { key: "ArrowRight" }); // not into the other timeline
    expect(shown(container)).toBe("three");
  });

  it("opens a picture outside any timeline on its own", () => {
    const { container } = render(() => (
      <>
        <Picture src="/p/1.png" alt="one" size="full" source="prose" kind="file" />
        <PictureLightbox />
      </>
    ));
    fireEvent.click(container.querySelector("button")!);
    expect(shown(container)).toBe("one");
    expect(container.querySelector(".tl-lightbox-next")).toBeNull();
  });
});
