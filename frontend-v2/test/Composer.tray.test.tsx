/**
 * What the pill's `+` opens: a file, a photo, a `/` command, an `@` path.
 *
 * The Attach button carried a word on the bar under the field, and `/` and `@`
 * had no button at all; they opened for a reader who already knew to type the
 * trigger. The Quiet line composer (2026-09-24) put all four behind one `+`,
 * with the words on the rows it opens.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
  render(() => (
    <Composer
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onAttach={async () => []}
      onListDir={async () => ["src/", "README.md"]}
      {...props}
    />
  ));

const plus = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-plus")!;
const row = (c: HTMLElement, words: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-tray-item")).find((b) =>
    (b.textContent ?? "").includes(words),
  )!;
const field = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>("textarea")!;

describe("the + tray", () => {
  it("lists the four intakes and says where images go", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    const tray = container.querySelector(".tl-tray")!;
    expect(tray.getAttribute("role")).toBe("menu");
    expect(plus(container).getAttribute("aria-expanded")).toBe("true");
    expect(tray.querySelectorAll(".tl-tray-item")).toHaveLength(4);
    expect(tray.querySelector(".tl-tray-note")?.textContent).toBe(
      "Images join this session's gallery",
    );
  });

  it("opens the any-file picker from Attach a file", () => {
    const { container } = mount();
    const [any] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    expect(any!.hasAttribute("accept")).toBe(false);
    const click = vi.spyOn(any!, "click").mockImplementation(() => {});
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Attach a file"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".tl-tray"), "the tray closes on a pick").toBeNull();
  });

  // Without `capture`, iOS offers the photo library and the camera both,
  // rather than jumping straight to the camera.
  it("opens an image picker with no capture from Add a photo", () => {
    const { container } = mount();
    const photo = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/*"]',
    )!;
    expect(photo.hasAttribute("capture")).toBe(false);
    const click = vi.spyOn(photo, "click").mockImplementation(() => {});
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Add a photo"));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("puts a / at the start of an empty message and opens the command menu", async () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Commands and skills"));
    expect(field(container).value).toBe("/");
    await waitFor(() => expect(container.querySelector(".tl-complete")).not.toBeNull());
  });

  it("puts an @ at the caret with a space before it, and opens the path menu", async () => {
    const { container } = mount();
    fireEvent.input(field(container), { target: { value: "look at" } });
    field(container).setSelectionRange(7, 7);
    fireEvent.click(field(container));
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "A file path"));
    expect(field(container).value).toBe("look at @");
    await waitFor(() =>
      expect(container.querySelector(".tl-complete")?.textContent).toContain("@README.md"),
    );
  });

  it("offers no path row where there is no filesystem to list", () => {
    const { container } = render(() => (
      <Composer
        pending={[]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        onAttach={async () => []}
      />
    ));
    fireEvent.click(plus(container));
    expect(row(container, "A file path")).toBeUndefined();
    expect(row(container, "Commands and skills")).toBeDefined();
  });

  it("closes on Escape and hands the focus back to the +", () => {
    const { container } = mount();
    plus(container).focus();
    fireEvent.click(plus(container), { detail: 0 });
    const first = container.querySelector<HTMLButtonElement>(".tl-tray-item")!;
    expect(document.activeElement, "the keyboard lands on the first row").toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(container, "Add a photo"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(container.querySelector(".tl-tray")).toBeNull();
    expect(document.activeElement).toBe(plus(container));
  });

  it("closes when the reader starts typing instead", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.input(field(container), { target: { value: "n" } });
    expect(container.querySelector(".tl-tray")).toBeNull();
  });

  it("closes on a press anywhere else", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.pointerDown(document.body);
    expect(container.querySelector(".tl-tray")).toBeNull();
  });
});
