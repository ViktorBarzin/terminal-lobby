/**
 * What the composer's `+` opens: the + menu.
 *
 * The Attach button carried a word on the bar under the field, and `/` and `@`
 * had no button at all; they opened for a reader who already knew to type the
 * trigger. The Quiet line composer (2026-09-24) put four intakes behind one
 * `+`: a file, a photo, a `/` command, an `@` path, with a footer saying where
 * files end up.
 *
 * The T3 pass (2026-09-27, prototype 6-plus) rewrote these on purpose. The
 * menu is Photo library, Camera, File, a rule, then Commands with a `/`
 * keycap. `@` is typed only, and the footer went: where an image goes is in
 * the `+`'s title (Composer.attachlabel.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const menu = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-plus-menu");
const items = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-plus-item"));
const row = (c: HTMLElement, words: string) =>
  items(c).find((b) => (b.textContent ?? "").includes(words))!;
const field = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>("textarea")!;
const inputs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLInputElement>('input[type="file"]'));

describe("the + menu", () => {
  it("lists Photo library, Camera, File, a rule, then Commands", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    const m = menu(container)!;
    expect(m.getAttribute("role")).toBe("menu");
    expect(plus(container).getAttribute("aria-expanded")).toBe("true");
    const kids = Array.from(m.children).map((el) =>
      el.getAttribute("role") === "separator" ? "---" : (el.textContent ?? "").trim(),
    );
    expect(kids).toEqual(["Photo library", "Camera", "File", "---", "Commands/"]);
    expect(row(container, "Commands").querySelector("kbd")?.textContent).toBe("/");
  });

  it("has no @ row and no footer note, though a filesystem is there to list", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    expect(items(container).some((b) => (b.textContent ?? "").includes("@"))).toBe(false);
    expect(items(container).some((b) => /path/i.test(b.textContent ?? ""))).toBe(false);
    expect(menu(container)!.querySelector("[role=note], .tl-plus-note")).toBeNull();
  });

  it("still opens the path menu for an @ typed into the field", async () => {
    const { container } = mount();
    fireEvent.input(field(container), { target: { value: "look at @" } });
    field(container).setSelectionRange(9, 9);
    fireEvent.click(field(container));
    await waitFor(() =>
      expect(container.querySelector(".tl-complete")?.textContent).toContain("@README.md"),
    );
  });

  it("opens the any-file picker, several at once, from File", () => {
    const { container } = mount();
    const [any] = inputs(container);
    expect(any!.hasAttribute("accept")).toBe(false);
    expect(any!.multiple).toBe(true);
    const click = vi.spyOn(any!, "click").mockImplementation(() => {});
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "File"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(menu(container), "the menu closes on a pick").toBeNull();
  });

  // Without `capture`, iOS offers its own sheet (Photo Library, Take Photo,
  // Choose File) rather than jumping straight to the camera.
  it("opens an image picker with no capture from Photo library", () => {
    const { container } = mount();
    const photo = inputs(container).find(
      (i) => i.accept === "image/*" && !i.hasAttribute("capture"),
    )!;
    expect(photo).toBeDefined();
    const click = vi.spyOn(photo, "click").mockImplementation(() => {});
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Photo library"));
    expect(click).toHaveBeenCalledTimes(1);
  });

  // `capture=environment` is what makes a phone open its back camera directly.
  it("opens the back camera from Camera", () => {
    const { container } = mount();
    const camera = inputs(container).find((i) => i.getAttribute("capture") === "environment")!;
    expect(camera).toBeDefined();
    expect(camera.accept).toBe("image/*");
    const click = vi.spyOn(camera, "click").mockImplementation(() => {});
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Camera"));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("keeps the three pickers mounted while the menu comes and goes", () => {
    const { container } = mount();
    const before = inputs(container);
    expect(before).toHaveLength(3);
    fireEvent.click(plus(container));
    fireEvent.click(plus(container));
    expect(menu(container)).toBeNull();
    expect(inputs(container)).toEqual(before);
  });

  it("delivers each picker's files, and the same file picked twice both times", async () => {
    const onAttach = vi.fn(async () => []);
    const { container } = mount({ onAttach });
    const f = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    for (const input of [...inputs(container), inputs(container)[0]!]) {
      Object.defineProperty(input, "files", { value: [f], configurable: true });
      fireEvent.change(input);
      // Cleared after every pick, or the browser fires no change for a repeat.
      expect(input.value).toBe("");
    }
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(4));
    for (const call of onAttach.mock.calls as unknown as File[][][]) expect(call[0]).toEqual([f]);
  });

  it("offers Commands alone where the field takes no files", () => {
    const { container } = render(() => (
      <Composer pending={[]} onSend={async () => true} onStop={() => {}} onResolve={() => {}} />
    ));
    fireEvent.click(plus(container));
    expect(items(container).map((b) => (b.textContent ?? "").trim())).toEqual(["Commands/"]);
    expect(inputs(container)).toHaveLength(0);
  });

  it("puts a / at the start of an empty message and opens the command menu", async () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.click(row(container, "Commands"));
    expect(field(container).value).toBe("/");
    await waitFor(() => expect(container.querySelector(".tl-complete")).not.toBeNull());
  });

  it("walks the rows with the arrows, wrapping at both ends", () => {
    const { container } = mount();
    plus(container).focus();
    fireEvent.click(plus(container), { detail: 0 });
    const first = row(container, "Photo library");
    expect(document.activeElement, "the keyboard lands on the first row").toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(container, "Camera"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(container, "File"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement, "the rule is skipped").toBe(row(container, "Commands"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(row(container, "Commands"));
  });

  it("closes on Escape and hands the focus back to the +", () => {
    const { container } = mount();
    plus(container).focus();
    fireEvent.click(plus(container), { detail: 0 });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(menu(container)).toBeNull();
    expect(plus(container).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(plus(container));
  });

  it("closes when the reader starts typing instead", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.input(field(container), { target: { value: "n" } });
    expect(menu(container)).toBeNull();
  });

  it("closes on a press anywhere else", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    fireEvent.pointerDown(document.body);
    expect(menu(container)).toBeNull();
  });
});

/**
 * The look, from the prototype's 6-plus: 38px rows at 13.5px on a desktop,
 * 48px at 16px on a phone, 232px and 250px wide at least, radius 14 on the
 * float shadow, opening above the `+`.
 */
