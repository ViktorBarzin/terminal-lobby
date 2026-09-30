import type { Component } from "solid-js";
import type { PrefsStore } from "../../../store/prefs";
import { Group, Row, Toggle } from "../controls";

/** What the sidebar tells you about the sessions you already have.
 *
 *  There is no default command to choose here: every new session starts on
 *  Claude, and another command picked in the composer lasts that one session
 *  (store/prefs.ts, oneSessionCleared; Viktor, 2026-09-30). */
export const SessionsPage: Component<{ prefs: PrefsStore }> = (props) => {
  const p = () => props.prefs.prefs();

  return (
    <Group>
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
