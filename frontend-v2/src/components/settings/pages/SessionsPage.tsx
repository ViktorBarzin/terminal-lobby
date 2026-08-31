import { For, type Component } from "solid-js";
import { NEW_COMMANDS, type NewCommand, type PrefsStore } from "../../../store/prefs";
import { canRun, COMMAND_LABELS, type CommandAvailability } from "../../../lib/new-commands";
import { Group, Row, Toggle } from "../controls";

/** What a new session starts as, and what the sidebar tells you about the ones
 *  you already have.
 *
 *  `availableCommands` is the same answer the sidebar's create row uses. Both
 *  write this one pref, so offering a command here that the row greys out would
 *  only move the dead option somewhere less visible. */
export const SessionsPage: Component<{
  prefs: PrefsStore;
  availableCommands?: () => CommandAvailability;
}> = (props) => {
  const avail = (): CommandAvailability => props.availableCommands?.() ?? {};
  const p = () => props.prefs.prefs();

  return (
    <Group>
      <Row
        label="New session runs"
        labelFor="tl-set-newcmd"
        hint="Applies to newly created sessions only. Sessions already running keep whatever they were started with."
      >
        <select
          id="tl-set-newcmd"
          class="tl-set-select"
          value={p().session.newCommand}
          onChange={(e) =>
            props.prefs.setPref({
              session: { newCommand: e.currentTarget.value as NewCommand },
            })
          }
        >
          <For each={NEW_COMMANDS}>
            {(c) => (
              <option value={c} disabled={!canRun(c, avail())}>
                {COMMAND_LABELS[c]}
                {canRun(c, avail()) ? "" : " (not installed)"}
              </option>
            )}
          </For>
        </select>
      </Row>

      <Row
        label="Show when each session was last driven"
        hint="The last time someone was attached to it and able to type — watching a session does not move this. A running session shows its live timer instead, which counts the turn in flight."
      >
        <Toggle
          label="Show when each session was last driven"
          checked={p().sidebar.showLastActive}
          onChange={(on) => props.prefs.setPref({ sidebar: { showLastActive: on } })}
        />
      </Row>
    </Group>
  );
};
