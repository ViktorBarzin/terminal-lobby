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
 * Alt+Shift+Backspace (kill the attached session) is an always-on binding by
 * design, and the bare "/" help opener is a separate window listener that never
 * consults the gate at all. Turning the layer off and still being able to
 * destroy a session is defensible; saying otherwise is not. These tests hold the
 * copy to what the code actually does.
 *
 * The kill row said "asks first" until 2026-09-10, when the confirm gave way to
 * an eight-second grace window (store/lobby.ts GRACE_MS). Note what the layer
 * being off then costs: the undo chords are ordinary KB_DEFAULT_BINDINGS, so
 * Ctrl+Z goes back to the terminal with the switch, while this always-on chord
 * keeps killing. The card's own undo arrow is what is left to press.
 *
 * Ctrl/Cmd+J is a third exemption, and the one the copy used to miss. It is the
 * scratch-shell dock: App.tsx's `onDockKey` is a raw window listener that never
 * reads the gate, so the chord fires with the layer off wherever the focus is,
 * on a fine pointer. The copy called it the view toggle until 2026-09-06, on
 * two mechanisms that are gone: a SessionView listener, dropped when the dock
 * reclaimed the chord, and term.html's own KB_ALWAYS_BINDINGS row, deleted with
 * the page on 2026-09-05.
 *
 * The overlays also owe the terminal its keyboard back when they close — the
 * palette declares that contract and the help overlay never had one. It owes
 * the keyboard in the other direction too: opened while the terminal held
 * focus, every key went to the pty instead of the dialog, so the overlay
 * could only be dismissed with the mouse and a stray Escape interrupted the
 * running turn.
 */

/**
 * Every chord that survives the ⚙ "App shortcuts" opt-out, measured against the
 * running build with the layer off: "/" and "?" open this help,
 * Alt+Shift+Backspace kills the attached session, Ctrl+J opens the scratch-shell
 * dock. Each one has to carry the marker in the table, and nothing else may.
 */
const ALWAYS_ON_CHORDS = ["/", "?", "Alt+Shift+Backspace", "Ctrl+J"];

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

  it("marks the scratch-shell dock row as always on", () => {
    const rows = buildShortcutGroups("Alt", false).flatMap(([, r]) => r);
    const dock = rows.find(([keys]) => keys.includes("Ctrl+J"));
    expect(dock, "a Ctrl+J row").toBeDefined();
    expect(dock?.[1].toLowerCase()).toContain("always on");
    // ...and says what the chord does. It named the view toggle until
    // 2026-09-06, which no listener in the tree has performed since the dock
    // reclaimed the chord.
    expect(dock?.[1].toLowerCase()).toContain("shell");
    expect(dock?.[1].toLowerCase()).not.toContain("terminal view");
  });

  it("marks EXACTLY the rows that survive the toggle — no more, no fewer", () => {
    for (const [keys, desc] of buildShortcutGroups("Alt", false).flatMap(([, r]) => r)) {
      const survives = keys.some((k) => ALWAYS_ON_CHORDS.includes(k));
      expect(
        desc.toLowerCase().includes("always on"),
        `${keys.join(" ")} → "${desc}" ${
          survives
            ? "survives the ⚙ toggle but carries no always-on marker"
            : "is marked always-on, but the ⚙ toggle does kill it"
        }`,
      ).toBe(survives);
    }
  });

  it("does not tell the reader the ⚙ toggle governs everything", () => {
    expect(helpText().toLowerCase()).toContain("always on");
  });
});

describe("Settings — the App shortcuts checkbox says what it does not cover", () => {
  /**
   * The exemptions are an EXPLANATION rather than a consequence, so they live
   * behind the row's ⓘ. Each case opens it, which is what a reader wondering
   * "does this switch cover everything?" does.
   */
  const keyboardGroupText = (altLabel: string): string => {
    const r = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        initialPage="keyboard"
        keybindings={{ enabled: () => true, setEnabled: () => {}, altLabel }}
      />
    ));
    fireEvent.click(r.getByLabelText("Explain App shortcuts"));
    const group = Array.from(r.container.querySelectorAll(".tl-set-group")).find((g) =>
      (g.textContent ?? "").includes("App shortcuts"),
    );
    expect(group, "the Keyboard settings page").toBeTruthy();
    return (group?.textContent ?? "").toLowerCase();
  };

  it("names the exemptions next to the toggle", () => {
    const text = keyboardGroupText("Alt");
    expect(text).toContain("alt+shift+backspace");
    expect(text).toContain("stay on either way");
  });

  it("names Ctrl+J too, and names it as the scratch shell", () => {
    const text = keyboardGroupText("Alt");
    expect(text).toContain("ctrl+j");
    expect(text).toContain("scratch shell");
    expect(text).not.toContain("terminal view");
  });

  it("localizes the Ctrl+J exemption to Cmd on a Mac", () => {
    expect(keyboardGroupText("Option")).toContain("cmd+j");
  });

  /**
   * The kill chord asked `Kill session "x"?` until the grace window replaced
   * the confirm (store/lobby.ts kill). ShortcutsHelp and docs/interface.md were
   * corrected with it; this second copy of the same sentence was not, and
   * nothing here read it, so the settings page went on promising a question
   * that no longer appears.
   */
  it("does not promise a confirm the kill chord no longer shows", () => {
    const text = keyboardGroupText("Alt");
    expect(text).not.toContain("asks first");
    expect(text).toContain("eight seconds");
    expect(text).toContain("ctrl+z");
  });

  it("says the switch is what hands Ctrl+Z back to the shell", () => {
    // The one cost of the undo chords: with the layer on, Ctrl+Z no longer
    // suspends a foreground job. The switch is the way back, so it says so.
    expect(keyboardGroupText("Alt")).toContain("suspend");
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
      {/* stands in for the terminal: something outside the dialog that can
          hold — and steal back — the keyboard. */}
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
    // running the action that opens this overlay. TerminalView's handback landed
    // a frame later, so it could pull focus out from under us;
    // `__tlFocusTerminal` is synchronous now and that particular race is gone.
    // The steal below is simulated, so what this pins is the guard's behaviour
    // against any late steal rather than that one cause.
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
