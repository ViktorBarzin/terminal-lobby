/**
 * The Engine row on the Terminal page: WHICH terminal this device renders.
 *
 * It is the escape hatch the flip (2026-09-04) rests on, and the only one an
 * installed app has. `manifest.webmanifest` sets `"start_url": "/"`, so a
 * launch from the home-screen icon arrives with no query string and `?native=0`
 * cannot reach it. For a PWA this control is the whole way back to the iframe.
 * So what matters here is not that a strip renders: it is that pressing it
 * writes the key SessionView reads, that it survives a reopen, and that it does
 * not promise to act on the terminal already on screen.
 *
 * Where the halves are checked: `store/device-prefs.ts`'s own behaviour is
 * device-prefs.test.ts, and what SessionView does with the value is
 * SessionView.native.test.tsx. This file is the control.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";
import {
  TERMINAL_RENDERER_KEY,
  setTerminalRenderer,
  terminalRenderer,
} from "../src/store/device-prefs";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

/** The panel, opened straight onto the page that carries this row. */
const panel = () =>
  render(() => (
    <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="terminal" />
  ));

/** The Engine strip's two buttons, in the order they are drawn. */
const engine = (c: HTMLElement): HTMLButtonElement[] => {
  const group = c.querySelector<HTMLElement>('[aria-label="Terminal engine"]');
  expect(group, "the Engine control on the Terminal page").toBeTruthy();
  return [...group!.querySelectorAll<HTMLButtonElement>("button")];
};

const pressed = (c: HTMLElement): (string | null)[] =>
  engine(c).map((b) => (b.getAttribute("aria-pressed") === "true" ? b.textContent : null));

const chosen = (c: HTMLElement): string | undefined =>
  engine(c)
    .find((b) => b.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();

describe("the Engine control", () => {
  it("offers the two terminals by what they are, not by how they are built", () => {
    // "native" and "iframe" name an implementation. A person is choosing
    // between the terminal in this page and the older one in a frame.
    const { container } = panel();
    expect(engine(container).map((b) => b.textContent?.trim())).toEqual([
      "Built in",
      "Classic",
    ]);
  });

  it("shows the default while this device has chosen nothing", () => {
    // Not an empty strip: the control has to say which terminal you are
    // getting, and with nothing stored that is whatever the app defaults to.
    const { container } = panel();
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBeNull();
    expect(chosen(container)).toBe("Built in");
  });

  it("writes the iframe choice where SessionView looks for it", () => {
    const { container } = panel();
    fireEvent.click(engine(container)[1]!); // Classic
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBe("iframe");
    expect(terminalRenderer()).toBe("iframe");
    expect(chosen(container)).toBe("Classic");
  });

  it("writes the choice back rather than deleting the key", () => {
    // The default is native today, so an absent key would LOOK the same. It
    // would stop looking the same the moment the default moved, and this is the
    // setting someone reaches for when a terminal is unusable on their device.
    const { container } = panel();
    fireEvent.click(engine(container)[1]!); // Classic
    fireEvent.click(engine(container)[0]!); // Built in
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBe("native");
    expect(chosen(container)).toBe("Built in");
  });

  it("comes back up on the choice this device made", async () => {
    // A PWA that was parked on the iframe has to still be parked on it after a
    // cold launch, or the way back lasted one session.
    setTerminalRenderer("iframe");
    const first = panel();
    expect(chosen(first.container)).toBe("Classic");
    cleanup();

    const second = panel();
    await waitFor(() => expect(chosen(second.container)).toBe("Classic"));
    expect(pressed(second.container).filter(Boolean)).toHaveLength(1);
  });

  it("says it does not roam", () => {
    // The chip is the row's promise about scope. This one answers a question
    // about the device in front of you, so carrying it to every other device
    // would take the terminal away from all of them at once.
    const { container } = panel();
    const row = engine(container)[0]!.closest(".tl-set-row");
    expect(row?.querySelector(".tl-set-chip")?.textContent).toContain("this device");
  });

  /**
   * The note, and the reason it is a note rather than a hint behind the ⓘ:
   * SessionView reads the setting ONCE per session mount, because swapping the
   * terminal under a live session would tear down a pty someone is typing at.
   * A control that appeared to act at once would be lying about that.
   */
  it("says when it takes effect, in the row rather than behind the ⓘ", () => {
    const { container } = panel();
    const row = engine(container)[0]!.closest(".tl-set-row");
    const note = row?.querySelector(".tl-set-note")?.textContent ?? "";
    expect(note).toContain("next session you open");
    expect(note).toContain("reload");
  });

  it("explains both choices behind the ⓘ", () => {
    const { container } = panel();
    const row = engine(container)[0]!.closest(".tl-set-row") as HTMLElement;
    const info = row.querySelector<HTMLButtonElement>(".tl-set-info");
    expect(info, "the Engine row's ⓘ").toBeTruthy();
    expect(row.querySelector(".tl-set-hint"), "closed until asked").toBeNull();

    fireEvent.click(info!);
    const hint = row.querySelector(".tl-set-hint")?.textContent ?? "";
    expect(hint).toContain("Built in");
    expect(hint).toContain("Classic");
    // The honest part: Classic is not merely older, it still does things the
    // built-in terminal does not.
    expect(hint).toContain("links");
  });
});
