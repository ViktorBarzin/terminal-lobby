/**
 * The attach control has to say what it does.
 *
 * HISTORY. Viktor: "the upload button is very unintuitive as to what it does."
 * Measured on the deployed build at 390x844 and 1280x900: a 40x40 button with
 * no border, no background, no text and a muted #7d8590 paperclip, the only
 * wordless control on a bar where the mode chip said "bypass" and Stop and
 * Send said their own names. Its purpose lived entirely in a `title`, which a
 * phone has no way to show. So it got a word, "Attach", and these tests pinned
 * the word on the button.
 *
 * The Quiet line composer (2026-09-24) moved Attach behind the pill's `+`,
 * beside the photo picker and the `/` and `@` menus, and rewrote these on
 * purpose: one word cannot name four intakes. The words moved into the rows
 * the `+` opens, and the `+` keeps an accessible name and a title that say
 * what it opens and where an image goes. The complaint the word fixed still
 * holds; the place that answers it changed.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;
const attach = async () => [];

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
  render(() => (
    <Composer
      pending={[]}
      onSend={sent}
      onStop={noop}
      onResolve={noop}
      onAttach={attach}
      onListDir={async () => []}
      {...props}
    />
  ));

const plus = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-plus")!;
const rows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".tl-tray-item")).map((r) =>
    (r.querySelector("span")?.textContent ?? "").trim(),
  );

describe("the + says what it opens", () => {
  it("opens rows that say what each one takes, in words", () => {
    const { container } = mount();
    fireEvent.click(plus(container));
    expect(rows(container)).toEqual([
      "Attach a file",
      "Add a photo",
      "Commands and skills",
      "A file path",
    ]);
  });

  it("keeps an accessible name, and a title that says where an image goes", () => {
    const { container } = mount();
    expect(plus(container).getAttribute("aria-label")).toBe(
      "Add a file, a photo, a command or a path",
    );
    // "Attach a file" said nothing about what happens to it. Images go to the
    // session's gallery; anything else rides /tmp.
    expect(plus(container).getAttribute("title")).toMatch(/gallery/i);
  });

  it("still explains itself when the device only watches, and opens nothing", () => {
    // Watch mode borrows the title to say why the control is dead; that must
    // win over the explanation.
    const { container } = mount({ inertReason: "Watching: this device does not type" });
    const btn = plus(container);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toMatch(/watching/i);
    fireEvent.click(btn);
    expect(container.querySelector(".tl-tray")).toBeNull();
  });

  it("says when it is busy rather than looking idle", async () => {
    let release: () => void = noop;
    const onAttach = vi.fn(
      () =>
        new Promise<[]>((r) => {
          release = () => r([]);
        }),
    );
    const { container } = mount({ onAttach });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => expect(plus(container).getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(plus(container));
    expect(rows(container)[0]).toBe("Attaching…");
    release();
    await waitFor(() => expect(plus(container).getAttribute("aria-busy")).toBeNull());
  });
});

describe("the + is a finger target", () => {
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

  // A 36px box round the 32px disc on a desktop (the T3 pass's box row).
  it("is a 36px circle round a 32px disc", () => {
    const r = rule(".tl-plus,\n.tl-send");
    expect(r).toMatch(/width:\s*36px/);
    expect(r).toMatch(/height:\s*36px/);
    expect(rule(".tl-disc")).toMatch(/width:\s*32px/);
  });

  it("grows to the 44px touch target under a coarse pointer", () => {
    // Each coarse-pointer block runs to the next closing brace at column 0.
    const blocks = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)];
    const found = blocks.some((m) =>
      /\.tl-plus,\s*\.tl-send\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(m[1]!),
    );
    expect(found, "a coarse-pointer rule sizing + and Send at 44px").toBe(true);
  });
});
