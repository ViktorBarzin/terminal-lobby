import { createSignal, For, onMount, type Accessor, type Component } from "solid-js";
import { track } from "../telemetry/track";
import { dismissOnPress } from "./overlay";

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
        [[`${ALT}+Shift+U`], "Next session with unread output"],
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
        // Nothing to answer first since the kill became undoable — the card
        // dims for eight seconds and Cmd+Z takes it back — so the row no
        // longer promises a question.
        [
          [`${ALT}+Shift+Backspace`],
          `Kill attached session (works in a session; always on, undo with ${MOD}+Z)`,
        ],
      ],
    ],
    [
      "Interface",
      [
        [[`${ALT}+Shift+S`], "Toggle sidebar"],
        [["Ctrl+Shift+K"], "Command palette"],
        // ALWAYS ON by design, and this row named the wrong command until
        // 2026-09-06. It promised the text/terminal view toggle on two
        // mechanisms that are both gone: a SessionView window listener, dropped
        // when the dock reclaimed the chord, and term.html's own
        // KB_ALWAYS_BINDINGS row for ctrl+j/meta+j, deleted with the page on
        // 2026-09-05. `view.toggle` is in neither binding table, and
        // App.tsx's `onDockKey` is the ONLY handler in this tree that matches a
        // J chord, so the chord opens the scratch-shell dock and nothing else.
        //
        // Still always-on: `onDockKey` is a raw window listener that never
        // consults the engine's `enabled` gate. "Desktop only" is its early
        // return on `dock.allowed()`, which is `!coarse()` (store/dock.ts).
        //
        // The view toggle keeps the [Text | Terminal] control, which is what
        // `test/SessionView.viewswitch.test.tsx` pins. It has no chord and
        // there is no row for it in this table on purpose: Viktor settled that
        // on 2026-09-06, and keybindings/bindings.logic.ts carries the
        // reasoning. The palette entry he named as the second way in has not
        // been added, so do not read a missing row here as an oversight.
        [[`${MOD}+J`], "Scratch shell at the foot of the screen (desktop only; always on)"],
        // Find has no Ctrl/Cmd+F row because Ctrl+F belongs to the TUI. This
        // chord is the only keyboard way in, which is why leaving it out of
        // the table hid the feature entirely.
        [[`${ALT}+Shift+F`], "Find in the open session (Text view)"],
        // Bare "/" and "?" are a separate window listener in the shell (App),
        // not a table binding, so they never consult the ⚙ toggle either. Only
        // Alt+/ is part of the toggleable layer.
        [["/", "?", `${ALT}+/`], `Show this help (${ALT}+/ works in a session; / and ? always on)`],
        [["Esc"], "Close menus"],
      ],
    ],
    [
      "Undo",
      [
        // The table binds ctrl+ AND meta+ for each of these, on every platform.
        // A Mac therefore has TWO chords for one command, and the second one
        // costs something a Mac user would not expect: Ctrl+Z stops suspending
        // the foreground job in a session. So the Mac rows name both keys
        // rather than only the one this keyboard would reach for first.
        // Elsewhere Ctrl and the Mod label are the same key, so the row stays a
        // single chip. test/bindings.logic.test.ts checks both spellings are
        // documented ON EACH platform's own table.
        //
        // Not marked "always on", and that is the point rather than an
        // omission: these two are ordinary default rows, so the switch named
        // below turns them off — which is how somebody gets Ctrl+Z back as the
        // shell's suspend key inside a session.
        [
          isMac ? [`${MOD}+Z`, "Ctrl+Z"] : [`${MOD}+Z`],
          "Undo the last change to the sidebar (kill, new, rename, reorder, move, project)",
        ],
        [isMac ? [`${MOD}+Shift+Z`, "Ctrl+Shift+Z"] : [`${MOD}+Shift+Z`], "Redo it"],
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
  // and inside a session that is the terminal — so every key went to the pty
  // instead of this dialog: Escape / "/" / "?" could not dismiss it, Tab walked
  // back into the app, and the keys themselves landed in the running shell (a
  // stray Escape interrupts a Claude turn). When the terminal was an iframe the
  // shell's window listener could not even see those keys, since they were
  // pressed in another document. Deferred so the node is in the document by the
  // time it runs.
  onMount(() => queueMicrotask(() => dialogEl?.focus()));

  // ...and hold it, against anything that takes focus while the overlay is up.
  //
  // The case this was written for has gone. palette-controller.runItem() still
  // closes the palette, which hands focus back to the terminal, BEFORE running
  // the action that opens this overlay. The handback is synchronous now
  // (`__tlFocusTerminal` is `term.focus()`), so it completes before the mount
  // focus above rather than a frame or two after it. TerminalView's handback
  // landed on rAF/50ms (term.html's `requestTerminalFocus`) and could pull
  // focus out from under the mount. Whether any other focus theft still needs
  // this guard has not been established.
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
    // out into the app behind (the terminal included) while the overlay is
    // still up. Keep it here; the keys above and the backdrop are the exits.
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      dialogEl?.focus();
    }
  };

  return (
    <div
      class="tl-cmdpalette-backdrop"
      ref={dismissOnPress(() => props.controller.close(), { surfaceOnly: true })}
    >
      <div
        ref={dialogEl}
        onKeyDown={onKeyDown}
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
          On by default — toggle “App shortcuts” in ⚙ Settings. The rows marked “always on” ignore
          that toggle. Press Esc or / to close.
        </div>
      </div>
    </div>
  );
};
