import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  ShortcutsHelp,
  buildShortcutGroups,
  createHelpController,
} from "../src/components/ShortcutsHelp";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";

/**
 * "App shortcuts" is a checkbox that does NOT govern everything its label lists:
 * Alt+Shift+Backspace (kill the attached session, with a confirm) is an
 * always-on binding by design, and the bare "/" help opener is a separate window
 * listener that never consults the gate at all. Turning the layer off and still
 * being able to destroy a session is defensible; saying otherwise is not. These
 * tests hold the copy to what the code actually does.
 *
 * The overlays also owe the terminal its keyboard back when they close — the
 * palette declares that contract and the help overlay never had one.
 */

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return {
    prefs,
    setPref() {},
    setFontSize() {},
    async bootSync() {},
    dispose() {},
  };
}

const helpText = (): string => {
  const { container } = render(() => (
    <ShortcutsHelp controller={createHelpController()} altLabel="Alt" isMac={false} />
  ));
  return container.textContent ?? "";
};

describe("shortcuts help — the always-on exemptions are stated", () => {
  it("marks the kill-attached-session row as always on", () => {
    const rows = buildShortcutGroups("Alt", false).flatMap(([, r]) => r);
    const kill = rows.find(([keys]) => keys.includes("Alt+Shift+Backspace"));
    expect(kill, "an Alt+Shift+Backspace row").toBeDefined();
    expect(kill?.[1].toLowerCase()).toContain("always on");
  });

  it("marks the bare / and ? help opener as always on", () => {
    const rows = buildShortcutGroups("Alt", false).flatMap(([, r]) => r);
    const slash = rows.find(([keys]) => keys.includes("/"));
    expect(slash, "a bare-/ row").toBeDefined();
    expect(slash?.[1].toLowerCase()).toContain("always on");
  });

  it("does not tell the reader the ⚙ toggle governs everything", () => {
    expect(helpText().toLowerCase()).toContain("always on");
  });
});

describe("Settings — the App shortcuts checkbox says what it does not cover", () => {
  it("names the exemptions next to the toggle", () => {
    const { container } = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        keybindings={{ enabled: () => true, setEnabled: () => {}, altLabel: "Alt" }}
      />
    ));
    const group = Array.from(container.querySelectorAll(".tl-settings-group")).find((g) =>
      (g.textContent ?? "").includes("App shortcuts"),
    );
    expect(group, "the Keyboard settings group").toBeTruthy();
    const text = (group?.textContent ?? "").toLowerCase();
    expect(text).toContain("alt+shift+backspace");
    expect(text).toContain("always on");
  });
});

describe("shortcuts help — closing hands the keyboard back", () => {
  it("refocuses on a backdrop-click dismiss", () => {
    const refocus = vi.fn();
    const help = createHelpController({ refocus });
    help.open();
    const { container } = render(() => (
      <ShortcutsHelp controller={help} altLabel="Alt" isMac={false} />
    ));
    const backdrop = container.querySelector(".tl-cmdpalette-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(help.isOpen()).toBe(false);
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it("refocuses on an Escape/command close, and on a toggle that closes", () => {
    const refocus = vi.fn();
    const help = createHelpController({ refocus });
    help.open();
    help.close();
    expect(refocus).toHaveBeenCalledTimes(1);
    help.toggle(); // opens
    expect(help.isOpen()).toBe(true);
    expect(refocus).toHaveBeenCalledTimes(1);
    help.toggle(); // closes
    expect(help.isOpen()).toBe(false);
    expect(refocus).toHaveBeenCalledTimes(2);
  });

  it("does not refocus when it was already closed", () => {
    const refocus = vi.fn();
    const help = createHelpController({ refocus });
    help.close();
    expect(refocus).not.toHaveBeenCalled();
  });
});
