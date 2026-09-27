/**
 * The mode dial: which permission mode the session is in, in words, coloured
 * by how much it lets through without asking.
 *
 * It was a chip coloured by `data-mode` (Viktor, 2026-08-18: read as a traffic
 * light rather than a label you have to parse), and it still is: the colour is
 * the dial's shield, keyed on the same attribute. What the Quiet line
 * composer (2026-09-24) added is the words, the CLI's own mode titles, and a
 * louder treatment for the two modes where nothing asks first: the dial turns
 * into a hatched danger tab. Since the T3 pass (2026-09-27) the composer's
 * surface takes a danger border too.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const mountFor = (mode: string) =>
  render(() => (
    <Composer
      pending={[]}
      mode={mode}
      onCycleMode={() => {}}
      onPickMode={() => {}}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
const dialFor = (mode: string) =>
  mountFor(mode).container.querySelector<HTMLButtonElement>('.tl-dial[data-dial="mode"]')!;

describe("the mode dial", () => {
  // Every stop of the CLI's own Shift+Tab cycle, plus the pre-rename name and
  // the one that is not in the cycle.
  it("carries the mode as an attribute for the stylesheet to key on", () => {
    for (const mode of [
      "manual",
      "default",
      "plan",
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "dontAsk",
    ]) {
      expect(dialFor(mode).getAttribute("data-mode"), mode).toBe(mode);
    }
  });

  it("says which mode it is and what that means, for anyone hovering", () => {
    const title = dialFor("bypassPermissions").getAttribute("title") ?? "";
    expect(title).toMatch(/^Permission mode: Bypass\. Nothing asks\. Every tool runs\./);
    // And the shortcut that steps it stays in there.
    expect(dialFor("manual").getAttribute("title")).toMatch(/Shift\+Tab/);
  });

  it("shows the CLI's title for the mode, not the raw identifier", () => {
    const value = (mode: string) => dialFor(mode).querySelector(".tl-dial-value")?.textContent;
    expect(value("bypassPermissions")).toBe("Bypass");
    expect(value("acceptEdits")).toBe("Edits");
    expect(value("default")).toBe("Manual");
    expect(value("dontAsk")).toBe("No ask");
  });

  it("marks the modes that ask nothing as danger, on the dial and on the surface", () => {
    for (const mode of ["bypassPermissions", "dontAsk"]) {
      const { container, unmount } = mountFor(mode);
      expect(
        container.querySelector('.tl-dial[data-dial="mode"]')!.hasAttribute("data-danger"),
      ).toBe(true);
      expect(container.querySelector(".tl-pill")!.hasAttribute("data-danger"), mode).toBe(true);
      unmount();
    }
    const { container } = mountFor("auto");
    expect(container.querySelector(".tl-pill")!.hasAttribute("data-danger")).toBe(false);
  });

  // The Quiet line wrote the mode into the placeholder as well. The T3 pass
  // keeps one sentence there, and the danger border is the signal.
  it("leaves the field's placeholder alone", () => {
    const { container } = mountFor("bypassPermissions");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "Ask Claude, or run a command…",
    );
  });

  it("is absent when nothing has read a mode, rather than guessing one", () => {
    const { container } = mountFor("");
    expect(container.querySelector('.tl-dial[data-dial="mode"]')).toBeNull();
  });
});
