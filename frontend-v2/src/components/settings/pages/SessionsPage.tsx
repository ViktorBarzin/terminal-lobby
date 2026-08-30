import { For, type Component } from "solid-js";
import { NEW_COMMANDS, type NewCommand, type PrefsStore } from "../../../store/prefs";
import { Group, Row, Toggle } from "../controls";

/** What a new session starts as, and what the sidebar tells you about the ones
 *  you already have. */
export const SessionsPage: Component<{ prefs: PrefsStore }> = (props) => {
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
          <For each={NEW_COMMANDS}>{(c) => <option value={c}>{c}</option>}</For>
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
