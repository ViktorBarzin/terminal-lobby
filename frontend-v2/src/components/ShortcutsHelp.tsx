import { createSignal, For, type Accessor, type Component } from "solid-js";

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

export function createHelpController(): HelpController {
  const [isOpen, setOpen] = createSignal(false);
  return {
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen((v) => !v),
  };
}

type HelpRow = [keys: string[], desc: string];
type HelpGroup = [label: string, rows: HelpRow[]];

function buildGroups(altLabel: string, isMac: boolean): HelpGroup[] {
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
        [[`${ALT}+Shift+Backspace`], "Kill attached session (works in a session)"],
      ],
    ],
    [
      "Interface",
      [
        [[`${ALT}+Shift+S`], "Toggle sidebar"],
        [["Ctrl+Shift+K"], "Command palette"],
        [[`${MOD}+J`], "Toggle text / terminal view"],
        [["/", "?", `${ALT}+/`], `Show this help (${ALT}+/ works in a session)`],
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
  const groups = () => buildGroups(props.altLabel, props.isMac);
  return (
    <div
      class="tl-cmdpalette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.controller.close();
      }}
    >
      <div class="tl-schelp" role="dialog" aria-label="Keyboard shortcuts">
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
          On by default — toggle “App shortcuts” in ⚙ Settings. Press Esc or / to close.
        </div>
      </div>
    </div>
  );
};
