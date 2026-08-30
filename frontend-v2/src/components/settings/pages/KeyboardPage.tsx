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
 * (KB_ALWAYS_BINDINGS), the bare "/" and "?" help openers — a shell window
 * listener rather than a table binding — and the view toggle, which SessionView
 * and term.html each register outside the gate.
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
            Press <kbd>/</kbd> for the full list. Off sends these keys to the
            terminal instead. Four chords stay on either way: <kbd>/</kbd> and{" "}
            <kbd>?</kbd> (that list), <kbd>{alt()}+Shift+Backspace</kbd> (kill the
            attached session, asks first) and <kbd>{ctrl()}+J</kbd> (toggle text /
            terminal view).
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
