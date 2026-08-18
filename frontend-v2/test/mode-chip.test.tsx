/**
 * The permission chip is coloured by how much the session will do without
 * asking (Viktor, 2026-08-18) — read as a traffic light rather than a label you
 * have to parse. The colour comes from `data-mode` in CSS, so what this pins is
 * that the attribute carries the CLI's own identifier for every mode.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const chipFor = (mode: string) => {
  const { container } = render(() => (
    <Composer
      working={false}
      pending={[]}
      mode={mode}
      onCycleMode={() => {}}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  return container.querySelector<HTMLButtonElement>(".tl-mode-chip")!;
};

describe("the permission chip's colour", () => {
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
      expect(chipFor(mode).getAttribute("data-mode"), mode).toBe(mode);
    }
  });

  it("still says which mode it is in words, for anyone hovering", () => {
    expect(chipFor("bypassPermissions").getAttribute("title")).toMatch(/bypass/);
    expect(chipFor("plan").getAttribute("title")).toMatch(/plan/);
    // And the shortcut that changes it stays in there.
    expect(chipFor("manual").getAttribute("title")).toMatch(/Shift\+Tab/);
  });

  it("renders the short label, not the raw identifier", () => {
    expect(chipFor("bypassPermissions").textContent).toBe("bypass");
    expect(chipFor("acceptEdits").textContent).toBe("edits");
    expect(chipFor("default").textContent).toBe("manual");
  });
});
