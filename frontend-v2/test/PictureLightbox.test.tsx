import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PictureLightbox } from "../src/components/PictureLightbox";
import { closePicture, openPicture, picture } from "../src/store/picture";

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
});

const PIC = { src: "/files/image?path=%2Ftmp%2Fa.png", alt: "a.png" };

describe("<PictureLightbox>", () => {
  it("draws nothing until a picture is opened", () => {
    const { container } = render(() => <PictureLightbox />);
    expect(container.querySelector(".tl-lightbox")).toBeNull();
  });

  it("shows the opened picture full size", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC);
    const img = container.querySelector(".tl-lightbox img");
    expect(img?.getAttribute("src")).toBe(PIC.src);
    expect(img?.getAttribute("alt")).toBe("a.png");
  });

  it("closes on a press anywhere on it", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC);
    fireEvent.click(container.querySelector(".tl-lightbox")!);
    expect(container.querySelector(".tl-lightbox")).toBeNull();
    expect(picture()).toBeNull();
  });

  it("closes on Escape, and the key goes no further", () => {
    const { container } = render(() => <PictureLightbox />);
    openPicture(PIC);
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

    openPicture(PIC);
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
    openPicture(PIC);
    closePicture();
    expect(document.activeElement).not.toBe(field);
  });
});
