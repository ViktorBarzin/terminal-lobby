import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show, createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";

/**
 * The panel's own doc comment promises "focus returns to the opener", and the
 * dialog declares aria-modal="true" — which promises assistive tech that Tab
 * cannot leave it. Both are behaviour, so both get tested here.
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

/** Mount a gear button + the <Show>-gated panel, exactly as App.tsx wires it. */
function openPanel() {
  const [isOpen, setOpen] = createSignal(false);
  const utils = render(() => (
    <>
      <button
        type="button"
        class="tl-icon-btn tl-settings-btn"
        aria-label="Settings"
        onClick={() => setOpen(true)}
      >
        ⚙
      </button>
      <Show when={isOpen()}>
        <SettingsPanel prefs={fakePrefs()} onClose={() => setOpen(false)} />
      </Show>
    </>
  ));
  const gear = utils.getByLabelText("Settings") as HTMLButtonElement;
  // jsdom does not focus a clicked button; a real browser does, and the opener
  // holding focus at open time is the precondition the contract is about.
  gear.focus();
  fireEvent.click(gear);
  return { ...utils, gear };
}

/** Wait for the panel to be mounted and for its deferred initial focus to land. */
async function panelReady(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(container.querySelector(".tl-settings")).not.toBeNull(),
  );
  const dialog = container.querySelector(".tl-settings") as HTMLElement;
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return dialog;
}

describe("<SettingsPanel> focus management", () => {
  it("takes focus into the dialog when it opens", async () => {
    const { container, gear } = openPanel();
    const dialog = await panelReady(container);

    expect(document.activeElement).not.toBe(gear);
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("returns focus to the opener when closed with the ✕", async () => {
    const { container, gear, getByLabelText } = openPanel();
    await panelReady(container);

    const close = getByLabelText("Close settings") as HTMLButtonElement;
    close.focus(); // what a real click does before the handler runs
    fireEvent.click(close);

    await waitFor(() => expect(container.querySelector(".tl-settings")).toBeNull());
    expect(document.activeElement).toBe(gear);
  });

  it("returns focus to the opener when closed by a backdrop click", async () => {
    const { container, gear } = openPanel();
    await panelReady(container);

    const backdrop = container.querySelector(".tl-settings-backdrop") as HTMLElement;
    (document.activeElement as HTMLElement | null)?.blur(); // a backdrop click blurs to <body>
    fireEvent.click(backdrop);

    await waitFor(() => expect(container.querySelector(".tl-settings")).toBeNull());
    expect(document.activeElement).toBe(gear);
  });

  it("returns focus to the opener when closed with Escape", async () => {
    const { container, gear } = openPanel();
    await panelReady(container);

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });

    await waitFor(() => expect(container.querySelector(".tl-settings")).toBeNull());
    expect(document.activeElement).toBe(gear);
  });

  it("traps Tab inside the dialog instead of letting it escape to the app behind", async () => {
    const { container, getByLabelText } = openPanel();
    await panelReady(container);

    // With no keybindings/notifications props the tabbable run is: ✕ … theme
    // swatches … A− A+ … the new-command <select> … the two notify checkboxes.
    const close = getByLabelText("Close settings") as HTMLButtonElement;
    const last = getByLabelText("When a session needs input") as HTMLInputElement;

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
