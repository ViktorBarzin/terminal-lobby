import { createSignal, For, onMount, type Accessor, type Component } from "solid-js";
import { track } from "../telemetry/track";

/**
 * The keyboard-shortcuts help overlay (feature-inventory Cat.2 "Keyboard-
 * shortcuts help overlay"). Ported from the vanilla frontend/index.html
 * `showShortcutsHelp` (index.html:8632-8703). Enumerates every chord with
 * platform-localized Alt/Option labels. Opened by a bare "/" or "?" from the
 * lobby chrome, by Alt+/ from anywhere (the shortcuts.help command), and by the
 * palette's "Keyboard shortcuts" action. The "/"/"?" opener lives in the shell
 * (App), so it works while this overlay is closed.
 */

export interface HelpController {
  isOpen: Accessor<boolean>;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export interface HelpOptions {
  /** hand keyboard focus back to the terminal on every dismiss path. */
  refocus?: () => void;
}

/**
 * Every dismiss path funnels through `close()` — the backdrop click, the shell's
 * Escape handler, the "/" toggle and the palette action — so the focus handback
 * lives there once rather than at four call sites. Closing an already-closed
 * overlay is a no-op and must not steal focus from wherever it is.
 */
export function createHelpController(opts: HelpOptions = {}): HelpController {
  const [isOpen, setOpen] = createSignal(false);
  const open = (): void => {
    track("help.opened");
    setOpen(true);
  };
  const close = (): void => {
    if (!isOpen()) return;
    setOpen(false);
    opts.refocus?.();
  };
  return {
    isOpen,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
  };
}

export type HelpRow = [keys: string[], desc: string];
export type HelpGroup = [label: string, rows: HelpRow[]];

/**
 * The enumerated chord table this overlay paints. Exported so the always-on
 * exemptions can be checked against KB_ALWAYS_BINDINGS: a chord that survives
 * the ⚙ "App shortcuts" toggle has to SAY so here, or the checkbox reads as a
 * master switch it is not.
 */
export function buildShortcutGroups(altLabel: string, isMac: boolean): HelpGroup[] {
  const ALT = altLabel; // "Option" on Mac, else "Alt"
  const MOD = isMac ? "Cmd" : "Ctrl";
  return [
    [
      "Switch sessions",
      [
        [[`${ALT}+1 – ${ALT}+9`], "Jump to session 1–9"],
        [[`${ALT}+0`], "Jump to session 10"],
        [[`${ALT} (hold)`], "Preview session numbers"],
        [[`${ALT}+Shift+[`, `${ALT}+Shift+]`], "Previous / next session"],
        [[`${ALT}+Shift+Enter`], "Next session awaiting input"],
      ],
    ],
    [
      "Manage sessions",
      [
        [[`${ALT}+Shift+N`], "New session"],
        [[`${ALT}+Shift+W`], "Kill current session"],
        [[`${ALT}+Shift+R`], "Rename current session"],
        // ALWAYS ON by design (KB_ALWAYS_BINDINGS): it bypasses the ⚙ toggle so
        // the escape hatch out of a wedged session survives a disabled layer.
        // It still opens the confirm that names the session.
        [
          [`${ALT}+Shift+Backspace`],
          "Kill attached session (works in a session; always on, asks first)",
        ],
      ],
    ],
    [
      "Interface",
      [
        [[`${ALT}+Shift+S`], "Toggle sidebar"],
        [["Ctrl+Shift+K"], "Command palette"],
        // ALWAYS ON by design, on both sides of the iframe boundary and by two
        // separate mechanisms: SessionView registers an unconditional
        // capture-phase window listener that never consults the engine, and
        // term.html carries ctrl+j/meta+j in the terminal page's own
        // KB_ALWAYS_BINDINGS, evaluated ahead of its `enabled` gate.
        [
          [`${MOD}+J`],
          "Toggle text / terminal view (works in a session; always on)",
        ],
        // Bare "/" and "?" are a separate window listener in the shell (App),
        // not a table binding, so they never consult the ⚙ toggle either. Only
        // Alt+/ is part of the toggleable layer.
        [
          ["/", "?", `${ALT}+/`],
          `Show this help (${ALT}+/ works in a session; / and ? always on)`,
        ],
        [["Esc"], "Close menus"],
      ],
    ],
  ];
}

export const ShortcutsHelp: Component<{
  controller: HelpController;
  altLabel: string;
  isMac: boolean;
}> = (props) => {
  const groups = () => buildShortcutGroups(props.altLabel, props.isMac);
  let dialogEl: HTMLDivElement | undefined;

  // Take the keyboard on open, the way the palette does (CommandPalette focuses
  // its input on mount). Without this the overlay inherits whatever had focus,
  // and inside a session that is the terminal IFRAME — so every key went to the
  // pty instead of this dialog: Escape / "/" / "?" could not dismiss it (the
  // shell's window listener never sees a key pressed inside the iframe), Tab
  // walked back into the app, and the keys themselves landed in the running
  // shell (a stray Escape interrupts a Claude turn). Deferred so the node is in
  // the document by the time it runs.
  onMount(() => queueMicrotask(() => dialogEl?.focus()));

  // ...and hold it. palette-controller.runItem() closes the palette — which
  // hands focus back to the terminal — BEFORE running the action that opens
  // this overlay, and TerminalView's handback finishes a frame or two later
  // (term.html's requestTerminalFocus fires on rAF/50ms). So the iframe can
  // pull focus out from under the mount focus above; take it back while open.
  const onFocusOut = (): void => {
    // focusout fires BEFORE the new target is focused, and a dismiss unmounts
    // us — both need the deferral to read the settled state.
    queueMicrotask(() => {
      if (!dialogEl?.isConnected) return;
      if (dialogEl.contains(document.activeElement)) return;
      dialogEl.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" || e.key === "/" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      props.controller.close();
      return;
    }
    // aria-modal="true" promises assistive tech that Tab cannot leave the
    // dialog, and nothing inside it is focusable — so Tab would walk straight
    // out into the app behind (the terminal iframe included) while the overlay
    // is still up. Keep it here; the keys above and the backdrop are the exits.
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      dialogEl?.focus();
    }
  };

  return (
    <div
      class="tl-cmdpalette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.controller.close();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogEl}
        class="tl-schelp"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabindex="-1"
        onFocusOut={onFocusOut}
      >
        <h2 class="tl-schelp-title">Keyboard shortcuts</h2>
        <div class="tl-schelp-scroll">
          <For each={groups()}>
            {([label, rows]) => (
              <>
                <div class="tl-schelp-group-label">{label}</div>
                <For each={rows}>
                  {([keys, desc]) => (
                    <div class="tl-schelp-row">
                      <span class="tl-schelp-keys">
                        <For each={keys}>{(k) => <kbd>{k}</kbd>}</For>
                      </span>
                      <span class="tl-schelp-desc">{desc}</span>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <div class="tl-schelp-note">
          On by default — toggle “App shortcuts” in ⚙ Settings. The rows marked
          “always on” ignore that toggle. Press Esc or / to close.
        </div>
      </div>
    </div>
  );
};
