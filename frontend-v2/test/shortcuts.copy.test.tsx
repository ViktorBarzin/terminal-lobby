import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show, createSignal } from "solid-js";
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
 * palette declares that contract and the help overlay never had one. It owes
 * the keyboard in the other direction too: opened while the terminal iframe
 * holds focus, every key went to the pty instead of the dialog, so the overlay
 * could only be dismissed with the mouse and a stray Escape interrupted the
 * running turn.
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

/**
 * Opened from inside a session the overlay used to inherit the terminal
 * iframe's focus, which put every subsequent keystroke in the pty: Escape / "/"
 * / "?" could not dismiss it (the shell's window listener never sees a key
 * pressed inside the iframe), Tab walked back into the app behind it, and the
 * keys themselves landed in the running shell. Mounted the way App mounts it —
 * <Show>-gated on the controller.
 */
function openHelp(refocus?: () => void) {
  const help = createHelpController(refocus ? { refocus } : {});
  help.open();
  const utils = render(() => (
    <>
      {/* stands in for the terminal iframe: something outside that can hold
          — and steal back — the keyboard. */}
      <input class="tl-test-steal" />
      <Show when={help.isOpen()}>
        <ShortcutsHelp controller={help} altLabel="Alt" isMac={false} />
      </Show>
    </>
  ));
  return { ...utils, help };
}

/** Wait for the deferred mount focus to land, and hand back the dialog. */
async function helpReady(container: HTMLElement): Promise<HTMLElement> {
  const dialog = container.querySelector(".tl-schelp") as HTMLElement;
  expect(dialog, "the .tl-schelp dialog").toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  return dialog;
}

describe("shortcuts help — the overlay takes the keyboard while it is open", () => {
  it("focuses the dialog on open so keys stop reaching the terminal", async () => {
    const { container } = openHelp();
    const dialog = await helpReady(container);
    expect(dialog.tabIndex).toBe(-1);
  });

  it.each(["Escape", "/", "?"])("dismisses on %s pressed inside the dialog", async (key) => {
    const refocus = vi.fn();
    const { container, help } = openHelp(refocus);
    const dialog = await helpReady(container);

    fireEvent.keyDown(dialog, { key });

    expect(help.isOpen()).toBe(false);
    expect(container.querySelector(".tl-schelp")).toBeNull();
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it("swallows the dismiss key instead of letting it through to the app", async () => {
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", spy);
    try {
      const { container } = openHelp();
      const dialog = await helpReady(container);
      const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      dialog.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });

  it("keeps Tab inside the dialog rather than walking back into the app", async () => {
    const { container, help } = openHelp();
    const dialog = await helpReady(container);
    const steal = container.querySelector(".tl-test-steal") as HTMLInputElement;

    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(help.isOpen()).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(steal);
  });

  it("takes focus back when the terminal handback steals it after open", async () => {
    // palette-controller.runItem() closes (and refocuses the terminal) BEFORE
    // running the action that opens this overlay, and TerminalView's handback
    // lands a frame later — so the iframe can pull focus out from under us.
    const { container } = openHelp();
    const dialog = await helpReady(container);
    const steal = container.querySelector(".tl-test-steal") as HTMLInputElement;

    steal.focus();
    expect(document.activeElement).toBe(steal);

    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it("stops guarding focus once it is dismissed", async () => {
    const { container, help } = openHelp();
    await helpReady(container);
    const steal = container.querySelector(".tl-test-steal") as HTMLInputElement;

    help.close();
    steal.focus();

    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(steal);
  });
});
