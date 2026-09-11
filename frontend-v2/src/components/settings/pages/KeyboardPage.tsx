import { type Accessor, type Component } from "solid-js";
import { Group, Row, Toggle } from "../controls";

export interface KeybindingsControl {
  enabled: Accessor<boolean>;
  setEnabled: (on: boolean) => void;
  /** Platform label for the Alt/Option modifier, so the note names the key the
   *  reader actually has. */
  altLabel?: string;
}

/**
 * The shortcut layer's opt-out.
 *
 * The hint names the four chords that outlive the switch, because the label
 * used to imply the switch governed everything: the always-on kill chord
 * (KB_ALWAYS_BINDINGS), the bare "/" and "?" help openers, which are a shell
 * window listener rather than a table binding, and Ctrl/Cmd+J.
 *
 * Ctrl/Cmd+J is the scratch-shell dock, not the view toggle this hint named
 * until 2026-09-06. It read "which SessionView and term.html each register
 * outside the gate": term.html went on 2026-09-05, and no SessionView listener
 * registers it either. App.tsx's `onDockKey` is the only handler in the tree
 * that matches a J chord, it never reads the `enabled` gate, and it returns
 * early on a coarse pointer, which is where "on a desktop" comes from.
 * ShortcutsHelp carries the same correction and the longer note.
 */
export const KeyboardPage: Component<{ keybindings: KeybindingsControl }> = (props) => {
  const alt = () => props.keybindings.altLabel ?? "Alt";
  // App passes altLabel only, and it is "Option" exactly on Mac
  // (bindings.logic.ts altLabel), so the Ctrl/Cmd label follows from it.
  const ctrl = () => (props.keybindings.altLabel === "Option" ? "Cmd" : "Ctrl");

  return (
    <Group>
      <Row
        label="App shortcuts"
        deviceOnly
        hint={
          <>
            Press <kbd>/</kbd> for the full list. Off sends these keys to the terminal instead,{" "}
            <kbd>Ctrl+Z</kbd> included, which is how a shell gets its suspend key back. Four chords
            stay on either way: <kbd>/</kbd> and <kbd>?</kbd> (that list),{" "}
            <kbd>{alt()}+Shift+Backspace</kbd> (kill the attached session; the card dims for eight
            seconds and <kbd>{ctrl()}+Z</kbd> takes it back) and <kbd>{ctrl()}+J</kbd> (the scratch
            shell, on a desktop).
          </>
        }
      >
        <Toggle
          label="App shortcuts"
          checked={props.keybindings.enabled()}
          onChange={(on) => props.keybindings.setEnabled(on)}
        />
      </Row>
    </Group>
  );
};
