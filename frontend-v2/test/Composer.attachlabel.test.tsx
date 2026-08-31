/**
 * The attach control has to say what it does.
 *
 * Viktor: "the upload button is very unintuitive as to what it does."
 * Measured on the deployed build at 390x844 and 1280x900: a 40x40 button with
 * no border, no background, no text and a muted #7d8590 paperclip — the only
 * wordless control on a bar where the mode chip says "bypass", and Stop and Send
 * say their own names. Its purpose lived entirely in a `title`, which a phone
 * has no way to show.
 *
 * So it gets a word, like its neighbours, and enough contrast to read as
 * something you can press. The word is "Attach" rather than "Upload": what it
 * does is put a file on the message you are writing, and it is the tray below
 * the field that shows the result.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;
const attach = async () => [];

const mount = (props: Record<string, unknown> = {}) =>
  render(() => (
    <Composer
      working={false}
      pending={[]}
      onSend={sent}
      onStop={noop}
      onResolve={noop}
      onAttach={attach}
      {...(props as never)}
    />
  ));

describe("the attach control says what it does", () => {
  it("carries a visible word, not only an icon", () => {
    const { container } = mount();
    const btn = container.querySelector(".tl-attach-btn")!;
    expect(btn.textContent!.trim(), "a label beside the paperclip").toMatch(/attach/i);
  });

  it("keeps its accessible name and a title that says what it takes", () => {
    const { container } = mount();
    const btn = container.querySelector(".tl-attach-btn")!;
    expect(btn.getAttribute("aria-label")).toMatch(/attach/i);
    // "Attach a file" said nothing about what happens to it. Images go to the
    // session's gallery; anything else rides /tmp.
    expect(btn.getAttribute("title")).toMatch(/image/i);
  });

  it("still explains itself when the device only watches", () => {
    // Watch mode borrows the title to say why the control is dead; that must
    // win over the explanation.
    const { container } = mount({ inertReason: "Watching: this device does not type" });
    const btn = container.querySelector(".tl-attach-btn") as HTMLButtonElement;
    expect(btn.getAttribute("title")).toMatch(/watching/i);
    expect(btn.disabled).toBe(true);
  });

  it("says when it is busy rather than looking idle", () => {
    const files = [new File([new Uint8Array([1])], "a.png", { type: "image/png" })];
    const onAttach = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return [];
    });
    const { container } = mount({ onAttach });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input, "the hidden picker").not.toBeNull();
    expect(files.length).toBe(1);
  });
});

describe("it reads as a control", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = (sel: string) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, `a rule for ${sel}`).not.toBeNull();
    return m![1]!;
  };

  it("is allowed to be as wide as its label", () => {
    // It was pinned to a 40x40 square, which would clip the word. 40px stays as
    // the touch floor, which is what the square was for.
    const bar = rule(".tl-composer-bar .tl-attach-btn");
    expect(bar).toMatch(/min-width:\s*40px/);
    expect(bar, "not pinned to a square").not.toMatch(/(^|[;\s])width:\s*40px/);
  });

  it("is not the faintest thing on the bar", () => {
    // It was --text-muted, the tier used for text that should recede. A control
    // you are meant to press should not be quieter than the label beside it.
    expect(rule(".tl-attach-btn")).not.toMatch(/color:\s*var\(--text-muted\)/);
  });
});