describe("the + menu's size", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = (sel: string, from = css) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(from);
    expect(m, `a rule for ${sel}`).not.toBeNull();
    return m![1]!;
  };
  const coarse = () =>
    [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)]
      .map((m) => m[1]!)
      .join("\n");

  it("floats above the + on the float surface", () => {
    const r = rule(".tl-plus-menu");
    expect(r).toMatch(/bottom:\s*calc\(100% \+ 8px\)/);
    expect(r).toMatch(/left:\s*0/);
    expect(r).toMatch(/min-width:\s*232px/);
    // The surface every composer float shares.
    const surface = rule(".tl-plus-menu,\n.tl-strip-pop");
    expect(surface).toMatch(/border-radius:\s*14px/);
    expect(surface).toMatch(/box-shadow:\s*var\(--pop-shadow\)/);
  });

  it("draws 38px rows at 13.5px on a desktop", () => {
    const r = rule(".tl-plus-item");
    expect(r).toMatch(/height:\s*38px/);
    expect(r).toMatch(/font-size:\s*calc\(13\.5px/);
  });

  it("grows to 48px rows at 16px, 250px wide, under a finger", () => {
    expect(rule(".tl-plus-menu", coarse())).toMatch(/min-width:\s*250px/);
    const r = rule(".tl-plus-item", coarse());
    expect(r).toMatch(/height:\s*48px/);
    expect(r).toMatch(/font-size:\s*calc\(16px/);
  });

  it("turns the + a 14% accent tint and a 45 degree turn while open", () => {
    expect(rule('.tl-plus[aria-expanded="true"] .tl-disc')).toMatch(
      /color-mix\(in srgb, var\(--accent\) 14%, transparent\)/,
    );
    expect(rule('.tl-plus[aria-expanded="true"] svg')).toMatch(/rotate\(45deg\)/);
  });

  it("hides a held + by visibility, keeping its room", () => {
    expect(rule(".tl-plus[data-hidden]")).toMatch(/visibility:\s*hidden/);
  });
});
